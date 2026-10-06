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
 * one router. Matches existing rows by discovered_serial.
 *
 * Status of these devices comes from the FortiGate itself (what it reports
 * for each FortiLink switch / managed AP), NOT from an ICMP monitor on the
 * InfraLoom server — managed switches are usually not reachable from here,
 * and a ping would just show them as "down". So no ICMP monitor is created
 * for them, and any left over from older versions is removed.
 *
 * Devices that disappear from the controller's list are marked
 * discovered_missing_at and shown as down rather than deleted. Returns the
 * list of status transitions (up<->down) so the caller can notify. */
function upsertDiscovered(table, routerId, devices) {
  const now = new Date().toISOString().replace('T', ' ').substring(0, 19);
  const existing = db.prepare(`SELECT id, name, discovered_serial, monitor_id, controller_status FROM ${table} WHERE discovered_from_router_id = ?`).all(routerId);
  const existingBySerial = new Map(existing.map((r) => [r.discovered_serial, r]));
  const seenSerials = new Set();
  const worker = getMonitorWorker();
  const transitions = [];

  const insert = db.prepare(
    `INSERT INTO ${table} (name, brand, model, ip_address, discovered_from_router_id, discovered_serial, last_seen_at, controller_status, controller_checked_at) VALUES (?,?,?,?,?,?,?,?,?)`
  );
  // COALESCE: a sync that can't report an IP/model/status (e.g. FortiLink's
  // link-local address was filtered out) must not blank out what's known —
  // including an IP the admin entered by hand.
  const update = db.prepare(
    `UPDATE ${table} SET name=?, model=COALESCE(?, model), ip_address=COALESCE(?, ip_address), last_seen_at=?, discovered_missing_at=NULL,
       controller_status=COALESCE(?, controller_status), controller_checked_at=? WHERE id=?`
  );

  const targetType = table === 'switches' ? 'switch' : 'access_point';
  const noteTransition = (name, prev, next, id) => {
    if (prev && next && prev !== next) transitions.push({ name, status: next, id, type: targetType });
  };

  for (const dev of devices) {
    if (!dev.serial) continue;
    seenSerials.add(dev.serial);
    const existingRow = existingBySerial.get(dev.serial);
    if (existingRow) {
      update.run(dev.name, dev.model, dev.ip_address, now, dev.status, now, existingRow.id);
      noteTransition(dev.name, existingRow.controller_status, dev.status, existingRow.id);
    } else {
      insert.run(dev.name, 'fortigate', dev.model, dev.ip_address || '0.0.0.0', routerId, dev.serial, now, dev.status, now);
    }
  }

  const markMissing = db.prepare(`UPDATE ${table} SET discovered_missing_at = ?, controller_status = 'down', controller_checked_at = ? WHERE id = ? AND discovered_missing_at IS NULL`);
  for (const row of existing) {
    if (row.discovered_serial && !seenSerials.has(row.discovered_serial)) {
      markMissing.run(now, now, row.id);
      noteTransition(row.name, row.controller_status, 'down', row.id);
    }
  }

  // Drop ICMP monitors that older versions created for these devices.
  for (const row of existing) {
    if (row.monitor_id) {
      worker?.unregisterMonitor(row.monitor_id);
      db.prepare('DELETE FROM monitors WHERE id = ?').run(row.monitor_id);
      db.prepare(`UPDATE ${table} SET monitor_id = NULL WHERE id = ?`).run(row.id);
    }
  }
  return transitions;
}

function notifyTransitions(kindLabel, transitions) {
  if (!transitions.length) return;
  let notify;
  try {
    ({ notify } = require('./notificationService'));
  } catch {
    return;
  }
  for (const t of transitions) {
    const down = t.status === 'down';
    Promise.resolve(notify(`${kindLabel} "${t.name}" ${down ? 'went offline' : 'is back online'} (reported by FortiGate)`, down ? 'monitor_down' : 'monitor_up', { type: t.type, id: t.id })).catch(() => {});
  }
}

const inFlight = new Set();

async function syncRouter(routerId) {
  const router = db.prepare('SELECT * FROM routers WHERE id = ?').get(routerId);
  if (!router) throw new Error('Router not found');
  if (router.brand !== 'fortigate') throw new Error('Only FortiGate (brand: fortigate) routers support sync');

  if (inFlight.has(routerId)) return { skipped: true, switches: 0, accessPoints: 0, errors: {} }; // previous sync still running
  inFlight.add(routerId);
  try {
    return await runSync(router, routerId);
  } finally {
    inFlight.delete(routerId);
  }
}

async function runSync(router, routerId) {
  const { switches, accessPoints, errors, debug } = await fetchManagedDevices(router);
  // A list that failed to load must not be treated as "everything vanished" —
  // only reconcile lists we actually received.
  const swTransitions = errors.switches ? [] : upsertDiscovered('switches', routerId, switches);
  const apTransitions = errors.accessPoints ? [] : upsertDiscovered('access_points', routerId, accessPoints);
  notifyTransitions('Switch', swTransitions);
  notifyTransitions('Access point', apTransitions);

  const parts = [];
  parts.push(errors.switches ? `switches: ${errors.switches}` : `${switches.length} switches${String(debug.switchesEndpoint || '').includes('/cmdb/') ? ' (config list only — the live status endpoint wasn\'t available, so online/offline isn\'t updated)' : ''}`);
  parts.push(errors.accessPoints ? `access points: ${errors.accessPoints}` : `${accessPoints.length} access points`);
  const status = (errors.switches ? 'error' : 'ok') === 'ok' && (errors.accessPoints ? 'error' : 'ok') === 'ok' ? 'ok' : (errors.switches && errors.accessPoints ? 'error' : 'partial');

  const debugJson = JSON.stringify(debug, null, 2).slice(0, 6000);
  db.prepare("UPDATE routers SET last_sync_at = datetime('now'), last_sync_status = ?, last_sync_debug = ? WHERE id = ?").run(`${status}: ${parts.join(', ')}`, debugJson, routerId);
  if (global.io) global.io.emit('devices:controller-sync', { routerId });

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
  reschedule(getSetting('fortigate_sync_cron', '* * * * *')); // every minute — it's two light GETs per FortiGate, and this is what drives switch/AP online/offline status
}

module.exports = { syncRouter, syncAllFortiGates, reschedule, initScheduler };
