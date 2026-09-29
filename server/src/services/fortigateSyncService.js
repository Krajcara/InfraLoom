'use strict';

const db = require('../db/database');
const { fetchManagedDevices } = require('../lib/fortigateClient');

function getSetting(key, fallback) {
  return db.prepare('SELECT value FROM settings WHERE key = ?').get(key)?.value ?? fallback;
}

/** Upserts discovered devices into `table` (switches | access_points) for
 * one router. Matches existing rows by discovered_serial. Devices from a
 * previous sync that are no longer reported get discovered_missing_at set
 * (shown as offline) rather than deleted. */
function upsertDiscovered(table, routerId, devices) {
  const now = new Date().toISOString().replace('T', ' ').substring(0, 19);
  const existing = db.prepare(`SELECT id, discovered_serial FROM ${table} WHERE discovered_from_router_id = ?`).all(routerId);
  const existingBySerial = new Map(existing.map((r) => [r.discovered_serial, r.id]));
  const seenSerials = new Set();

  const insert = db.prepare(
    `INSERT INTO ${table} (name, brand, model, ip_address, discovered_from_router_id, discovered_serial, last_seen_at) VALUES (?,?,?,?,?,?,?)`
  );
  const update = db.prepare(
    `UPDATE ${table} SET name=?, model=?, ip_address=?, last_seen_at=?, discovered_missing_at=NULL WHERE id=?`
  );

  for (const dev of devices) {
    if (!dev.serial) continue;
    seenSerials.add(dev.serial);
    const existingId = existingBySerial.get(dev.serial);
    if (existingId) {
      update.run(dev.name, dev.model, dev.ip_address, now, existingId);
    } else {
      insert.run(dev.name, 'fortigate', dev.model, dev.ip_address || '0.0.0.0', routerId, dev.serial, now);
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

  try {
    const { switches, accessPoints } = await fetchManagedDevices(router);
    upsertDiscovered('switches', routerId, switches);
    upsertDiscovered('access_points', routerId, accessPoints);
    db.prepare("UPDATE routers SET last_sync_at = datetime('now'), last_sync_status = ? WHERE id = ?").run(
      `ok: ${switches.length} switches, ${accessPoints.length} access points`,
      routerId
    );
    return { switches: switches.length, accessPoints: accessPoints.length };
  } catch (err) {
    db.prepare("UPDATE routers SET last_sync_at = datetime('now'), last_sync_status = ? WHERE id = ?").run(`error: ${err.message}`, routerId);
    throw err;
  }
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
