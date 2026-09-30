'use strict';

const db = require('../db/database');
const { fetchManagedDevices } = require('../lib/fortigateClient');

function getMonitorWorker() {
  try {
    return require('./monitorWorker');
  } catch {
    return null;
  }
}

function getSetting(key, fallback) {
  return db.prepare('SELECT value FROM settings WHERE key = ?').get(key)?.value ?? fallback;
}

/** Upserts discovered devices into `table` (switches | access_points) for
 * one router. Matches existing rows by discovered_serial. Devices from a
 * previous sync that are no longer reported get discovered_missing_at set
 * (shown as offline) rather than deleted. */
function upsertDiscovered(table, routerId, devices) {
  const now = new Date().toISOString().replace('T', ' ').substring(0, 19);
  const existing = db.prepare(`SELECT id, discovered_serial, monitor_id, ip_address FROM ${table} WHERE discovered_from_router_id = ?`).all(routerId);
  const existingBySerial = new Map(existing.map((r) => [r.discovered_serial, r]));
  const seenSerials = new Set();
  const worker = getMonitorWorker();

  const insert = db.prepare(
    `INSERT INTO ${table} (name, brand, model, ip_address, discovered_from_router_id, discovered_serial, last_seen_at, monitor_id) VALUES (?,?,?,?,?,?,?,?)`
  );
  const update = db.prepare(
    `UPDATE ${table} SET name=?, model=?, ip_address=?, last_seen_at=?, discovered_missing_at=NULL WHERE id=?`
  );

  for (const dev of devices) {
    if (!dev.serial) continue;
    seenSerials.add(dev.serial);
    const existingRow = existingBySerial.get(dev.serial);
    if (existingRow) {
      update.run(dev.name, dev.model, dev.ip_address, now, existingRow.id);
      // Keep the ping target in sync if the device's IP changed since the last sync.
      if (existingRow.monitor_id && dev.ip_address && dev.ip_address !== existingRow.ip_address) {
        db.prepare('UPDATE monitors SET target = ? WHERE id = ?').run(dev.ip_address, existingRow.monitor_id);
      }
    } else {
      // New device — back it with an ICMP monitor, same as a manually-added
      // one, so it's actually pinged rather than sitting at "unknown" forever.
      let monitorId = null;
      if (dev.ip_address) {
        const monitorResult = db.prepare(`INSERT INTO monitors (label, type, target, interval_s) VALUES (?, 'icmp', ?, 60)`).run(dev.name, dev.ip_address);
        monitorId = monitorResult.lastInsertRowid;
        worker?.registerMonitor(db.prepare('SELECT * FROM monitors WHERE id = ?').get(monitorId));
      }
      insert.run(dev.name, 'fortigate', dev.model, dev.ip_address || '0.0.0.0', routerId, dev.serial, now, monitorId);
    }
  }

  const markMissing = db.prepare(`UPDATE ${table} SET discovered_missing_at = ? WHERE discovered_from_router_id = ? AND discovered_serial = ? AND discovered_missing_at IS NULL`);
  for (const row of existing) {
    if (row.discovered_serial && !seenSerials.has(row.discovered_serial)) {
      markMissing.run(now, routerId, row.discovered_serial);
    }
  }
}

async function syncRouter(routerId) {
  const router = db.prepare('SELECT * FROM routers WHERE id = ?').get(routerId);
  if (!router) throw new Error('Router not found');
  if (router.brand !== 'fortigate') throw new Error('Only FortiGate (brand: fortigate) routers support sync');

  const { switches, accessPoints, errors } = await fetchManagedDevices(router);
  upsertDiscovered('switches', routerId, switches);
  upsertDiscovered('access_points', routerId, accessPoints);

  const parts = [];
  parts.push(errors.switches ? `switches: ${errors.switches}` : `${switches.length} switches`);
  parts.push(errors.accessPoints ? `access points: ${errors.accessPoints}` : `${accessPoints.length} access points`);
  const status = (errors.switches ? 'error' : 'ok') === 'ok' && (errors.accessPoints ? 'error' : 'ok') === 'ok' ? 'ok' : (errors.switches && errors.accessPoints ? 'error' : 'partial');

  db.prepare("UPDATE routers SET last_sync_at = datetime('now'), last_sync_status = ? WHERE id = ?").run(`${status}: ${parts.join(', ')}`, routerId);

  if (errors.switches && errors.accessPoints) {
    throw new Error(`Both endpoints failed — ${parts.join('; ')}`);
  }
  return { switches: switches.length, accessPoints: accessPoints.length, errors };
}

async function syncAllFortiGates() {
  const routers = db.prepare("SELECT id FROM routers WHERE brand = 'fortigate' AND api_token IS NOT NULL AND api_token != ''").all();
  await Promise.allSettled(routers.map((r) => syncRouter(r.id).catch((err) => console.error(`[FortiGate sync] router ${r.id} failed:`, err.message))));
}

let cronTask = null;
function reschedule(cronExpr) {
  const cron = require('node-cron');
  if (cronTask) {
    cronTask.stop();
    cronTask = null;
  }
  if (!cronExpr || !cron.validate(cronExpr)) {
    console.error(`[FortiGateSync] Invalid cron expression "${cronExpr}" — scheduler disabled`);
    return false;
  }
  cronTask = cron.schedule(cronExpr, () => {
    syncAllFortiGates().catch((err) => console.error('[FortiGateSync] Sync failed:', err.message));
  });
  return true;
}

function initScheduler() {
  reschedule(getSetting('fortigate_sync_cron', '*/20 * * * *'));
}

module.exports = { syncRouter, syncAllFortiGates, reschedule, initScheduler };
