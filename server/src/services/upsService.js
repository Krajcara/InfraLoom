'use strict';

const db = require('../db/database');
const { notify } = require('./notificationService');
const { readUps } = require('../lib/upsSnmp');

// A single lost SNMP reply (UDP) is normal; only call the UPS unreachable
// after this many polls in a row failed.
const FAIL_THRESHOLD = 3;
const HISTORY_DAYS = 14;

const inFlight = new Set();
let lastCleanup = 0;

function getSetting(key, fallback) {
  return db.prepare('SELECT value FROM settings WHERE key = ?').get(key)?.value ?? fallback;
}

const fmt = (v, unit) => (v === null || v === undefined ? '?' : `${v}${unit}`);

/** Which notifications a status change should raise. `prev` is what the UPS
 * was last known to be doing. Power-failure events matter most: losing mains
 * (on_battery), the battery running low while on battery, and mains coming
 * back. Reachability (offline/online) is reported separately. */
function eventsFor(prev, next, name, r) {
  const p = prev && prev !== 'unknown' ? prev : null;
  const events = [];
  const state = r ? `${fmt(r.charge_pct, '%')} charge, ~${fmt(r.runtime_min, ' min')} remaining` : '';

  if (next === 'offline') {
    if (p !== 'offline') events.push(['ups_offline', `UPS "${name}" is not responding to SNMP (${FAIL_THRESHOLD} polls in a row failed).`]);
    return events;
  }
  if (p === 'offline') events.push(['ups_online', `UPS "${name}" is reachable again.`]);

  if (next === 'low_battery' && p !== 'low_battery') {
    events.push(['ups_low_battery', `UPS "${name}" battery is LOW while running on battery — ${state}. Shutdown may be imminent.`]);
  } else if (next === 'on_battery' && p !== 'on_battery' && p !== 'low_battery') {
    events.push(['ups_on_battery', `UPS "${name}" lost mains power and is running on battery — ${state}.`]);
  } else if ((next === 'online' || next === 'bypass') && (p === 'on_battery' || p === 'low_battery')) {
    events.push(['ups_power_restored', `UPS "${name}" is back on mains power (battery ${fmt(r?.charge_pct, '%')}).`]);
  }
  return events;
}

async function applyResult(u, reading, error, unsupported = false) {
  const prev = u.last_status;

  if (reading) {
    db.prepare(
      `UPDATE ups_devices SET last_status=?, last_reading=?, last_error=NULL, last_polled_at=datetime('now'), last_ok_at=datetime('now'),
         consecutive_failures=0, manufacturer=COALESCE(?, manufacturer), model=COALESCE(?, model) WHERE id=?`
    ).run(reading.status, JSON.stringify(reading), reading.manufacturer, reading.model, u.id);
    db.prepare(
      'INSERT INTO ups_readings (ups_id, status, charge_pct, runtime_min, load_pct, input_v, output_v, battery_temp_c) VALUES (?,?,?,?,?,?,?,?)'
    ).run(u.id, reading.status, reading.charge_pct, reading.runtime_min, reading.output_load_pct, reading.input_voltage_v, reading.output_voltage_v, reading.battery_temp_c);

    for (const [type, msg] of eventsFor(prev, reading.status, u.name, reading)) await notify(msg, type, { type: 'ups', id: u.id }).catch(() => {});
    return;
  }

  if (unsupported) {
    // Reachable, but exposes no UPS data we can read. That is a configuration/compatibility
    // problem to show on the card — not an outage, so it never counts toward "offline" or alerts.
    db.prepare("UPDATE ups_devices SET last_error=?, last_polled_at=datetime('now'), consecutive_failures=0 WHERE id=?").run(error, u.id);
    return;
  }

  const failures = (u.consecutive_failures || 0) + 1;
  const next = failures >= FAIL_THRESHOLD ? 'offline' : prev || 'unknown';
  db.prepare('UPDATE ups_devices SET last_status=?, last_error=?, last_polled_at=datetime(\'now\'), consecutive_failures=? WHERE id=?').run(next, error, failures, u.id);
  for (const [type, msg] of eventsFor(prev, next, u.name, null)) await notify(msg, type, { type: 'ups', id: u.id }).catch(() => {});
}

/** Polls one UPS now. Returns the refreshed row (or null if it's gone). */
async function pollUps(id) {
  const u = db.prepare('SELECT * FROM ups_devices WHERE id = ?').get(id);
  if (!u) return null;
  if (inFlight.has(id)) return u; // a poll for this UPS is already running
  inFlight.add(id);
  try {
    let reading = null;
    let error = null;
    let unsupported = false;
    try {
      reading = await readUps(u.ip_address, u);
    } catch (err) {
      error = err.message;
      unsupported = !!err.unsupported;
    }
    await applyResult(u, reading, error, unsupported);
  } finally {
    inFlight.delete(id);
  }
  if (global.io) global.io.emit('ups:update', { id });
  return db.prepare('SELECT * FROM ups_devices WHERE id = ?').get(id);
}

async function pollAll() {
  const ids = db.prepare('SELECT id FROM ups_devices WHERE enabled = 1').all().map((r) => r.id);
  await Promise.allSettled(ids.map(pollUps));
  if (Date.now() - lastCleanup > 6 * 3600 * 1000) {
    lastCleanup = Date.now();
    db.prepare(`DELETE FROM ups_readings WHERE at < datetime('now', '-${HISTORY_DAYS} days')`).run();
  }
}

let cronTask = null;
function reschedule(cronExpr) {
  const cron = require('node-cron');
  if (cronTask) {
    cronTask.stop();
    cronTask = null;
  }
  if (!cronExpr || !cron.validate(cronExpr)) {
    console.error(`[UPS] Invalid cron expression "${cronExpr}" — scheduler disabled`);
    return false;
  }
  cronTask = cron.schedule(cronExpr, () => {
    pollAll().catch((err) => console.error('[UPS] Poll failed:', err.message));
  });
  return true;
}

function initScheduler() {
  reschedule(getSetting('ups_poll_cron', '* * * * *')); // every minute
  setTimeout(() => pollAll().catch(() => {}), 8000); // don't leave the page empty after a restart
}

module.exports = { pollUps, pollAll, initScheduler, reschedule, eventsFor, FAIL_THRESHOLD };
