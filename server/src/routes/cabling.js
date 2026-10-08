'use strict';

const express = require('express');
const net = require('net');
const db = require('../db/database');
const { requireAuth, requireRole } = require('../middleware/auth');
const { writeAuditLog } = require('../middleware/audit');
const cat = require('../services/cabling/catalog');
const { InputError, normalizeGroups, expandPortGroups, assertNoDuplicateNames, insertPorts } = require('../services/cabling/ports');
const { liveFor } = require('../services/cabling/live');
const { parseNetworks, buildMatcher } = require('../services/cabling/networks');
const engine = require('../services/cabling/trace');

const router = express.Router();
router.use(requireAuth);

const canEdit = requireRole('superadmin', 'admin', 'operator');
const canDelete = requireRole('superadmin', 'admin');
const canAdmin = requireRole('superadmin', 'admin');

// ── helpers ────────────────────────────────────────────────────────────────

const setting = (key, fallback = '') => db.prepare('SELECT value FROM settings WHERE key = ?').get(key)?.value ?? fallback;
const isEnabled = () => !['false', '0', 'off'].includes(String(setting('cabling_enabled', 'true')).toLowerCase());
const networks = () => parseNetworks(setting('cabling_allowed_networks'));
function isAllowed(req) {
  const list = networks();
  if (!list.length) return true;
  try { return buildMatcher(list)(req.ip); } catch { return true; } // a broken stored list must not lock everyone out
}

const audit = (req, action, type, id, details) => writeAuditLog({ user_id: req.user.id, username: req.user.username, action: `cabling.${action}`, entity_type: type, entity_id: id, module: 'cabling', details, ip_address: req.ip });

/** Runs a handler and turns validation and constraint problems into readable 4xx answers. */
const h = (fn) => (req, res) => {
  try {
    fn(req, res);
  } catch (err) {
    if (err instanceof InputError) return res.status(err.status).json({ error: err.message });
    if (err.code === 'SQLITE_CONSTRAINT_TRIGGER' || /already connected/.test(err.message || '')) return res.status(409).json({ error: 'That port side is already connected' });
    if (err.code === 'SQLITE_CONSTRAINT_UNIQUE') return res.status(409).json({ error: /name/i.test(err.message) ? 'That name is already used' : 'That value is already used' });
    if (err.code === 'SQLITE_CONSTRAINT_FOREIGNKEY') return res.status(400).json({ error: 'A referenced item does not exist' });
    if (err.code === 'SQLITE_CONSTRAINT_CHECK') return res.status(400).json({ error: 'A value is not allowed' });
    console.error('[cabling]', err);
    res.status(500).json({ error: 'Internal error' });
  }
};

const str = (v, max = 200) => { const s = v === undefined || v === null ? '' : String(v).trim(); if (s.length > max) throw new InputError(`Text is too long (at most ${max} characters)`); return s || null; };
const name = (v, label = 'Name') => { const s = str(v, 80); if (!s) throw new InputError(`${label} is required`); return s; };
const int = (v, label, { min = null, max = null } = {}) => {
  if (v === undefined || v === null || v === '') return null;
  const n = Number(v);
  if (!Number.isInteger(n) || (min !== null && n < min) || (max !== null && n > max)) throw new InputError(`${label} must be a whole number${min !== null && max !== null ? ` between ${min} and ${max}` : ''}`);
  return n;
};
const need = (row, what = 'Item') => { if (!row) throw new InputError(`${what} not found`, 404); return row; };

// ── module switch and access (reachable even when the module is off, so an admin can switch it back on) ──

router.get('/status', (req, res) => res.json({ enabled: isEnabled(), allowed: isAllowed(req) }));

router.get('/settings', canAdmin, (req, res) => res.json({ enabled: isEnabled(), allowed_networks: networks(), your_ip: req.ip }));

router.put('/settings', canAdmin, h((req, res) => {
  const { enabled, allowed_networks: list } = req.body || {};
  if (enabled !== undefined && typeof enabled !== 'boolean') throw new InputError('enabled must be true or false');
  if (list !== undefined) {
    if (!Array.isArray(list) || list.length > 50) throw new InputError('allowed_networks must be a list of up to 50 networks');
    const clean = list.map((x) => String(x).trim()).filter(Boolean);
    let match;
    try { match = clean.length ? buildMatcher(clean) : null; } catch (e) { throw new InputError(e.message); }
    // never let the administrator lock themselves out with a typo
    if (match && !match(req.ip)) throw new InputError(`These networks do not include your own address (${req.ip}); saving them would lock you out`);
    db.prepare("INSERT INTO settings (key, value, updated_at) VALUES ('cabling_allowed_networks', ?, datetime('now')) ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = datetime('now')").run(clean.join(', '));
  }
  if (enabled !== undefined) db.prepare("INSERT INTO settings (key, value, updated_at) VALUES ('cabling_enabled', ?, datetime('now')) ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = datetime('now')").run(enabled ? 'true' : 'false');
  audit(req, 'settings.update', 'cabling', null, { enabled, allowed_networks: list });
  res.json({ enabled: isEnabled(), allowed_networks: networks(), your_ip: req.ip });
}));

// everything below needs the module on and the caller inside the allowed networks
router.use((req, res, next) => {
  if (!isEnabled()) return res.status(404).json({ error: 'The cabling module is switched off (Settings)' });
  if (!isAllowed(req)) return res.status(403).json({ error: 'The cabling module can only be used from the allowed networks' });
  next();
});

router.get('/catalog', (req, res) => res.json(cat.catalog()));

router.get('/summary', (req, res) => {
  const c = (t, w = '') => db.prepare(`SELECT COUNT(*) c FROM ${t} ${w}`).get().c;
  res.json({ rooms: c('cab_rooms'), offices: c('cab_offices'), racks: c('cab_racks'), devices: c('cab_devices'), ports: c('cab_ports'), templates: c('cab_device_templates'), outlets: c('cab_ports', "WHERE outlet_label IS NOT NULL AND outlet_label != ''") });
});

// ── building blocks of a device view ───────────────────────────────────────

// A port's colour and what is plugged into it come from the trace engine (one read of the whole inventory per request).
function attachPorts(devices, graph) {
  if (!devices.length) return devices;
  const g = graph || engine.loadGraph(db);
  const ids = devices.map((d) => d.id);
  const rows = db.prepare(`SELECT p.*, o.name AS office_name FROM cab_ports p LEFT JOIN cab_offices o ON o.id = p.office_id WHERE p.device_id IN (${ids.map(() => '?').join(',')}) ORDER BY p.device_id, p.sort_order, p.id`).all(...ids);
  const by = new Map(ids.map((i) => [i, []]));
  for (const p of rows) by.get(p.device_id).push({ ...p, poe: !!p.poe, status: engine.classify(g, p.id), connections: engine.connections(g, p.id) });
  return devices.map((d) => ({ ...d, ports: by.get(d.id), live: d.linked_kind ? liveFor(d.linked_kind, d.linked_id) : null }));
}

const DEVICE_SELECT = `SELECT d.*, r.name AS room_name, o.name AS office_name, k.name AS rack_name, k.height_u AS rack_height
  FROM cab_devices d LEFT JOIN cab_rooms r ON r.id = d.room_id LEFT JOIN cab_offices o ON o.id = d.office_id LEFT JOIN cab_racks k ON k.id = d.rack_id`;
const oneDevice = (id) => attachPorts(db.prepare(`${DEVICE_SELECT} WHERE d.id = ?`).all(id))[0];

// ── rooms ──────────────────────────────────────────────────────────────────

router.get('/rooms', (req, res) => {
  res.json({
    rooms: db.prepare(`SELECT r.*,
      (SELECT COUNT(*) FROM cab_racks k WHERE k.room_id = r.id) AS racks,
      (SELECT COUNT(*) FROM cab_devices d WHERE d.room_id = r.id) AS devices,
      (SELECT COUNT(*) FROM cab_ports p JOIN cab_devices d ON d.id = p.device_id WHERE d.room_id = r.id) AS ports
      FROM cab_rooms r ORDER BY r.name`).all(),
  });
});

router.post('/rooms', canEdit, h((req, res) => {
  const b = req.body || {};
  const r = db.prepare('INSERT INTO cab_rooms (name, location, floor, notes) VALUES (?,?,?,?)').run(name(b.name), str(b.location), str(b.floor, 40), str(b.notes, 1000));
  audit(req, 'room.create', 'cab_room', r.lastInsertRowid, { name: b.name });
  res.status(201).json({ room: db.prepare('SELECT * FROM cab_rooms WHERE id = ?').get(r.lastInsertRowid) });
}));

router.get('/rooms/:id', h((req, res) => {
  const room = need(db.prepare('SELECT * FROM cab_rooms WHERE id = ?').get(req.params.id), 'Room');
  const racks = db.prepare('SELECT * FROM cab_racks WHERE room_id = ? ORDER BY name').all(room.id);
  const devices = attachPorts(db.prepare(`${DEVICE_SELECT} WHERE d.room_id = ? ORDER BY d.rack_position DESC, d.name`).all(room.id));
  // wall outlets exist on copper patch panels; a fibre panel's ports run to another room, not to an outlet
  const panelPorts = devices.filter((d) => d.device_type === 'patch_panel').flatMap((d) => d.ports);
  const outletPorts = panelPorts.filter((p) => p.outlet_label || p.office_id);
  const switchPorts = devices.filter((d) => d.device_type === 'switch').flatMap((d) => d.ports);
  const trunks = trunksOf(room.id);
  const fiber = trunks.filter((t) => t.medium === 'fiber');
  res.json({
    room, racks, devices, trunks,
    summary: {
      devices: devices.length, racks: racks.length, ports: devices.reduce((a, d) => a + d.ports.length, 0), panel_ports: panelPorts.length,
      outlets: outletPorts.length, outlets_active: outletPorts.filter((p) => p.connections.front).length, outlets_spare: outletPorts.filter((p) => !p.connections.front).length,
      switch_ports: switchPorts.length, switch_ports_used: switchPorts.filter((p) => p.connections.front).length,
      fiber_strands: fiber.reduce((a, t) => a + t.strand_count, 0), fiber_strands_used: fiber.reduce((a, t) => a + t.used_strands, 0),
    },
  });
}));

router.put('/rooms/:id', canEdit, h((req, res) => {
  const cur = need(db.prepare('SELECT * FROM cab_rooms WHERE id = ?').get(req.params.id), 'Room');
  const b = req.body || {};
  db.prepare("UPDATE cab_rooms SET name = ?, location = ?, floor = ?, notes = ?, updated_at = datetime('now') WHERE id = ?")
    .run(name(b.name ?? cur.name), str(b.location ?? cur.location), str(b.floor ?? cur.floor, 40), str(b.notes ?? cur.notes, 1000), cur.id);
  audit(req, 'room.update', 'cab_room', cur.id, { name: b.name ?? cur.name });
  res.json({ room: db.prepare('SELECT * FROM cab_rooms WHERE id = ?').get(cur.id) });
}));

router.delete('/rooms/:id', canDelete, h((req, res) => {
  const cur = need(db.prepare('SELECT * FROM cab_rooms WHERE id = ?').get(req.params.id), 'Room');
  const devices = db.prepare('SELECT COUNT(*) c FROM cab_devices WHERE room_id = ?').get(cur.id).c;
  db.transaction(() => {
    db.prepare('UPDATE cab_devices SET rack_id = NULL, rack_position = NULL WHERE room_id = ?').run(cur.id); // they stay in the inventory, without a place
    db.prepare('DELETE FROM cab_rooms WHERE id = ?').run(cur.id);
  })();
  audit(req, 'room.delete', 'cab_room', cur.id, { name: cur.name, devices_left_without_room: devices });
  res.json({ ok: true, devices_left_without_room: devices });
}));

// ── racks ──────────────────────────────────────────────────────────────────

router.post('/rooms/:id/racks', canEdit, h((req, res) => {
  const room = need(db.prepare('SELECT id FROM cab_rooms WHERE id = ?').get(req.params.id), 'Room');
  const b = req.body || {};
  const r = db.prepare('INSERT INTO cab_racks (room_id, name, height_u, notes) VALUES (?,?,?,?)').run(room.id, name(b.name), int(b.height_u ?? 42, 'Height', { min: 1, max: 60 }), str(b.notes, 1000));
  audit(req, 'rack.create', 'cab_rack', r.lastInsertRowid, { room_id: room.id, name: b.name });
  res.status(201).json({ rack: db.prepare('SELECT * FROM cab_racks WHERE id = ?').get(r.lastInsertRowid) });
}));

router.put('/racks/:id', canEdit, h((req, res) => {
  const cur = need(db.prepare('SELECT * FROM cab_racks WHERE id = ?').get(req.params.id), 'Rack');
  const b = req.body || {};
  const height = int(b.height_u ?? cur.height_u, 'Height', { min: 1, max: 60 });
  const tooHigh = db.prepare('SELECT name, rack_position FROM cab_devices WHERE rack_id = ? AND rack_position > ? LIMIT 1').get(cur.id, height);
  if (tooHigh) throw new InputError(`${tooHigh.name} sits at U${tooHigh.rack_position}, above the new height of ${height} U`);
  db.prepare("UPDATE cab_racks SET name = ?, height_u = ?, notes = ?, updated_at = datetime('now') WHERE id = ?").run(name(b.name ?? cur.name), height, str(b.notes ?? cur.notes, 1000), cur.id);
  audit(req, 'rack.update', 'cab_rack', cur.id, { name: b.name ?? cur.name, height_u: height });
  res.json({ rack: db.prepare('SELECT * FROM cab_racks WHERE id = ?').get(cur.id) });
}));

router.delete('/racks/:id', canDelete, h((req, res) => {
  const cur = need(db.prepare('SELECT * FROM cab_racks WHERE id = ?').get(req.params.id), 'Rack');
  db.transaction(() => {
    db.prepare('UPDATE cab_devices SET rack_position = NULL WHERE rack_id = ?').run(cur.id);
    db.prepare('DELETE FROM cab_racks WHERE id = ?').run(cur.id);
  })();
  audit(req, 'rack.delete', 'cab_rack', cur.id, { name: cur.name });
  res.json({ ok: true });
}));

// ── offices ────────────────────────────────────────────────────────────────

router.get('/offices', (req, res) => {
  res.json({
    offices: db.prepare(`SELECT o.*,
      (SELECT COUNT(*) FROM cab_devices d WHERE d.office_id = o.id) AS devices,
      (SELECT COUNT(*) FROM cab_ports p WHERE p.office_id = o.id) AS outlets
      FROM cab_offices o ORDER BY o.name`).all(),
  });
});

router.post('/offices', canEdit, h((req, res) => {
  const b = req.body || {};
  const r = db.prepare('INSERT INTO cab_offices (name, floor, notes) VALUES (?,?,?)').run(name(b.name), str(b.floor, 40), str(b.notes, 1000));
  audit(req, 'office.create', 'cab_office', r.lastInsertRowid, { name: b.name });
  res.status(201).json({ office: db.prepare('SELECT * FROM cab_offices WHERE id = ?').get(r.lastInsertRowid) });
}));

router.get('/offices/:id', h((req, res) => {
  const office = need(db.prepare('SELECT * FROM cab_offices WHERE id = ?').get(req.params.id), 'Office');
  const devices = attachPorts(db.prepare(`${DEVICE_SELECT} WHERE d.office_id = ? ORDER BY d.name`).all(office.id));
  const outlets = db.prepare(`SELECT p.id AS port_id, p.name AS port_name, p.outlet_label, d.id AS device_id, d.name AS device_name, r.id AS room_id, r.name AS room_name, k.name AS rack_name
    FROM cab_ports p JOIN cab_devices d ON d.id = p.device_id LEFT JOIN cab_rooms r ON r.id = d.room_id LEFT JOIN cab_racks k ON k.id = d.rack_id
    WHERE p.office_id = ? ORDER BY p.outlet_label, d.name, p.sort_order`).all(office.id);
  res.json({ office, devices, outlets });
}));

router.put('/offices/:id', canEdit, h((req, res) => {
  const cur = need(db.prepare('SELECT * FROM cab_offices WHERE id = ?').get(req.params.id), 'Office');
  const b = req.body || {};
  db.prepare("UPDATE cab_offices SET name = ?, floor = ?, notes = ?, updated_at = datetime('now') WHERE id = ?").run(name(b.name ?? cur.name), str(b.floor ?? cur.floor, 40), str(b.notes ?? cur.notes, 1000), cur.id);
  audit(req, 'office.update', 'cab_office', cur.id, { name: b.name ?? cur.name });
  res.json({ office: db.prepare('SELECT * FROM cab_offices WHERE id = ?').get(cur.id) });
}));

router.delete('/offices/:id', canDelete, h((req, res) => {
  const cur = need(db.prepare('SELECT * FROM cab_offices WHERE id = ?').get(req.params.id), 'Office');
  db.prepare('DELETE FROM cab_offices WHERE id = ?').run(cur.id); // devices and outlet labels stay, without the office
  audit(req, 'office.delete', 'cab_office', cur.id, { name: cur.name });
  res.json({ ok: true });
}));

// ── templates ──────────────────────────────────────────────────────────────

const templateGroups = (id) => db.prepare('SELECT prefix, start_no, end_no, port_type, speed, poe, role, connector FROM cab_template_port_groups WHERE template_id = ? ORDER BY sort_order, id').all(id).map((g) => ({ ...g, poe: !!g.poe }));
const templateView = (t) => { const groups = templateGroups(t.id); return { ...t, groups, port_count: groups.reduce((a, g) => a + g.end_no - g.start_no + 1, 0) }; };

function writeTemplate(id, groups) {
  db.prepare('DELETE FROM cab_template_port_groups WHERE template_id = ?').run(id);
  const ins = db.prepare('INSERT INTO cab_template_port_groups (template_id, prefix, start_no, end_no, port_type, speed, poe, role, connector, sort_order) VALUES (?,?,?,?,?,?,?,?,?,?)');
  groups.forEach((g, i) => ins.run(id, g.prefix, g.start_no, g.end_no, g.port_type, g.speed, g.poe, g.role, g.connector, i));
}

function templateFields(b, cur = {}) {
  const device_type = b.device_type ?? cur.device_type;
  if (!cat.oneOf(cat.DEVICE_TYPES, device_type)) throw new InputError('Choose a device type');
  return { name: name(b.name ?? cur.name), device_type, manufacturer: str(b.manufacturer ?? cur.manufacturer, 80), model: str(b.model ?? cur.model, 80), notes: str(b.notes ?? cur.notes, 1000) };
}

router.get('/templates', (req, res) => res.json({ templates: db.prepare('SELECT * FROM cab_device_templates ORDER BY name').all().map(templateView) }));

router.get('/templates/:id', h((req, res) => res.json({ template: templateView(need(db.prepare('SELECT * FROM cab_device_templates WHERE id = ?').get(req.params.id), 'Template')) })));

router.post('/templates', canEdit, h((req, res) => {
  const b = req.body || {};
  const f = templateFields(b);
  const groups = normalizeGroups(b.groups || []);
  const id = db.transaction(() => {
    const r = db.prepare('INSERT INTO cab_device_templates (name, device_type, manufacturer, model, notes) VALUES (?,?,?,?,?)').run(f.name, f.device_type, f.manufacturer, f.model, f.notes);
    writeTemplate(r.lastInsertRowid, groups);
    return r.lastInsertRowid;
  })();
  audit(req, 'template.create', 'cab_template', id, { name: f.name, groups: groups.length });
  res.status(201).json({ template: templateView(db.prepare('SELECT * FROM cab_device_templates WHERE id = ?').get(id)) });
}));

router.put('/templates/:id', canEdit, h((req, res) => {
  const cur = need(db.prepare('SELECT * FROM cab_device_templates WHERE id = ?').get(req.params.id), 'Template');
  const b = req.body || {};
  const f = templateFields(b, cur);
  const groups = b.groups !== undefined ? normalizeGroups(b.groups) : null;
  db.transaction(() => {
    db.prepare("UPDATE cab_device_templates SET name = ?, device_type = ?, manufacturer = ?, model = ?, notes = ?, updated_at = datetime('now') WHERE id = ?").run(f.name, f.device_type, f.manufacturer, f.model, f.notes, cur.id);
    if (groups) writeTemplate(cur.id, groups);
  })();
  audit(req, 'template.update', 'cab_template', cur.id, { name: f.name });
  res.json({ template: templateView(db.prepare('SELECT * FROM cab_device_templates WHERE id = ?').get(cur.id)) });
}));

router.delete('/templates/:id', canDelete, h((req, res) => {
  const cur = need(db.prepare('SELECT * FROM cab_device_templates WHERE id = ?').get(req.params.id), 'Template');
  db.prepare('DELETE FROM cab_device_templates WHERE id = ?').run(cur.id); // devices keep their ports
  audit(req, 'template.delete', 'cab_template', cur.id, { name: cur.name });
  res.json({ ok: true });
}));

// ── devices ────────────────────────────────────────────────────────────────

const IP_OK = (v) => /^dhcp$/i.test(v) || net.isIP(v) !== 0;

/** Checks a device (create: all fields; update: `cur` supplies what is not sent) and returns the row values. */
function deviceFields(b, cur = {}) {
  const pick = (k) => (k in b ? b[k] : cur[k]);
  const v = {
    name: name(pick('name')),
    device_type: pick('device_type'), purpose: pick('purpose') || 'production',
    room_id: int(pick('room_id'), 'Room'), office_id: int(pick('office_id'), 'Office'),
    rack_id: int(pick('rack_id'), 'Rack'), rack_position: int(pick('rack_position'), 'Rack position', { min: 1, max: 60 }),
    template_id: int(pick('template_id'), 'Template'),
    manufacturer: str(pick('manufacturer'), 80), model: str(pick('model'), 80), serial_number: str(pick('serial_number'), 80), notes: str(pick('notes'), 1000),
    ip_address: str(pick('ip_address'), 45), mac_address: str(pick('mac_address'), 17),
    linked_kind: pick('linked_kind') || null, linked_id: int(pick('linked_id'), 'Linked item'),
  };
  if (!cat.oneOf(cat.DEVICE_TYPES, v.device_type)) throw new InputError('Choose a device type');
  if (!cat.oneOf(cat.PURPOSES, v.purpose)) throw new InputError('Choose a purpose');
  if (v.room_id && v.office_id) throw new InputError('A device is either in a room or in an office, not both');
  if (v.room_id) need(db.prepare('SELECT id FROM cab_rooms WHERE id = ?').get(v.room_id), 'Room');
  if (v.office_id) need(db.prepare('SELECT id FROM cab_offices WHERE id = ?').get(v.office_id), 'Office');
  if (v.template_id) need(db.prepare('SELECT id FROM cab_device_templates WHERE id = ?').get(v.template_id), 'Template');
  if (v.rack_id) {
    const rack = need(db.prepare('SELECT * FROM cab_racks WHERE id = ?').get(v.rack_id), 'Rack');
    if (rack.room_id !== v.room_id) throw new InputError('That rack is not in the chosen room');
    if (v.rack_position && v.rack_position > rack.height_u) throw new InputError(`${rack.name} is only ${rack.height_u} U high`);
  } else {
    v.rack_position = null;
  }
  if (v.ip_address && !IP_OK(v.ip_address)) throw new InputError('IP address must be an IPv4/IPv6 address or DHCP');
  if (v.mac_address) {
    if (!/^[0-9a-f]{2}([:-][0-9a-f]{2}){5}$/i.test(v.mac_address)) throw new InputError('MAC address looks like 84:39:8f:d2:86:40');
    v.mac_address = v.mac_address.toLowerCase().replace(/-/g, ':');
  }
  if (v.linked_kind || v.linked_id) {
    if (!cat.LINK_KINDS.includes(v.linked_kind) || !v.linked_id) throw new InputError('Choose what this device is linked to in InfraLoom');
    if (liveFor(v.linked_kind, v.linked_id).state === 'missing') throw new InputError('The linked InfraLoom item does not exist');
  }
  return v;
}

const DEVICE_COLS = ['name', 'device_type', 'purpose', 'room_id', 'office_id', 'rack_id', 'rack_position', 'template_id', 'manufacturer', 'model', 'serial_number', 'notes', 'ip_address', 'mac_address', 'linked_kind', 'linked_id'];

router.get('/devices', (req, res) => {
  const w = []; const a = [];
  const { room_id: room, office_id: office, type, purpose, q } = req.query;
  if (room) { w.push('d.room_id = ?'); a.push(Number(room)); }
  if (office) { w.push('d.office_id = ?'); a.push(Number(office)); }
  if (type) { w.push('d.device_type = ?'); a.push(String(type)); }
  if (purpose) { w.push('d.purpose = ?'); a.push(String(purpose)); }
  if (q) { const like = `%${String(q).replace(/[\\%_]/g, '\\$&')}%`; w.push("(d.name LIKE ? ESCAPE '\\' OR d.ip_address LIKE ? ESCAPE '\\' OR d.serial_number LIKE ? ESCAPE '\\' OR d.model LIKE ? ESCAPE '\\')"); a.push(like, like, like, like); }
  const rows = db.prepare(`${DEVICE_SELECT} ${w.length ? `WHERE ${w.join(' AND ')}` : ''} ORDER BY d.name`).all(...a);
  const counts = new Map(db.prepare('SELECT device_id, COUNT(*) c FROM cab_ports GROUP BY device_id').all().map((r) => [r.device_id, r.c]));
  res.json({ devices: rows.map((d) => ({ ...d, port_count: counts.get(d.id) || 0, live: d.linked_kind ? liveFor(d.linked_kind, d.linked_id) : null })) });
});

router.post('/devices', canEdit, h((req, res) => {
  const b = req.body || {};
  const v = deviceFields(b);
  let groups;
  if (b.groups !== undefined) groups = normalizeGroups(b.groups);
  else if (v.template_id) groups = templateGroups(v.template_id).map((g) => ({ ...g, poe: g.poe ? 1 : 0 }));
  else groups = [];
  const ports = expandPortGroups(groups);
  assertNoDuplicateNames(ports);
  const saveAs = str(b.save_as_template, 80);
  if (saveAs && !groups.length) throw new InputError('Add at least one port group before saving a template');

  const { id, templateId } = db.transaction(() => {
    let tpl = v.template_id;
    if (saveAs) {
      const t = db.prepare('INSERT INTO cab_device_templates (name, device_type, manufacturer, model, notes) VALUES (?,?,?,?,NULL)').run(saveAs, v.device_type, v.manufacturer, v.model);
      writeTemplate(t.lastInsertRowid, groups);
      tpl = t.lastInsertRowid;
    }
    const r = db.prepare(`INSERT INTO cab_devices (${DEVICE_COLS.join(', ')}) VALUES (${DEVICE_COLS.map((c) => `@${c}`).join(', ')})`).run({ ...v, template_id: tpl });
    insertPorts(db, r.lastInsertRowid, ports);
    return { id: r.lastInsertRowid, templateId: tpl };
  })();
  audit(req, 'device.create', 'cab_device', id, { name: v.name, type: v.device_type, ports: ports.length, template_id: templateId });
  res.status(201).json({ device: oneDevice(id) });
}));

router.get('/devices/:id', h((req, res) => res.json({ device: need(oneDevice(req.params.id), 'Device') })));

router.put('/devices/:id', canEdit, h((req, res) => {
  const cur = need(db.prepare('SELECT * FROM cab_devices WHERE id = ?').get(req.params.id), 'Device');
  const v = deviceFields(req.body || {}, cur);
  db.prepare(`UPDATE cab_devices SET ${DEVICE_COLS.map((c) => `${c} = @${c}`).join(', ')}, updated_at = datetime('now') WHERE id = @id`).run({ ...v, id: cur.id });
  const changed = Object.fromEntries(DEVICE_COLS.filter((c) => (v[c] ?? null) !== (cur[c] ?? null)).map((c) => [c, { from: cur[c] ?? null, to: v[c] ?? null }]));
  audit(req, 'device.update', 'cab_device', cur.id, { name: v.name, changed });
  res.json({ device: oneDevice(cur.id) });
}));

router.delete('/devices/:id', canDelete, h((req, res) => {
  const cur = need(db.prepare('SELECT * FROM cab_devices WHERE id = ?').get(req.params.id), 'Device');
  const ports = db.prepare('SELECT COUNT(*) c FROM cab_ports WHERE device_id = ?').get(cur.id).c;
  db.prepare('DELETE FROM cab_devices WHERE id = ?').run(cur.id); // its ports (and their links) go with it
  audit(req, 'device.delete', 'cab_device', cur.id, { name: cur.name, ports });
  res.json({ ok: true });
}));

// add more ports to an existing device
router.post('/devices/:id/ports', canEdit, h((req, res) => {
  const dev = need(db.prepare('SELECT id, name FROM cab_devices WHERE id = ?').get(req.params.id), 'Device');
  const groups = normalizeGroups((req.body || {}).groups || []);
  if (!groups.length) throw new InputError('Add at least one port group');
  const existing = db.prepare('SELECT name, sort_order FROM cab_ports WHERE device_id = ?').all(dev.id);
  const ports = expandPortGroups(groups, Math.max(0, ...existing.map((p) => p.sort_order)));
  assertNoDuplicateNames(ports, existing.map((p) => p.name));
  if (existing.length + ports.length > 512) throw new InputError('A device can have at most 512 ports');
  db.transaction(() => insertPorts(db, dev.id, ports))();
  audit(req, 'port.add', 'cab_device', dev.id, { name: dev.name, added: ports.length });
  res.status(201).json({ device: oneDevice(dev.id) });
}));

// ── ports ──────────────────────────────────────────────────────────────────

router.put('/ports/:id', canEdit, h((req, res) => {
  const cur = need(db.prepare('SELECT * FROM cab_ports WHERE id = ?').get(req.params.id), 'Port');
  const b = req.body || {};
  const pick = (k) => (k in b ? b[k] : cur[k]);
  const port_type = pick('port_type');
  if (!cat.oneOf(cat.PORT_TYPES, port_type)) throw new InputError('Unknown port type');
  const speed = pick('speed') || null; if (speed && !cat.SPEEDS.includes(speed)) throw new InputError('Unknown speed');
  const role = pick('role') || null; if (role && !cat.oneOf(cat.PORT_ROLES, role)) throw new InputError('Unknown role');
  const connector = pick('connector') || null; if (connector && !cat.CONNECTORS.includes(connector)) throw new InputError('Unknown connector');
  const office_id = int(pick('office_id'), 'Office');
  if (office_id) need(db.prepare('SELECT id FROM cab_offices WHERE id = ?').get(office_id), 'Office');
  const pname = name(pick('name'), 'Port name');
  const outlet = str(pick('outlet_label'), 40);
  const rearType = pick('rear_cable_type') || null;
  if (rearType && !cat.CABLE_TYPES.includes(rearType)) throw new InputError('Unknown cable type');
  const rearLen = pick('rear_length_m') === '' || pick('rear_length_m') === undefined ? null : pick('rear_length_m');
  if (rearLen !== null && !(Number(rearLen) > 0 && Number(rearLen) <= 100000)) throw new InputError('Cable length must be a number of metres above 0');
  if (office_id || outlet || rearType || rearLen !== null) {
    const d = db.prepare('SELECT device_type FROM cab_devices WHERE id = ?').get(cur.device_id);
    if (d.device_type !== 'patch_panel') throw new InputError('Wall outlets and the permanent cable can only be recorded on patch-panel ports');
  }
  db.prepare("UPDATE cab_ports SET name = ?, port_type = ?, speed = ?, poe = ?, role = ?, transceiver = ?, connector = ?, office_id = ?, outlet_label = ?, rear_cable_type = ?, rear_length_m = ?, notes = ?, updated_at = datetime('now') WHERE id = ?")
    .run(pname, port_type, speed, pick('poe') ? 1 : 0, role, str(pick('transceiver'), 80), connector, office_id, outlet, rearType, rearLen === null ? null : Number(rearLen), str(pick('notes'), 1000), cur.id);
  audit(req, 'port.update', 'cab_port', cur.id, { device_id: cur.device_id, name: pname, outlet_label: pick('outlet_label') || null, office_id });
  const g = engine.loadGraph(db);
  const row = db.prepare('SELECT p.*, o.name AS office_name FROM cab_ports p LEFT JOIN cab_offices o ON o.id = p.office_id WHERE p.id = ?').get(cur.id);
  res.json({ port: { ...row, poe: !!row.poe, status: engine.classify(g, row.id), connections: engine.connections(g, row.id) } });
}));

router.delete('/ports/:id', canDelete, h((req, res) => {
  const cur = need(db.prepare('SELECT * FROM cab_ports WHERE id = ?').get(req.params.id), 'Port');
  db.prepare('DELETE FROM cab_ports WHERE id = ?').run(cur.id);
  audit(req, 'port.delete', 'cab_port', cur.id, { device_id: cur.device_id, name: cur.name });
  res.json({ ok: true });
}));

// ── trunk cables (fibre or copper runs between two rooms) ──────────────────

const TRUNK_SELECT = `SELECT t.*, a.name AS room_a_name, b.name AS room_b_name FROM cab_trunk_cables t JOIN cab_rooms a ON a.id = t.room_a_id JOIN cab_rooms b ON b.id = t.room_b_id`;
const MAX_STRANDS = 288;

/** "1-2", "1,2", "3", "1-2, 5-6" -> [1, 2, 5, 6] */
function parseStrands(text) {
  const out = new Set();
  for (const part of String(text ?? '').split(/[,;\s]+/).filter(Boolean)) {
    const m = /^(\d+)(?:-(\d+))?$/.exec(part);
    if (!m) throw new InputError(`Strands look like 1-2 or 3,4 (got "${part}")`);
    const a = Number(m[1]), b = m[2] === undefined ? a : Number(m[2]);
    if (b < a || b - a > MAX_STRANDS) throw new InputError(`The strand range "${part}" is not valid`);
    for (let n = a; n <= b; n++) out.add(n);
  }
  return [...out].sort((x, y) => x - y);
}

function formatStrands(nums) {
  const parts = [];
  for (let i = 0; i < nums.length; i++) {
    let j = i;
    while (j + 1 < nums.length && nums[j + 1] === nums[j] + 1) j++;
    parts.push(j > i ? `${nums[i]}-${nums[j]}` : `${nums[i]}`);
    i = j;
  }
  return parts.join(',');
}

function usedStrands(trunkId, exceptLinkId = null) {
  const used = new Set();
  for (const r of db.prepare('SELECT id, strands FROM cab_links WHERE trunk_cable_id = ? AND strands IS NOT NULL').all(trunkId)) {
    if (r.id === exceptLinkId) continue;
    try { parseStrands(r.strands).forEach((n) => used.add(n)); } catch { /* an unreadable value uses nothing */ }
  }
  return used;
}

/** A duplex fibre link uses 2 strands, a copper link 1 pair. A requested choice is checked; otherwise the lowest free one is taken
 * (standard pairs 1-2, 3-4 first). */
function resolveStrands(trunk, requested, exceptLinkId = null) {
  const need2 = trunk.medium === 'fiber' ? 2 : 1;
  const used = usedStrands(trunk.id, exceptLinkId);
  let nums;
  if (requested !== undefined && requested !== null && String(requested).trim() !== '') {
    nums = parseStrands(requested);
    if (nums.length !== need2) throw new InputError(need2 === 2 ? 'A duplex fibre link uses 2 strands (for example 1-2)' : 'A copper link uses 1 pair (for example 5)');
    const missing = nums.find((n) => n < 1 || n > trunk.strand_count);
    if (missing) throw new InputError(`Strand ${missing} does not exist: ${trunk.name} has ${trunk.strand_count}`);
    const taken = nums.filter((n) => used.has(n));
    if (taken.length) throw new InputError(`Strand ${taken.join(', ')} is already used on ${trunk.name}`, 409);
  } else {
    nums = null;
    if (need2 === 2) {
      for (let s = 1; !nums && s + 1 <= trunk.strand_count; s += 2) if (!used.has(s) && !used.has(s + 1)) nums = [s, s + 1];
      for (let s = 1; !nums && s + 1 <= trunk.strand_count; s += 1) if (!used.has(s) && !used.has(s + 1)) nums = [s, s + 1];
    } else {
      for (let s = 1; !nums && s <= trunk.strand_count; s++) if (!used.has(s)) nums = [s];
    }
    if (!nums) throw new InputError(`${trunk.name} has no free strands left`, 409);
  }
  return formatStrands(nums);
}

const LINK_SELECT = `SELECT l.*, t.name AS trunk_name,
  pa.name AS port_a_name, da.id AS device_a_id, da.name AS device_a_name, da.room_id AS room_a_id,
  pb.name AS port_b_name, db_.id AS device_b_id, db_.name AS device_b_name, db_.room_id AS room_b_id
  FROM cab_links l JOIN cab_ports pa ON pa.id = l.port_a_id JOIN cab_devices da ON da.id = pa.device_id
  JOIN cab_ports pb ON pb.id = l.port_b_id JOIN cab_devices db_ ON db_.id = pb.device_id
  LEFT JOIN cab_trunk_cables t ON t.id = l.trunk_cable_id`;
const linkView = (id) => db.prepare(`${LINK_SELECT} WHERE l.id = ?`).get(id);

function trunkView(t, withLinks = false) {
  const used = [...usedStrands(t.id)].sort((a, b) => a - b);
  const out = { ...t, used_strands: used.length, strand_numbers: used };
  if (withLinks) out.links = db.prepare(`${LINK_SELECT} WHERE l.trunk_cable_id = ? ORDER BY l.strands, l.id`).all(t.id);
  return out;
}

function trunksOf(roomId) {
  return db.prepare(`${TRUNK_SELECT} WHERE t.room_a_id = ? OR t.room_b_id = ? ORDER BY t.name`).all(roomId, roomId).map((t) => ({
    ...trunkView(t, true), other_room_id: t.room_a_id === roomId ? t.room_b_id : t.room_a_id, other_room_name: t.room_a_id === roomId ? t.room_b_name : t.room_a_name,
  }));
}

function trunkFields(b, cur = {}) {
  const pick = (k) => (k in b ? b[k] : cur[k]);
  const medium = pick('medium');
  if (!['fiber', 'copper'].includes(medium)) throw new InputError('Choose fibre or copper');
  const fiber_type = medium === 'fiber' ? (pick('fiber_type') || null) : null;
  if (fiber_type && !cat.FIBER_TYPES.includes(fiber_type)) throw new InputError('Unknown fibre type');
  const room_a_id = int(pick('room_a_id'), 'First room'), room_b_id = int(pick('room_b_id'), 'Second room');
  if (!room_a_id || !room_b_id) throw new InputError('Choose the two rooms');
  if (room_a_id === room_b_id) throw new InputError('A trunk joins two different rooms');
  for (const id of [room_a_id, room_b_id]) need(db.prepare('SELECT id FROM cab_rooms WHERE id = ?').get(id), 'Room');
  const strand_count = int(pick('strand_count'), 'Number of strands', { min: 1, max: MAX_STRANDS });
  if (!strand_count) throw new InputError('Number of strands is required');
  const len = pick('length_m');
  if (len !== null && len !== undefined && len !== '' && !(Number(len) > 0 && Number(len) <= 100000)) throw new InputError('Length must be a number of metres above 0');
  return { name: name(pick('name')), room_a_id, room_b_id, medium, fiber_type, strand_count, length_m: len === null || len === undefined || len === '' ? null : Number(len), notes: str(pick('notes'), 1000) };
}

router.get('/trunks', (req, res) => {
  const rows = db.prepare(`${TRUNK_SELECT} ORDER BY t.name`).all();
  res.json({ trunks: rows.map((t) => trunkView(t, true)) });
});

router.get('/trunks/:id', h((req, res) => res.json({ trunk: trunkView(need(db.prepare(`${TRUNK_SELECT} WHERE t.id = ?`).get(req.params.id), 'Trunk cable'), true) })));

router.post('/trunks', canEdit, h((req, res) => {
  const f = trunkFields(req.body || {});
  const r = db.prepare('INSERT INTO cab_trunk_cables (name, room_a_id, room_b_id, medium, fiber_type, strand_count, length_m, notes) VALUES (@name,@room_a_id,@room_b_id,@medium,@fiber_type,@strand_count,@length_m,@notes)').run(f);
  audit(req, 'trunk.create', 'cab_trunk', r.lastInsertRowid, { name: f.name, rooms: [f.room_a_id, f.room_b_id], strands: f.strand_count });
  res.status(201).json({ trunk: trunkView(db.prepare(`${TRUNK_SELECT} WHERE t.id = ?`).get(r.lastInsertRowid), true) });
}));

router.put('/trunks/:id', canEdit, h((req, res) => {
  const cur = need(db.prepare('SELECT * FROM cab_trunk_cables WHERE id = ?').get(req.params.id), 'Trunk cable');
  const f = trunkFields(req.body || {}, cur);
  const linked = db.prepare('SELECT COUNT(*) c FROM cab_links WHERE trunk_cable_id = ?').get(cur.id).c;
  if (linked && (f.room_a_id !== cur.room_a_id || f.room_b_id !== cur.room_b_id || f.medium !== cur.medium)) throw new InputError('The rooms and the medium cannot change while links use this trunk — remove the links first', 409);
  const highest = Math.max(0, ...usedStrands(cur.id));
  if (f.strand_count < highest) throw new InputError(`Strand ${highest} is in use, so the trunk cannot have fewer than ${highest} strands`, 409);
  db.prepare("UPDATE cab_trunk_cables SET name = @name, room_a_id = @room_a_id, room_b_id = @room_b_id, medium = @medium, fiber_type = @fiber_type, strand_count = @strand_count, length_m = @length_m, notes = @notes, updated_at = datetime('now') WHERE id = @id").run({ ...f, id: cur.id });
  audit(req, 'trunk.update', 'cab_trunk', cur.id, { name: f.name, strands: f.strand_count });
  res.json({ trunk: trunkView(db.prepare(`${TRUNK_SELECT} WHERE t.id = ?`).get(cur.id), true) });
}));

router.delete('/trunks/:id', canDelete, h((req, res) => {
  const cur = need(db.prepare('SELECT * FROM cab_trunk_cables WHERE id = ?').get(req.params.id), 'Trunk cable');
  const linked = db.prepare('SELECT COUNT(*) c FROM cab_links WHERE trunk_cable_id = ?').get(cur.id).c;
  if (linked) throw new InputError(`${linked} link${linked === 1 ? ' uses' : 's use'} this trunk — remove ${linked === 1 ? 'it' : 'them'} first`, 409);
  db.prepare('DELETE FROM cab_trunk_cables WHERE id = ?').run(cur.id);
  audit(req, 'trunk.delete', 'cab_trunk', cur.id, { name: cur.name });
  res.json({ ok: true });
}));

// ── links between ports ────────────────────────────────────────────────────

const portRow = (id) => db.prepare('SELECT p.*, d.name AS device_name, d.device_type, d.room_id AS device_room_id FROM cab_ports p JOIN cab_devices d ON d.id = p.device_id WHERE p.id = ?').get(id);
const isPanelType = (t) => cat.PANEL_TYPES.includes(t);
const endName = (p, side) => `${p.device_name} ${p.name}${isPanelType(p.device_type) ? ` (${side})` : ''}`;

/** The rules of cabling: only panels have a rear side; two rears are a permanent installation; a patch cord reaches a rear only as
 * the cord from a wall outlet to a device; and a port side holds one cable. */
function checkLinkEnds(b) {
  const sa = b.side_a || 'front', sb = b.side_b || 'front';
  if (!['front', 'rear'].includes(sa) || !['front', 'rear'].includes(sb)) throw new InputError('A side is front or rear');
  const A = need(portRow(Number(b.port_a_id)), 'The first port');
  const B = need(portRow(Number(b.port_b_id)), 'The second port');
  if (A.id === B.id) throw new InputError('A port cannot be connected to itself');
  for (const [P, s] of [[A, sa], [B, sb]]) if (s === 'rear' && !isPanelType(P.device_type)) throw new InputError(`${P.device_name} is not a patch or fibre panel, so its ports have no rear side`);
  const kind = sa === 'rear' && sb === 'rear' ? 'permanent' : 'patch';
  if (b.kind && b.kind !== kind) throw new InputError(kind === 'permanent' ? 'A cable between two rear sides is a permanent installation' : 'A patch cord cannot join two rear sides — that is a permanent installation');
  if (kind === 'patch') {
    for (const [P, s, O] of [[A, sa, B], [B, sb, A]]) {
      if (s !== 'rear') continue;
      if (P.device_type !== 'patch_panel' || !(P.outlet_label || P.office_id)) throw new InputError(`A patch cord can only be plugged into the rear of a patch-panel port that has a wall outlet — record the office and outlet on ${endName(P, 'rear')} first`);
      if (isPanelType(O.device_type)) throw new InputError('The cord from a wall outlet goes to a device, not to another panel');
    }
  }
  const g = engine.loadGraph(db);
  for (const [P, s] of [[A, sa], [B, sb]]) {
    const taken = engine.connections(g, P.id)[s];
    if (taken) throw new InputError(`${endName(P, s)} is already connected to ${taken.other_device_name} ${taken.other_port_name}`, 409);
  }
  return { A, B, sa, sb, kind };
}

function checkTrunk(trunkId, { A, B, kind }, strandsInput, exceptLinkId = null) {
  if (kind !== 'permanent') throw new InputError('Only a permanent installation (rear to rear) can run over a trunk');
  const t = need(db.prepare(`${TRUNK_SELECT} WHERE t.id = ?`).get(trunkId), 'Trunk cable');
  const rooms = [A.device_room_id, B.device_room_id];
  const oneEach = (rooms[0] === t.room_a_id && rooms[1] === t.room_b_id) || (rooms[0] === t.room_b_id && rooms[1] === t.room_a_id);
  if (!oneEach) throw new InputError(`${t.name} runs between ${t.room_a_name} and ${t.room_b_name}: one panel must be in each of those rooms`);
  const okTypes = t.medium === 'fiber' ? cat.FIBER_PORT_TYPES : ['rj45'];
  if (![A, B].every((P) => okTypes.includes(P.port_type))) throw new InputError(t.medium === 'fiber' ? 'A fibre trunk joins fibre-panel ports (LC or SC duplex)' : 'A copper trunk joins RJ45 panel ports');
  return { trunk: t, strands: resolveStrands(t, strandsInput, exceptLinkId) };
}

function cableFields(b, cur = {}) {
  const pick = (k) => (k in b ? b[k] : cur[k]);
  const cable_type = pick('cable_type') || null;
  if (cable_type && !cat.CABLE_TYPES.includes(cable_type)) throw new InputError('Unknown cable type');
  const len = pick('length_m');
  if (len !== null && len !== undefined && len !== '' && !(Number(len) > 0 && Number(len) <= 100000)) throw new InputError('Length must be a number of metres above 0');
  return { cable_type, color: str(pick('color'), 20), length_m: len === null || len === undefined || len === '' ? null : Number(len), notes: str(pick('notes'), 1000) };
}

const traceOf = (portId) => engine.trace(engine.loadGraph(db), portId);

router.get('/links', (req, res) => {
  const w = []; const a = [];
  const { room_id: room, device_id: device, trunk_id: trunk } = req.query;
  if (room) { w.push('(da.room_id = ? OR db_.room_id = ?)'); a.push(Number(room), Number(room)); }
  if (device) { w.push('(da.id = ? OR db_.id = ?)'); a.push(Number(device), Number(device)); }
  if (trunk) { w.push('l.trunk_cable_id = ?'); a.push(Number(trunk)); }
  res.json({ links: db.prepare(`${LINK_SELECT} ${w.length ? `WHERE ${w.join(' AND ')}` : ''} ORDER BY l.id`).all(...a) });
});

router.post('/links', canEdit, h((req, res) => {
  const b = req.body || {};
  const ends = checkLinkEnds(b);
  const cable = cableFields(b);
  let trunk_cable_id = null; let strands = null;
  if (ends.kind === 'permanent') {
    if (b.trunk_cable_id) {
      const r = checkTrunk(Number(b.trunk_cable_id), ends, b.strands);
      trunk_cable_id = r.trunk.id; strands = r.strands;
    } else if (ends.A.device_room_id !== ends.B.device_room_id) {
      throw new InputError('These panels are in different rooms: choose the trunk cable between them (add it first under Links between rooms)');
    }
  } else if (b.trunk_cable_id) {
    throw new InputError('Only a permanent installation (rear to rear) can run over a trunk');
  }
  if (trunk_cable_id === null && ends.kind === 'permanent' && b.strands) throw new InputError('Strands belong to a trunk link');
  const r = db.prepare(`INSERT INTO cab_links (port_a_id, side_a, port_b_id, side_b, kind, trunk_cable_id, strands, cable_type, color, length_m, notes)
    VALUES (?,?,?,?,?,?,?,?,?,?,?)`).run(ends.A.id, ends.sa, ends.B.id, ends.sb, ends.kind, trunk_cable_id, strands, cable.cable_type, cable.color, cable.length_m, cable.notes);
  audit(req, 'link.create', 'cab_link', r.lastInsertRowid, { a: endName(ends.A, ends.sa), b: endName(ends.B, ends.sb), kind: ends.kind, trunk_cable_id, strands, cable_type: cable.cable_type });
  res.status(201).json({ link: linkView(r.lastInsertRowid), trace: traceOf(ends.A.id) });
}));

// the ends of a link do not change (unplug and plug again instead); the cable's own data does
router.put('/links/:id', canEdit, h((req, res) => {
  const cur = need(db.prepare('SELECT * FROM cab_links WHERE id = ?').get(req.params.id), 'Link');
  const b = req.body || {};
  if ('port_a_id' in b || 'port_b_id' in b || 'side_a' in b || 'side_b' in b || 'kind' in b) throw new InputError('The ends of a link cannot be changed — remove it and connect again');
  const cable = cableFields(b, cur);
  const A = portRow(cur.port_a_id), B = portRow(cur.port_b_id);
  let trunk_cable_id = 'trunk_cable_id' in b ? (b.trunk_cable_id ? Number(b.trunk_cable_id) : null) : cur.trunk_cable_id;
  let strands = cur.strands;
  if (trunk_cable_id) {
    const changed = trunk_cable_id !== cur.trunk_cable_id || 'strands' in b;
    if (changed) strands = checkTrunk(trunk_cable_id, { A, B, kind: cur.kind }, 'strands' in b ? b.strands : null, cur.id).strands;
    else checkTrunk(trunk_cable_id, { A, B, kind: cur.kind }, cur.strands, cur.id);
  } else {
    if (cur.kind === 'permanent' && A.device_room_id !== B.device_room_id) throw new InputError('These panels are in different rooms, so the link has to stay on a trunk');
    strands = null;
  }
  db.prepare("UPDATE cab_links SET trunk_cable_id = ?, strands = ?, cable_type = ?, color = ?, length_m = ?, notes = ?, updated_at = datetime('now') WHERE id = ?").run(trunk_cable_id, strands, cable.cable_type, cable.color, cable.length_m, cable.notes, cur.id);
  audit(req, 'link.update', 'cab_link', cur.id, { a: endName(A, cur.side_a), b: endName(B, cur.side_b), cable_type: cable.cable_type, strands });
  res.json({ link: linkView(cur.id), trace: traceOf(cur.port_a_id) });
}));

// patching changes all the time, so an operator may unplug a cable; deleting devices stays with administrators
router.delete('/links/:id', canEdit, h((req, res) => {
  const cur = need(db.prepare('SELECT * FROM cab_links WHERE id = ?').get(req.params.id), 'Link');
  const A = portRow(cur.port_a_id), B = portRow(cur.port_b_id);
  db.prepare('DELETE FROM cab_links WHERE id = ?').run(cur.id);
  audit(req, 'link.delete', 'cab_link', cur.id, { a: endName(A, cur.side_a), b: endName(B, cur.side_b), kind: cur.kind, strands: cur.strands });
  res.json({ ok: true });
}));

router.get('/ports/:id/trace', h((req, res) => res.json({ trace: need(traceOf(Number(req.params.id)), 'Port') })));

// ── linking to what InfraLoom monitors ─────────────────────────────────────

const LINK_SOURCES = [
  ['router', 'routers', 'name, ip_address, brand, NULL AS discovered_from_router_id'], // routers are never discovered, the column only exists on switches and APs
  ['switch', 'switches', 'name, ip_address, brand, discovered_from_router_id'],
  ['access_point', 'access_points', 'name, ip_address, brand, discovered_from_router_id'],
  ['hypervisor', 'hypervisor_connections', 'name, url, type'],
  ['ups', 'ups_devices', 'name, ip_address'],
];

router.get('/linkable', (req, res) => {
  const used = new Set(db.prepare('SELECT linked_kind, linked_id FROM cab_devices WHERE linked_kind IS NOT NULL').all().map((r) => `${r.linked_kind}:${r.linked_id}`));
  const items = [];
  for (const [kind, table, cols] of LINK_SOURCES) {
    for (const r of db.prepare(`SELECT id, ${cols} FROM ${table} ORDER BY name`).all()) {
      items.push({ kind, id: r.id, name: r.name, address: r.ip_address || (r.url ? r.url.replace(/^https?:\/\//, '').replace(/[:/].*$/, '') : null), brand: r.brand || r.type || null, managed: !!r.discovered_from_router_id, linked: used.has(`${kind}:${r.id}`) });
    }
  }
  res.json({ items });
});

router.post('/devices/from-linked', canEdit, h((req, res) => {
  const b = req.body || {};
  const src = LINK_SOURCES.find(([k]) => k === b.kind);
  if (!src) throw new InputError('Unknown kind');
  const row = need(db.prepare(`SELECT id, ${src[2]} FROM ${src[1]} WHERE id = ?`).get(Number(b.id)), 'The InfraLoom item');
  const brand = String(row.brand || '').toLowerCase();
  const type = b.kind === 'router' ? (brand === 'fortigate' ? 'firewall' : 'router') : b.kind === 'ups' ? 'other' : b.kind;
  const address = row.ip_address || (row.url ? row.url.replace(/^https?:\/\//, '').replace(/[:/].*$/, '') : null);
  const v = deviceFields({
    name: b.name || row.name, device_type: type, purpose: 'production', room_id: b.room_id, office_id: b.office_id, rack_id: b.rack_id, rack_position: b.rack_position,
    template_id: b.template_id, ip_address: address && address !== '0.0.0.0' ? address : null, manufacturer: row.brand || null, linked_kind: b.kind, linked_id: row.id,
  });
  const groups = v.template_id ? templateGroups(v.template_id).map((g) => ({ ...g, poe: g.poe ? 1 : 0 })) : [];
  const ports = expandPortGroups(groups);
  const id = db.transaction(() => {
    const r = db.prepare(`INSERT INTO cab_devices (${DEVICE_COLS.join(', ')}) VALUES (${DEVICE_COLS.map((c) => `@${c}`).join(', ')})`).run(v);
    insertPorts(db, r.lastInsertRowid, ports);
    return r.lastInsertRowid;
  })();
  audit(req, 'device.create', 'cab_device', id, { name: v.name, from: `${b.kind}:${row.id}` });
  res.status(201).json({ device: oneDevice(id) });
}));

// ── search ─────────────────────────────────────────────────────────────────

router.get('/search', (req, res) => {
  const q = String(req.query.q || '').trim();
  if (q.length < 2) return res.json({ devices: [], ports: [] });
  const like = `%${q.replace(/[\\%_]/g, '\\$&')}%`;
  const devices = db.prepare(`${DEVICE_SELECT} WHERE d.name LIKE ? ESCAPE '\\' OR d.ip_address LIKE ? ESCAPE '\\' OR d.serial_number LIKE ? ESCAPE '\\' OR d.model LIKE ? ESCAPE '\\' OR d.mac_address LIKE ? ESCAPE '\\' ORDER BY d.name LIMIT 20`).all(like, like, like, like, like);
  const ports = db.prepare(`SELECT p.id, p.name, p.outlet_label, p.device_id, d.name AS device_name, d.room_id, r.name AS room_name, o.name AS office_name
    FROM cab_ports p JOIN cab_devices d ON d.id = p.device_id LEFT JOIN cab_rooms r ON r.id = d.room_id LEFT JOIN cab_offices o ON o.id = p.office_id
    WHERE p.name LIKE ? ESCAPE '\\' OR p.outlet_label LIKE ? ESCAPE '\\' OR p.notes LIKE ? ESCAPE '\\' ORDER BY p.outlet_label, d.name, p.sort_order LIMIT 30`).all(like, like, like);
  res.json({ devices, ports });
});

// anything unexpected is answered as JSON, never as an HTML error page
router.use((err, req, res, next) => { // eslint-disable-line no-unused-vars
  console.error('[cabling]', err);
  res.status(500).json({ error: 'Internal error' });
});

module.exports = router;
