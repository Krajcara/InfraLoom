'use strict';

// Traffic history: reads the counters of the watched interfaces, stores a rate for every poll, summarises by the hour, keeps what was set to be kept,
// and raises the alert when an interface stays loaded.

const cron = require('node-cron');
const db = require('../../db/database');
const { counterRate, nextState, percentile, fmtBps } = require('./rates');
const { readDevice, methodFor } = require('./collect');

const TABLES = ['routers', 'switches', 'access_points'];
class ConfigError extends Error {}

const DEFAULTS = { poll_minutes: 1, warn_pct: 80, crit_pct: 90, sustain_minutes: 10, raw_days: 7, hourly_days: 400 };
const LIMITS = { poll_minutes: [1, 10], warn_pct: [10, 99], crit_pct: [11, 100], sustain_minutes: [1, 120], raw_days: [1, 31], hourly_days: [30, 1100] };

function getConfig() {
  const out = { ...DEFAULTS };
  for (const r of db.prepare('SELECT key, value FROM traffic_config').all()) if (r.key in DEFAULTS && Number.isInteger(Number(r.value))) out[r.key] = Number(r.value);
  return out;
}
function saveConfig(body = {}) {
  const next = { ...getConfig() };
  for (const k of Object.keys(DEFAULTS)) {
    if (body[k] === undefined) continue;
    const n = Number(body[k]); const [lo, hi] = LIMITS[k];
    if (!Number.isInteger(n) || n < lo || n > hi) throw new ConfigError(`${k.replace(/_/g, ' ')} must be a whole number from ${lo} to ${hi}`);
    next[k] = n;
  }
  if (next.crit_pct <= next.warn_pct) throw new ConfigError('The critical level must be above the warning level');
  const put = db.prepare('INSERT INTO traffic_config (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value');
  db.transaction(() => { for (const [k, v] of Object.entries(next)) put.run(k, String(v)); })();
  return next;
}

const notify = async (event, message) => require('../notificationService').notify(message, event);
const RAW = new Map(); // the last raw answer of each device, to find out why a field is missing
const inFlight = new Set();
const rawOf = (table, id) => RAW.get(`${table}:${id}`) || null;
/** Keeps what a device answered (when its interfaces are read to choose from, as well as when it is polled). */
const remember = (table, id, reading, now = Math.floor(Date.now() / 1000)) => RAW.set(`${table}:${id}`, { at: new Date(now * 1000).toISOString(), method: reading.method, endpoint: reading.endpoint, interfaces: reading.interfaces.length, raw: reading.raw });

/** Reads one device and updates every watched interface of it. */
async function pollDevice(table, id, { now = Math.floor(Date.now() / 1000), hooks = {}, notifier = notify } = {}) {
  if (!TABLES.includes(table)) throw new Error('Unknown device table');
  const key = `${table}:${id}`;
  if (inFlight.has(key)) return { skipped: 'already reading' };
  inFlight.add(key);
  try {
    const rows = db.prepare('SELECT * FROM traffic_interfaces WHERE device_table = ? AND device_id = ? AND enabled = 1').all(table, id);
    const device = db.prepare(`SELECT * FROM ${table} WHERE id = ?`).get(id);
    if (!rows.length || !device) return { skipped: 'nothing to read' };
    const cfg = getConfig();
    let reading;
    try { reading = await readDevice(table, device, hooks); } catch (e) {
      db.prepare(`UPDATE traffic_interfaces SET last_error = ? WHERE id IN (${rows.map(() => '?').join(',')})`).run(String(e.message).slice(0, 300), ...rows.map((r) => r.id));
      return { error: e.message };
    }
    remember(table, id, reading, now);
    const byName = new Map(reading.interfaces.map((i) => [i.name, i]));
    const out = { sampled: 0, skipped: 0, alerts: 0, missing: 0 };

    for (const row of rows) {
      const cur = byName.get(row.if_name);
      if (!cur) { db.prepare('UPDATE traffic_interfaces SET last_error = ? WHERE id = ?').run('The device does not list this interface (any more)', row.id); out.missing += 1; continue; }
      const speedMbps = row.speed_override ? row.speed_mbps : (cur.speedMbps ?? row.speed_mbps);
      const maxBps = speedMbps ? speedMbps * 1e6 : null;
      const dt = row.last_ts ? now - row.last_ts : 0;
      const rin = counterRate(row.last_in, cur.inOctets, dt, { bits: cur.bits, maxBps });
      const rout = counterRate(row.last_out, cur.outOctets, dt, { bits: cur.bits, maxBps });
      const base = [String(cur.inOctets ?? ''), String(cur.outOctets ?? ''), now, cur.status, speedMbps ?? null, cur.bits];
      if (rin.bps == null || rout.bps == null) {
        db.prepare('UPDATE traffic_interfaces SET last_in = ?, last_out = ?, last_ts = ?, oper_status = ?, speed_mbps = ?, counter_bits = ?, last_error = NULL WHERE id = ?').run(...base, row.id);
        out.skipped += 1; continue;
      }
      db.prepare('INSERT OR REPLACE INTO traffic_samples (interface_id, ts, dt, in_bps, out_bps) VALUES (?, ?, ?, ?, ?)').run(row.id, now, dt, rin.bps, rout.bps);
      const util = maxBps ? (Math.max(rin.bps, rout.bps) / maxBps) * 100 : null;
      const warn = row.warn_pct ?? cfg.warn_pct; const crit = row.crit_pct ?? cfg.crit_pct; const sustain = (row.sustain_minutes ?? cfg.sustain_minutes) * 60;
      const st = nextState(row, util, now, { warn, crit, sustainSec: sustain, clearSec: Math.max(3 * cfg.poll_minutes * 60, 180) });
      db.prepare('UPDATE traffic_interfaces SET last_in = ?, last_out = ?, last_ts = ?, oper_status = ?, speed_mbps = ?, counter_bits = ?, in_bps = ?, out_bps = ?, state = ?, above_warn_since = ?, above_crit_since = ?, below_since = ?, last_error = NULL WHERE id = ?')
        .run(...base, rin.bps, rout.bps, st.state, st.patch.above_warn_since ?? null, st.patch.above_crit_since ?? null, st.patch.below_since ?? null, row.id);
      out.sampled += 1;
      if (st.changed) {
        const name = `${device.name} ${row.label || row.if_name}`;
        const load = `${util.toFixed(0)}% of ${fmtBps(maxBps)} (in ${fmtBps(rin.bps)}, out ${fmtBps(rout.bps)})`;
        const event = st.changed === 'ok' ? 'traffic_normal' : st.changed === 'critical' ? 'traffic_high_critical' : 'traffic_high_warning';
        const text = st.changed === 'ok' ? `Traffic on ${name} is back to normal: ${load}.` : `Traffic on ${name} is ${st.changed === 'critical' ? 'very high' : 'high'}: ${load}, for ${sustain / 60} min.`;
        try { await notifier(event, text); out.alerts += 1; } catch (e) { console.error('[traffic] notify failed:', e.message); }
      }
    }
    return out;
  } finally { inFlight.delete(key); }
}

async function pollAll(opts = {}) {
  const devices = db.prepare('SELECT DISTINCT device_table, device_id FROM traffic_interfaces WHERE enabled = 1').all();
  const out = { devices: devices.length, sampled: 0, errors: 0, alerts: 0 };
  for (let i = 0; i < devices.length; i += 3) {
    const part = await Promise.all(devices.slice(i, i + 3).map((d) => pollDevice(d.device_table, d.device_id, opts).catch((e) => ({ error: e.message }))));
    for (const r of part) { out.sampled += r.sampled || 0; out.alerts += r.alerts || 0; if (r.error) out.errors += 1; }
  }
  db.prepare("INSERT INTO traffic_config (key, value) VALUES ('last_poll', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value").run(new Date().toISOString());
  return out;
}

/** The hourly summaries of the hours that are over and not summarised yet, and the clean-up of what is past its time. */
function rollup(nowSec = Math.floor(Date.now() / 1000)) {
  const cfg = getConfig(); const current = Math.floor(nowSec / 3600) * 3600; let hours = 0;
  const ins = db.prepare('INSERT OR REPLACE INTO traffic_hourly (interface_id, hour, samples, avg_in, avg_out, max_in, max_out, p95_in, p95_out, bytes_in, bytes_out) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)');
  for (const { id } of db.prepare('SELECT id FROM traffic_interfaces').all()) {
    const todo = db.prepare('SELECT DISTINCT (ts / 3600) * 3600 AS h FROM traffic_samples WHERE interface_id = ? AND ts < ? AND (ts / 3600) * 3600 NOT IN (SELECT hour FROM traffic_hourly WHERE interface_id = ?)').all(id, current, id);
    for (const { h } of todo) {
      const rows = db.prepare('SELECT in_bps, out_bps, dt FROM traffic_samples WHERE interface_id = ? AND ts >= ? AND ts < ?').all(id, h, h + 3600);
      if (!rows.length) continue;
      const ins_ = rows.map((r) => r.in_bps); const outs = rows.map((r) => r.out_bps); const avg = (a) => a.reduce((t, v) => t + v, 0) / a.length;
      ins.run(id, h, rows.length, avg(ins_), avg(outs), Math.max(...ins_), Math.max(...outs), percentile(ins_, 95), percentile(outs, 95), rows.reduce((t, r) => t + (r.in_bps * r.dt) / 8, 0), rows.reduce((t, r) => t + (r.out_bps * r.dt) / 8, 0));
      hours += 1;
    }
  }
  const purged = {
    samples: db.prepare('DELETE FROM traffic_samples WHERE ts < ?').run(nowSec - cfg.raw_days * 86400).changes,
    hourly: db.prepare('DELETE FROM traffic_hourly WHERE hour < ?').run(nowSec - cfg.hourly_days * 86400).changes,
  };
  return { hours, purged };
}

let tasks = [];
function stop() { tasks.forEach((t) => t.stop()); tasks = []; }
function schedule() {
  stop();
  const n = getConfig().poll_minutes;
  tasks.push(cron.schedule(`*/${n} * * * *`, () => pollAll().catch((e) => console.error('[traffic] poll failed:', e.message))));
  tasks.push(cron.schedule('7 * * * *', () => { try { rollup(); } catch (e) { console.error('[traffic] roll-up failed:', e.message); } }));
}
const initScheduler = schedule;
const reload = schedule;

module.exports = { getConfig, saveConfig, pollDevice, pollAll, rollup, rawOf, remember, initScheduler, reload, methodFor, ConfigError, TABLES, DEFAULTS };
