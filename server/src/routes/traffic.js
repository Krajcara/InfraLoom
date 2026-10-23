'use strict';

const express = require('express');
const db = require('../db/database');
const { requireAuth, requireRole } = require('../middleware/auth');
const { writeAuditLog } = require('../middleware/audit');
const svc = require('../services/traffic/service');
const { readDevice, methodFor } = require('../services/traffic/collect');
const { series, spark, RANGES } = require('../services/traffic/series');

const router = express.Router();
router.use(requireAuth);
const canEdit = requireRole('superadmin', 'admin', 'operator');
const canAdmin = requireRole('superadmin', 'admin');
const audit = (req, action, id, details) => writeAuditLog({ user_id: req.user.id, username: req.user.username, action: `traffic.${action}`, entity_type: 'traffic_interface', entity_id: id, module: 'traffic', details, ip_address: req.ip });

const bad = (message, status = 400) => Object.assign(new Error(message), { status });
const h = (fn) => (req, res) => Promise.resolve().then(() => fn(req, res)).catch((e) => {
  if (e instanceof svc.ConfigError) return res.status(400).json({ error: e.message });
  if (e.status) return res.status(e.status).json({ error: e.message });
  console.error('[traffic]', e); return res.status(500).json({ error: 'Internal error' });
});

const deviceOf = (table, id) => {
  if (!svc.TABLES.includes(table)) throw bad('Unknown device kind');
  const d = db.prepare(`SELECT * FROM ${table} WHERE id = ?`).get(Number(id));
  if (!d) throw bad('Device not found', 404);
  return d;
};
const names = () => {
  const m = new Map();
  for (const t of svc.TABLES) for (const d of db.prepare(`SELECT id, name, ip_address FROM ${t}`).all()) m.set(`${t}:${d.id}`, d);
  return m;
};
const speedBps = (r) => (r.speed_mbps ? r.speed_mbps * 1e6 : null);

router.get('/interfaces', h((req, res) => {
  const dev = names(); const cfg = svc.getConfig();
  const rows = db.prepare('SELECT * FROM traffic_interfaces ORDER BY device_table, device_id, if_name').all().map((r) => {
    const sb = speedBps(r);
    return {
      id: r.id, device_table: r.device_table, device_id: r.device_id, device_name: dev.get(`${r.device_table}:${r.device_id}`)?.name || '(removed device)', if_name: r.if_name, label: r.label,
      speed_mbps: r.speed_mbps, speed_override: !!r.speed_override, enabled: !!r.enabled, warn_pct: r.warn_pct, crit_pct: r.crit_pct, sustain_minutes: r.sustain_minutes, counter_bits: r.counter_bits,
      oper_status: r.oper_status, in_bps: r.in_bps, out_bps: r.out_bps, util_pct: sb && r.in_bps != null ? (Math.max(r.in_bps, r.out_bps) / sb) * 100 : null,
      state: r.state, last_ts: r.last_ts, last_error: r.last_error, spark: spark(r.id),
    };
  });
  res.json({ interfaces: rows, config: cfg, last_poll: db.prepare("SELECT value FROM traffic_config WHERE key = 'last_poll'").get()?.value || null });
}));

router.get('/interfaces/:id/series', h((req, res) => {
  const r = db.prepare('SELECT id FROM traffic_interfaces WHERE id = ?').get(Number(req.params.id));
  if (!r) throw bad('Interface not found', 404);
  const range = String(req.query.range || '24h');
  if (!RANGES[range]) throw bad(`Range must be one of ${Object.keys(RANGES).join(', ')}`);
  res.json(series(r.id, range));
}));

// devices that can be read, and what their interfaces are
router.get('/devices', canEdit, h((req, res) => {
  const out = [];
  for (const t of svc.TABLES) {
    for (const d of db.prepare(`SELECT * FROM ${t} ORDER BY name`).all()) {
      if (d.discovered_from_router_id) continue; // a FortiLink-managed device is not reachable on its own
      out.push({ table: t, id: d.id, name: d.name, ip_address: d.ip_address, method: methodFor(t, d) });
    }
  }
  res.json(out);
}));

router.get('/discover', canEdit, h(async (req, res) => {
  const table = String(req.query.table || ''); const d = deviceOf(table, req.query.id);
  let r;
  try { r = await readDevice(table, d); } catch (e) { throw bad(e.message, 502); }
  svc.remember(table, d.id, r);
  const have = new Set(db.prepare('SELECT if_name FROM traffic_interfaces WHERE device_table = ? AND device_id = ?').all(table, d.id).map((x) => x.if_name));
  res.json({ method: r.method, interfaces: r.interfaces.map((i) => ({ name: i.name, alias: i.alias, status: i.status, speed_mbps: i.speedMbps, bits: i.bits, monitored: have.has(i.name) })) });
}));

router.post('/interfaces', canEdit, h(async (req, res) => {
  const { table, id } = req.body || {}; const d = deviceOf(String(table || ''), id);
  const wanted = [...new Set((Array.isArray(req.body.interfaces) ? req.body.interfaces : []).map(String))];
  if (!wanted.length) throw bad('Choose at least one interface');
  if (wanted.length > 64) throw bad('At most 64 interfaces at a time');
  let r;
  try { r = await readDevice(table, d); } catch (e) { throw bad(e.message, 502); }
  const by = new Map(r.interfaces.map((i) => [i.name, i]));
  const unknown = wanted.filter((n) => !by.has(n));
  if (unknown.length) throw bad(`The device does not list: ${unknown.join(', ')}`);
  const ins = db.prepare('INSERT OR IGNORE INTO traffic_interfaces (device_table, device_id, if_name, label, speed_mbps, counter_bits, oper_status) VALUES (?, ?, ?, ?, ?, ?, ?)');
  let added = 0;
  db.transaction(() => { for (const n of wanted) { const i = by.get(n); added += ins.run(table, d.id, n, i.alias || null, i.speedMbps, i.bits, i.status).changes; } })();
  audit(req, 'interfaces.add', null, { device: d.name, interfaces: wanted });
  res.status(201).json({ added });
}));

router.patch('/interfaces/:id', canEdit, h((req, res) => {
  const r = db.prepare('SELECT * FROM traffic_interfaces WHERE id = ?').get(Number(req.params.id));
  if (!r) throw bad('Interface not found', 404);
  const b = req.body || {}; const set = []; const args = [];
  const put = (col, v) => { set.push(`${col} = ?`); args.push(v); };
  if (b.label !== undefined) { if (b.label !== null && (typeof b.label !== 'string' || b.label.length > 80)) throw bad('The name can be up to 80 characters'); put('label', b.label ? b.label.trim() || null : null); }
  if (b.enabled !== undefined) { if (typeof b.enabled !== 'boolean') throw bad('enabled must be true or false'); put('enabled', b.enabled ? 1 : 0); }
  for (const [k, lo, hi] of [['warn_pct', 10, 99], ['crit_pct', 11, 100], ['sustain_minutes', 1, 120]]) {
    if (b[k] === undefined) continue;
    if (b[k] !== null && (!Number.isInteger(b[k]) || b[k] < lo || b[k] > hi)) throw bad(`${k.replace(/_/g, ' ')} must be a whole number from ${lo} to ${hi}, or empty for the default`);
    put(k, b[k]);
  }
  if (b.speed_mbps !== undefined) {
    if (b.speed_mbps === null) put('speed_override', 0);
    else { if (!Number.isInteger(b.speed_mbps) || b.speed_mbps < 1 || b.speed_mbps > 1_000_000) throw bad('speed must be a whole number of Mbps'); put('speed_mbps', b.speed_mbps); put('speed_override', 1); }
  }
  // what will apply: the new value, else the interface's own, else the default
  const cfg = svc.getConfig();
  const warn = (b.warn_pct !== undefined ? b.warn_pct : r.warn_pct) ?? cfg.warn_pct; const crit = (b.crit_pct !== undefined ? b.crit_pct : r.crit_pct) ?? cfg.crit_pct;
  if (crit <= warn) throw bad(`The critical level must be above the warning level (it would be ${crit}% and ${warn}%)`);
  if (!set.length) return res.json({ ok: true });
  db.prepare(`UPDATE traffic_interfaces SET ${set.join(', ')} WHERE id = ?`).run(...args, r.id);
  audit(req, 'interface.update', r.id, { interface: r.if_name, changed: Object.keys(b) });
  res.json({ ok: true });
}));

router.delete('/interfaces/:id', canEdit, h((req, res) => {
  const r = db.prepare('SELECT * FROM traffic_interfaces WHERE id = ?').get(Number(req.params.id));
  if (!r) throw bad('Interface not found', 404);
  db.prepare('DELETE FROM traffic_interfaces WHERE id = ?').run(r.id);
  audit(req, 'interface.remove', r.id, { interface: r.if_name });
  res.json({ removed: r.if_name });
}));

router.post('/poll', canEdit, h(async (req, res) => { res.json(await svc.pollAll()); }));

router.get('/settings', canAdmin, (req, res) => res.json(svc.getConfig()));
router.put('/settings', canAdmin, h((req, res) => {
  const c = svc.saveConfig(req.body || {}); svc.reload();
  writeAuditLog({ user_id: req.user.id, username: req.user.username, action: 'traffic.settings', module: 'traffic', details: c, ip_address: req.ip });
  res.json(c);
}));

// what the device last answered, to see which field a value comes from
router.get('/raw/:table/:id', canAdmin, h((req, res) => {
  const r = svc.rawOf(req.params.table, req.params.id);
  if (!r) throw bad('Nothing has been read from this device yet', 404);
  res.json(r);
}));

module.exports = router;
