'use strict';

// Health of network devices, opt-in per device: a FortiGate over its REST API (CPU/memory, HA, IPsec tunnels, licences, SD-WAN)
// and anything that speaks SNMP — MikroTik first — (CPU, memory, disk, temperature, watched interface links, restarts).
// Same alert discipline as the hypervisor thresholds: a level must hold for two readings, alerts are not repeated, a value
// clears only when it is a few points below its level, and "back to normal" is announced.

const db = require('../db/database');
const { levelFor, CONFIRM } = require('./hypervisorThresholdService');
const { ratingLevel } = require('../lib/fortigateHealth');

const TABLES = ['routers', 'switches', 'access_points'];
const SETTING_KEY = 'device_health_thresholds';
const EVENT_FOR = { warn: 'device_health_warning', crit: 'device_health_critical', ok: 'device_health_ok' };
const MAX_RAW = 120000;

const DEFAULTS = {
  enabled: true,
  cpu: { enabled: true, warn: 90, crit: 98 },
  memory: { enabled: true, warn: 82, crit: 90 },   // FortiOS enters "conserve mode" at 88 %
  disk: { enabled: true, warn: 85, crit: 95 },
  temperature: { enabled: true, warn: 70, crit: 85 }, // °C
  licence_days: { enabled: true, warn: 30, crit: 7 },
  ipsec: { enabled: true }, ha: { enabled: true }, sdwan: { enabled: true },
  links: { enabled: true }, poll: { enabled: true }, restart: { enabled: true },
  // FortiLink-managed switches and APs, read through the FortiGate
  poe: { enabled: true, warn: 80, crit: 90 },      // share of a switch's PoE budget in use
  rating: { enabled: true },                       // FortiGate's own verdict (good / fair / poor)
  fan: { enabled: true },                          // fans and power supplies
  uplink: { enabled: true },                       // an AP's uplink rated worse than good
};
const KIND_CFG = { cpu: 'cpu', memory: 'memory', disk: 'disk', temperature: 'temperature', licence: 'licence_days', ipsec: 'ipsec', ha: 'ha', sdwan: 'sdwan', link: 'links', poll: 'poll', rating: 'rating', fan: 'fan', psu: 'fan', poe: 'poe', uplink: 'uplink' };
const SECTION_KINDS = { resources: ['cpu', 'memory', 'disk'], ha: ['ha'], ipsec: ['ipsec'], licenses: ['licence'], sdwan: ['sdwan'] };

// ── configuration ──────────────────────────────────────────────────────────

function sanitize(input, strict = false) {
  const src = input && typeof input === 'object' ? input : {};
  const out = JSON.parse(JSON.stringify(DEFAULTS));
  const bad = (m) => { if (strict) throw new Error(m); };
  if (typeof src.enabled === 'boolean') out.enabled = src.enabled;
  for (const k of ['cpu', 'memory', 'disk', 'poe']) {
    const s = src[k]; if (s === undefined) continue;
    if (typeof s.enabled === 'boolean') out[k].enabled = s.enabled;
    const w = s.warn === undefined ? out[k].warn : Number(s.warn), c = s.crit === undefined ? out[k].crit : Number(s.crit);
    if (!(w >= 1 && w <= 100 && c >= 1 && c <= 100)) bad(`${k}: warning and critical levels must be between 1 and 100`);
    else if (w >= c) bad(`${k}: the warning level must be lower than the critical level`);
    else { out[k].warn = w; out[k].crit = c; }
  }
  if (src.temperature !== undefined) {
    const s = src.temperature;
    if (typeof s.enabled === 'boolean') out.temperature.enabled = s.enabled;
    const w = s.warn === undefined ? out.temperature.warn : Number(s.warn), c = s.crit === undefined ? out.temperature.crit : Number(s.crit);
    if (!(w >= 20 && w <= 150 && c >= 20 && c <= 150)) bad('temperature: levels must be between 20 and 150 °C');
    else if (w >= c) bad('temperature: the warning level must be lower than the critical level');
    else { out.temperature.warn = w; out.temperature.crit = c; }
  }
  if (src.licence_days !== undefined) {
    const s = src.licence_days;
    if (typeof s.enabled === 'boolean') out.licence_days.enabled = s.enabled;
    const w = s.warn === undefined ? out.licence_days.warn : Number(s.warn), c = s.crit === undefined ? out.licence_days.crit : Number(s.crit);
    if (!(Number.isInteger(w) && Number.isInteger(c) && c >= 0 && w <= 3650)) bad('licence_days: whole numbers of days, 0 to 3650');
    else if (w <= c) bad('licence_days: the warning period must be longer than the critical period');
    else { out.licence_days.warn = w; out.licence_days.crit = c; }
  }
  for (const k of ['ipsec', 'ha', 'sdwan', 'links', 'poll', 'restart', 'rating', 'fan', 'uplink']) if (src[k] && typeof src[k].enabled === 'boolean') out[k].enabled = src[k].enabled;
  return out;
}

function getConfig() {
  const raw = db.prepare('SELECT value FROM settings WHERE key = ?').get(SETTING_KEY)?.value;
  try { return sanitize(raw ? JSON.parse(raw) : {}); } catch { return sanitize({}); }
}
function saveConfig(input) {
  const cfg = sanitize(input, true);
  db.prepare("INSERT INTO settings (key, value, updated_at) VALUES (?, ?, datetime('now')) ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = datetime('now')").run(SETTING_KEY, JSON.stringify(cfg));
  return cfg;
}

// ── state machine (same rules as the hypervisor thresholds, keyed by device) ──

const levelForDays = (days, th) => (days <= th.crit ? 'crit' : days <= th.warn ? 'warn' : 'ok');
const KEY = 'device_table = ? AND device_id = ? AND kind = ? AND subject = ?';

function observe(table, id, kind, subject, candidate, value, detail) {
  const row = db.prepare(`SELECT * FROM device_health_state WHERE ${KEY}`).get(table, id, kind, subject);
  const now = new Date().toISOString();
  if (!row) {
    db.prepare('INSERT INTO device_health_state (device_table, device_id, kind, subject, level, pending_level, pending_count, value, detail, since, updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?)')
      .run(table, id, kind, subject, 'ok', candidate === 'ok' ? null : candidate, candidate === 'ok' ? 0 : 1, value, detail, now, now);
    return null;
  }
  if (candidate === row.level) {
    db.prepare(`UPDATE device_health_state SET pending_level = NULL, pending_count = 0, value = ?, detail = ?, updated_at = ? WHERE ${KEY}`).run(value, detail, now, table, id, kind, subject);
    return null;
  }
  const count = row.pending_level === candidate ? row.pending_count + 1 : 1;
  if (count >= CONFIRM) {
    db.prepare(`UPDATE device_health_state SET level = ?, pending_level = NULL, pending_count = 0, value = ?, detail = ?, since = ?, updated_at = ? WHERE ${KEY}`).run(candidate, value, detail, now, now, table, id, kind, subject);
    return { from: row.level, to: candidate };
  }
  db.prepare(`UPDATE device_health_state SET pending_level = ?, pending_count = ?, value = ?, detail = ?, updated_at = ? WHERE ${KEY}`).run(candidate, count, value, detail, now, table, id, kind, subject);
  return null;
}
const prevLevel = (table, id, kind, subject) => db.prepare(`SELECT level FROM device_health_state WHERE ${KEY}`).get(table, id, kind, subject)?.level || 'ok';

// ── wording ────────────────────────────────────────────────────────────────

const UNIT = { cpu: '%', memory: '%', disk: '%', poe: '%', temperature: ' °C' };
const addr = (d) => (d.ip_address && d.ip_address !== '0.0.0.0' ? ` (${d.ip_address})` : '');
function messageFor(device, kind, level, detail, cfg) {
  const head = `Device "${device.name}"${addr(device)}: ${detail}`;
  if (level === 'ok') return `${head} — back to normal.`;
  const th = cfg[KIND_CFG[kind]];
  if (UNIT[kind]) return level === 'crit' ? `${head} — CRITICAL (level ${th.crit}${UNIT[kind]}).` : `${head} — above the warning level of ${th.warn}${UNIT[kind]}.`;
  return level === 'crit' ? `${head} — CRITICAL.` : `${head}.`;
}
const fmtUp = (s) => { const d = Math.floor(s / 86400), h = Math.floor((s % 86400) / 3600), m = Math.floor((s % 3600) / 60); return d > 0 ? `${d}d ${h}h` : h > 0 ? `${h}h ${m}m` : `${m}m`; };

// ── evaluation ─────────────────────────────────────────────────────────────

/** Turns one reading into observations. `reading` is { method:'fortigate', sections } or { method:'snmp', ...snmp reading }. */
function evaluate(table, device, reading, cfg, { watch = [], baselines = {} } = {}) {
  const id = device.id;
  const out = [];
  const seen = new Set();
  const retainKinds = new Set();
  const run = (kind, subject, candidate, value, detail) => {
    if (!cfg[KIND_CFG[kind]]?.enabled) return;
    seen.add(`${kind}|${subject}`);
    const t = observe(table, id, kind, subject, candidate, value, detail);
    if (t) out.push({ kind, subject, ...t, detail });
  };
  const numeric = (kind, subject, value, detail) => {
    if (value === null || value === undefined || !Number.isFinite(Number(value))) return;
    run(kind, subject, levelFor(Number(value), cfg[KIND_CFG[kind]], prevLevel(table, id, kind, subject)), Number(value), detail);
  };
  const newBaselines = { ...baselines };

  if (reading.method === 'fortigate') {
    for (const [name, sec] of Object.entries(reading.sections)) {
      if (!sec.ok) { (SECTION_KINDS[name] || []).forEach((k) => retainKinds.add(k)); continue; }
      if (name === 'resources') {
        const d = sec.data;
        numeric('cpu', 'cpu', d.cpu, `CPU is at ${d.cpu}%`);
        numeric('memory', 'memory', d.memory, `memory is at ${d.memory}%`);
        numeric('disk', 'disk', d.disk, `disk is ${d.disk}% full`);
      } else if (name === 'ipsec') {
        for (const t of sec.data) {
          const candidate = t.state === 'up' ? 'ok' : t.state === 'partial' ? 'warn' : 'crit';
          run('ipsec', t.name, candidate, t.total ? t.up / t.total : 0, t.state === 'partial' ? `IPsec tunnel "${t.name}" has ${t.up} of ${t.total} phase-2 selectors up` : `IPsec tunnel "${t.name}" is ${t.state}`);
        }
      } else if (name === 'ha' && sec.data.mode !== 'standalone') {
        const expected = Math.max(Number(baselines.ha) || 0, sec.data.count);
        newBaselines.ha = expected;
        run('ha', 'members', sec.data.count < expected ? 'crit' : 'ok', sec.data.count, `HA cluster has ${sec.data.count} of ${expected} members`);
      } else if (name === 'licenses') {
        for (const l of sec.data) {
          const d = l.days_left;
          run('licence', l.name, levelForDays(d, cfg.licence_days), d, d < 0 ? `licence "${l.name}" expired ${-d} day${d === -1 ? '' : 's'} ago` : `licence "${l.name}" expires in ${d} day${d === 1 ? '' : 's'} (${l.expires_at.slice(0, 10)})`);
        }
      } else if (name === 'sdwan') {
        for (const m of sec.data) run('sdwan', m.name, m.state === 'up' ? 'ok' : 'crit', m.state === 'up' ? 1 : 0, `SD-WAN member "${m.name}" is ${m.state}`);
      }
    }
  } else if (reading.method === 'snmp') {
    numeric('cpu', 'cpu', reading.cpu, `CPU is at ${reading.cpu}%`);
    if (reading.memory) numeric('memory', 'memory', reading.memory.pct, `memory is at ${reading.memory.pct}%`);
    // RouterOS keeps only its packages on a small flash (16 MB on a CRS326) that is normally nearly full and does not grow like
    // a data disk — alerting on it would be a permanent false alarm. It is still shown in the panel.
    const routerOs = /^RouterOS\b/i.test(reading.sys?.description || '');
    if (!routerOs) for (const dk of reading.disks || []) numeric('disk', dk.name, dk.pct, `disk "${dk.name}" is ${dk.pct}% full`);
    numeric('temperature', 'temperature', reading.temperature, `temperature is ${reading.temperature} °C`);
    for (const w of watch) {
      const itf = (reading.interfaces || []).find((i) => i.name.toLowerCase() === w.toLowerCase());
      if (!itf) continue; // not on the device (any more): nothing to judge
      run('link', itf.name, itf.admin === 'down' || itf.oper === 'up' ? 'ok' : 'crit', itf.oper === 'up' ? 1 : 0, `interface "${itf.name}" is ${itf.admin === 'down' ? 'disabled' : itf.oper}`);
    }
  } else if (reading.method === 'managed-switch') {
    const s = reading.item;
    numeric('cpu', 'cpu', s.cpu, `CPU is at ${s.cpu}%`);
    numeric('memory', 'memory', s.memory, `memory is at ${s.memory}%`);
    numeric('temperature', 'temperature', s.temperature, `temperature is ${s.temperature} °C`);
    if (s.poe) numeric('poe', 'budget', s.poe.pct, `PoE budget is ${s.poe.pct}% used (${Math.round(s.poe.used_w * 10) / 10} of ${s.poe.max_w} W)`);
    const good = (st) => /^(ok|good|normal|online|active)$/i.test(st);
    for (const f of s.fans) run('fan', f.name, good(f.status) ? 'ok' : 'crit', good(f.status) ? 1 : 0, `fan "${f.name}" status is ${f.status || 'unknown'}`);
    for (const p of s.psu) run('psu', p.name, good(p.status) ? 'ok' : 'crit', good(p.status) ? 1 : 0, `power supply "${p.name}" status is ${p.status || 'unknown'}`);
    if (s.overall != null) run('rating', 'overall', ratingLevel(s.overall), ratingLevel(s.overall) === 'ok' ? 1 : 0, `FortiGate rates the health "${s.overall}"${s.not_good.length ? ` (${s.not_good.join(', ')})` : ''}`);
  } else if (reading.method === 'managed-ap') {
    const a = reading.item;
    // note: /connected/ would also match "Disconnected" — only exactly "connected" has current readings
    if (a.state && !/^connected$/i.test(String(a.state).trim())) {
      // not connected: its numbers are stale, so judge nothing and keep what we knew
      ['cpu', 'memory', 'rating', 'uplink'].forEach((k) => retainKinds.add(k));
    } else {
      numeric('cpu', 'cpu', a.cpu, `CPU is at ${a.cpu}%`);
      numeric('memory', 'memory', a.memory, `memory is at ${a.memory}%`);
      if (a.overall != null) run('rating', 'overall', ratingLevel(a.overall), ratingLevel(a.overall) === 'ok' ? 1 : 0, `FortiGate rates the health "${a.overall}"`);
      if (a.uplink && a.uplink.severity != null) run('uplink', 'uplink', ratingLevel(a.uplink.severity), a.uplink.mbps ?? 0, `uplink runs at ${a.uplink.mbps ?? '?'} Mbps, rated "${a.uplink.severity}"`);
    }
  }
  return { transitions: out, seen, retainKinds, baselines: newBaselines };
}

function cleanup(table, id, cfg, seen, retainKinds) {
  for (const r of db.prepare('SELECT kind, subject FROM device_health_state WHERE device_table = ? AND device_id = ?').all(table, id)) {
    const disabled = !cfg[KIND_CFG[r.kind]]?.enabled;
    if (!disabled && (retainKinds.has(r.kind) || r.kind === 'poll')) continue;
    if (disabled || !seen.has(`${r.kind}|${r.subject}`)) db.prepare(`DELETE FROM device_health_state WHERE ${KEY}`).run(table, id, r.kind, r.subject);
  }
}

// ── polling ────────────────────────────────────────────────────────────────

const inFlight = new Set();
const jparse = (v) => { try { return v ? JSON.parse(v) : null; } catch { return null; } };
const watchList = (device) => String(device.health_watch_ifaces || '').split(',').map((s) => s.trim()).filter(Boolean);

function methodFor(table, d) {
  if (d.discovered_from_router_id) return 'fortigate-managed';
  if (table === 'routers' && String(d.brand).toLowerCase() === 'fortigate' && d.api_token) return 'fortigate';
  const hasSnmp = d.snmp_version === '3' ? !!d.snmp_username : !!(d.snmp_community || d.snmp_version);
  if (d.ip_address && hasSnmp) return 'snmp';
  return null;
}

function contextFor(d) { return d.monitor_id ? { type: 'monitor', id: d.monitor_id } : null; }

async function pollDevice(table, id) {
  if (!TABLES.includes(table)) throw new Error('Unknown device table');
  const key = `${table}:${id}`;
  if (inFlight.has(key)) return { skipped: 'already polling' };
  inFlight.add(key);
  try {
    const device = db.prepare(`SELECT * FROM ${table} WHERE id = ?`).get(id);
    if (!device) return { skipped: 'not found' };
    if (device.discovered_from_router_id) {
      // a FortiLink-managed switch/AP is read together with the FortiGate that manages it
      const parent = db.prepare('SELECT * FROM routers WHERE id = ?').get(device.discovered_from_router_id);
      if (!parent?.health_enabled || !parent.health_managed) return { skipped: 'health of managed devices is off on the FortiGate' };
      return pollDevice('routers', parent.id);
    }
    const cfg = getConfig();
    const now = new Date().toISOString();
    const prev = jparse(device.health_last) || {};
    const method = methodFor(table, device);

    let reading = null, error = null;
    if (!method) error = 'No way to read health from this device: a FortiGate needs its API token, anything else needs SNMP settings';
    else {
      try {
        reading = method === 'fortigate'
          ? { method, ...(await require('../lib/fortigateHealth').fetchHealth(device)) }
          : { ...(await require('../lib/snmpHealth').readSnmpHealth(device.ip_address, device)), method };
      } catch (err) { error = err.message; }
    }

    // a FortiGate whose every section failed is a failed reading, not "nothing to report"
    if (reading?.method === 'fortigate' && Object.values(reading.sections).every((s) => !s.ok)) {
      error = `none of the health endpoints answered: ${Object.entries(reading.sections).map(([k, s]) => `${k}: ${s.error}`).join('; ')}`;
    }

    const seen = new Set(); const retain = new Set(); let transitions = []; let baselines = prev.baselines || {};
    if (cfg.enabled) {
      if (cfg.poll.enabled) {
        const t = observe(table, id, 'poll', 'reachable', error ? 'crit' : 'ok', error ? 0 : 1, `health data cannot be read: ${error || ''}`.trim());
        if (t) transitions.push({ kind: 'poll', subject: 'reachable', ...t, detail: `health data cannot be read${error ? ` (${error})` : ''}` });
      }
      if (reading && !error) {
        const ev = evaluate(table, device, reading, cfg, { watch: watchList(device), baselines });
        transitions = transitions.concat(ev.transitions); ev.seen.forEach((s) => seen.add(s)); ev.retainKinds.forEach((s) => retain.add(s)); baselines = ev.baselines;
        cleanup(table, id, cfg, seen, retain);
      } else {
        // could not read at all: keep what we knew, judge nothing
        for (const k of Object.keys(KIND_CFG)) retain.add(k);
        cleanup(table, id, cfg, seen, retain);
      }
    } else {
      db.prepare('DELETE FROM device_health_state WHERE device_table = ? AND device_id = ?').run(table, id);
    }

    // SNMP devices: a drop in uptime means it restarted
    let restarted = null;
    if (cfg.restart.enabled && reading?.method === 'snmp' && reading.sys.uptime_s !== null && prev.uptime_s != null && prev.uptime_s < 42900000 && reading.sys.uptime_s < prev.uptime_s - 30) {
      restarted = { from: prev.uptime_s, to: reading.sys.uptime_s };
    }

    let last = prev, raw = device.health_raw;
    if (reading && !error) {
      if (reading.method === 'fortigate') {
        last = { at: now, method: 'fortigate', sections: Object.fromEntries(Object.entries(reading.sections).map(([k, s]) => [k, { ok: s.ok, error: s.error || null, endpoint: s.endpoint || null, data: s.data ?? null }])), baselines };
        raw = JSON.stringify(Object.fromEntries(Object.entries(reading.sections).map(([k, s]) => [k, s.ok ? s.raw : `ERROR: ${s.error}`]))).slice(0, MAX_RAW);
      } else {
        const { raw: r, ...rest } = reading;
        last = { at: now, method: 'snmp', uptime_s: reading.sys.uptime_s, reading: rest, baselines };
        raw = JSON.stringify(r).slice(0, MAX_RAW);
      }
    }
    db.prepare(`UPDATE ${table} SET health_last = ?, health_raw = ?, health_checked_at = ?, health_error = ? WHERE id = ?`).run(JSON.stringify(last), raw, now, error, id);

    const { notify } = require('./notificationService');
    const ctx = contextFor(device);
    for (const t of transitions) {
      if (t.from === 'crit' && t.to === 'warn') continue; // easing off, still above the warning level: silent
      await notify(messageFor(device, t.kind, t.to, t.detail, cfg), EVENT_FOR[t.to], ctx);
    }
    if (restarted) await notify(`Device "${device.name}"${addr(device)} restarted (uptime was ${fmtUp(restarted.from)}, now ${fmtUp(restarted.to)}).`, 'device_restarted', ctx);
    if (transitions.length || restarted) if (global.io) global.io.emit('device-health:update', { table, id });
    let managed = null;
    if (table === 'routers' && device.health_managed && cfg.enabled && method === 'fortigate') managed = await pollManagedDevices(device, cfg);
    return { ok: !error, error, transitions: transitions.length, restarted: !!restarted, managed };
  } finally {
    inFlight.delete(key);
  }
}

// ── FortiLink-managed switches and APs, read through their FortiGate ─────────

const jp = (v) => { try { return v ? JSON.parse(v) : null; } catch { return null; } };
const findItem = (table, row, data) => (table === 'switches'
  ? data.find((x) => String(x.key).toLowerCase() === String(row.name).toLowerCase() || x.key === row.discovered_serial)
  : data.find((x) => x.serial === row.discovered_serial) || data.find((x) => x.name === row.name));
const ctxOfManaged = (table, row) => ({ type: table === 'switches' ? 'switch' : 'access_point', id: row.id });
const utc = (epoch) => `${new Date(epoch * 1000).toISOString().replace('T', ' ').slice(0, 16)} UTC`;

/** A switch restarted when its uptime went backwards; an AP when its last-reboot time moved forwards (no clock needed). */
function restartOf(table, prev, item) {
  if (table === 'switches') return prev.uptime_s != null && item.uptime_s != null && item.uptime_s < prev.uptime_s - 30 ? { was: prev.uptime_s, now: item.uptime_s } : null;
  return prev.reboot_epoch != null && item.reboot_epoch != null && item.reboot_epoch > prev.reboot_epoch + 5 ? { at: item.reboot_epoch } : null;
}

/** One message per kind of device: a single restart is named in full, several in the same reading are listed in one message. */
async function notifyRestarts(groups) {
  const maintenance = require('./maintenanceService');
  const { notify } = require('./notificationService');
  for (const [table, plural, list] of [['switches', 'switches', groups.switches], ['access_points', 'access points', groups.aps]]) {
    // a device inside a maintenance window is left out (and counted there), exactly like any other muted alert
    const live = list.filter((x) => !maintenance.suppress('device_restarted', ctxOfManaged(table, x.row)));
    if (!live.length) continue;
    const text = (x) => (table === 'switches' ? `uptime was ${fmtUp(x.info.was)}, now ${fmtUp(x.info.now)}` : `last reboot ${utc(x.info.at)}`);
    const message = live.length === 1
      ? `Device "${live[0].row.name}"${addr(live[0].row)} restarted (${text(live[0])}).`
      : `${live.length} ${plural} restarted: ${live.map((x) => `${x.row.name} (${text(x)})`).join('; ')}.`;
    await notify(message, 'device_restarted', null);
  }
}

async function pollManagedDevices(router, cfg) {
  const { fetchManagedHealth } = require('../lib/fortigateHealth');
  const { notify } = require('./notificationService');
  let rep;
  try { rep = await fetchManagedHealth(router); } catch (err) { rep = { switches: { ok: false, error: err.message }, aps: { ok: false, error: err.message } }; }
  const now = new Date().toISOString();
  const alerts = [];
  const restarts = { switches: [], aps: [] };
  let devices = 0;

  for (const [table, sec] of [['switches', rep.switches], ['access_points', rep.aps]]) {
    for (const row of db.prepare(`SELECT * FROM ${table} WHERE discovered_from_router_id = ?`).all(router.id)) {
      if (!sec.ok) { db.prepare(`UPDATE ${table} SET health_error = ?, health_checked_at = ? WHERE id = ?`).run(sec.error, now, row.id); continue; }
      const item = findItem(table, row, sec.data);
      if (!item) continue; // not in the reply (not authorised yet, or gone): leave it as it was
      devices += 1;
      const prev = jp(row.health_last) || {};
      const method = table === 'switches' ? 'managed-switch' : 'managed-ap';
      const { raw, ...reading } = item;
      if (cfg.enabled) {
        const ev = evaluate(table, row, { method, item }, cfg, {});
        cleanup(table, row.id, cfg, ev.seen, ev.retainKinds);
        for (const t of ev.transitions) alerts.push({ table, row, t });
        const info = cfg.restart.enabled ? restartOf(table, prev, item) : null;
        if (info) restarts[table === 'switches' ? 'switches' : 'aps'].push({ row, info });
      }
      db.prepare(`UPDATE ${table} SET health_last = ?, health_raw = ?, health_checked_at = ?, health_error = NULL WHERE id = ?`)
        .run(JSON.stringify({ at: now, method, uptime_s: item.uptime_s ?? null, reboot_epoch: item.reboot_epoch ?? null, reading }), raw || null, now, row.id);
    }
  }

  for (const { table, row, t } of alerts) {
    if (t.from === 'crit' && t.to === 'warn') continue; // easing off, still above the warning level: silent
    await notify(messageFor(row, t.kind, t.to, t.detail, cfg), EVENT_FOR[t.to], ctxOfManaged(table, row));
  }
  await notifyRestarts(restarts);
  if ((alerts.length || restarts.switches.length || restarts.aps.length) && global.io) global.io.emit('device-health:update', { table: 'managed', id: router.id });
  return { devices, alerts: alerts.length, restarts: restarts.switches.length + restarts.aps.length };
}

async function pollAll() {
  if (!getConfig().enabled) return;
  // forget devices that no longer exist
  for (const t of TABLES) db.prepare(`DELETE FROM device_health_state WHERE device_table = ? AND device_id NOT IN (SELECT id FROM ${t})`).run(t);
  const jobs = [];
  for (const t of TABLES) {
    const where = t === 'routers' ? '' : ' AND discovered_from_router_id IS NULL';
    for (const d of db.prepare(`SELECT id FROM ${t} WHERE health_enabled = 1${where}`).all()) jobs.push([t, d.id]);
  }
  let i = 0;
  const worker = async () => { while (i < jobs.length) { const [t, id] = jobs[i++]; await pollDevice(t, id).catch((e) => console.error(`[DeviceHealth] ${t}/${id}: ${e.message}`)); } };
  await Promise.all(Array.from({ length: Math.min(4, jobs.length) }, worker));
}

// ── reading the state back ─────────────────────────────────────────────────

function activeBreaches({ table = null, id = null, monitorId = null } = {}) {
  const rows = [];
  for (const t of TABLES) {
    if (table && table !== t) continue;
    const q = `SELECT s.device_table, s.device_id, d.name AS device_name, d.ip_address, d.monitor_id, s.kind, s.subject, s.level, s.value, s.detail, s.since
               FROM device_health_state s JOIN ${t} d ON d.id = s.device_id
               WHERE s.device_table = ? AND s.level != 'ok' ${id ? 'AND s.device_id = ?' : ''} ${monitorId ? 'AND d.monitor_id = ?' : ''}
               ORDER BY s.level DESC, d.name, s.kind, s.subject`;
    rows.push(...db.prepare(q).all(t, ...(id ? [id] : []), ...(monitorId ? [monitorId] : [])));
  }
  return rows;
}

function summaryFor(table, row) {
  let enabled = !!row.health_enabled;
  if (row.discovered_from_router_id) {
    // a managed switch/AP is read together with its FortiGate: its switch is that router's setting
    const p = db.prepare('SELECT health_enabled, health_managed FROM routers WHERE id = ?').get(row.discovered_from_router_id);
    enabled = !!(p?.health_enabled && p.health_managed);
  }
  return { enabled, checked_at: row.health_checked_at || null, error: row.health_error || null, alerts: activeBreaches({ table, id: row.id }).map((b) => ({ kind: b.kind, subject: b.subject, level: b.level, value: b.value, detail: b.detail })) };
}

function clearManagedStates(routerId) {
  for (const t of ['switches', 'access_points']) {
    db.prepare(`DELETE FROM device_health_state WHERE device_table = ? AND device_id IN (SELECT id FROM ${t} WHERE discovered_from_router_id = ?)`).run(t, routerId);
  }
}

function setEnabled(table, id, enabled) {
  db.prepare(`UPDATE ${table} SET health_enabled = ? WHERE id = ?`).run(enabled ? 1 : 0, id);
  if (!enabled) {
    db.prepare('DELETE FROM device_health_state WHERE device_table = ? AND device_id = ?').run(table, id);
    if (table === 'routers') clearManagedStates(id);
  }
}

/** FortiGate only: also read the health of the switches and APs it manages. */
function setManaged(routerId, enabled) {
  db.prepare('UPDATE routers SET health_managed = ? WHERE id = ?').run(enabled ? 1 : 0, routerId);
  if (!enabled) clearManagedStates(routerId);
}

let task = null;
function initScheduler() {
  const cron = require('node-cron');
  if (task) task.stop();
  const expr = db.prepare("SELECT value FROM settings WHERE key = 'device_health_cron'").get()?.value || '*/2 * * * *';
  task = cron.schedule(cron.validate(expr) ? expr : '*/2 * * * *', () => pollAll().catch((e) => console.error('[DeviceHealth] poll failed:', e.message)));
  setTimeout(() => pollAll().catch(() => {}), 20000);
}

module.exports = { TABLES, DEFAULTS, EVENT_FOR, getConfig, saveConfig, sanitize, levelForDays, evaluate, pollDevice, pollAll, pollManagedDevices, activeBreaches, summaryFor, setEnabled, setManaged, watchList, initScheduler, methodFor, messageFor };
