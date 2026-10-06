'use strict';

const express = require('express');
const db = require('../db/database');
const { requireAuth, requireRole } = require('../middleware/auth');
const { writeAuditLog } = require('../middleware/audit');
const m = require('../services/maintenanceService');

const router = express.Router();
router.use(requireAuth);

const view = (w) => ({ ...w, status: m.statusOf(w) });

// GET /api/maintenance — active and scheduled windows, plus the last 30 days of finished ones
router.get('/', (req, res) => {
  const since = new Date(Date.now() - 30 * 86400000).toISOString();
  const rows = db
    .prepare('SELECT * FROM maintenance_windows WHERE ended_at IS NULL OR ended_at >= ? ORDER BY ends_at DESC LIMIT 300')
    .all(since);
  res.json({ windows: rows.map(view) });
});

// GET /api/maintenance/active — what the top banner shows
router.get('/active', (req, res) => {
  res.json({ windows: m.activeWindows().map((w) => ({ id: w.id, target_type: w.target_type, target_label: w.target_label, ends_at: w.ends_at, reason: w.reason, source: w.source })) });
});

// GET /api/maintenance/targets — everything a window can be attached to
router.get('/targets', (req, res) => {
  const devices = [];
  for (const [table, kind] of [['routers', 'Router'], ['switches', 'Switch'], ['access_points', 'Access point']]) {
    const cols = table === 'routers' ? 'id, name, monitor_id, NULL AS discovered_from_router_id' : 'id, name, monitor_id, discovered_from_router_id';
    for (const d of db.prepare(`SELECT ${cols} FROM ${table} ORDER BY name`).all()) {
      if (d.monitor_id || d.discovered_from_router_id) devices.push({ table, id: d.id, name: d.name, kind });
    }
  }
  res.json({
    monitors: db.prepare('SELECT id, label, type, target FROM monitors WHERE hidden = 0 ORDER BY label').all(),
    devices,
    hypervisors: db.prepare('SELECT id, name FROM hypervisor_connections ORDER BY name').all(),
    ups: db.prepare('SELECT id, name FROM ups_devices ORDER BY name').all(),
  });
});

function resolveTarget(body) {
  const { target_type: type, target_id: rawId, device_table: table } = body;
  const id = parseInt(rawId, 10);
  if (type === 'all') return { target_type: 'all', target_id: null, target_label: 'Everything' };
  if (!(id > 0)) throw new Error('target_id is required');

  if (type === 'monitor') {
    const row = db.prepare('SELECT id, label FROM monitors WHERE id = ?').get(id);
    if (!row) throw new Error('Monitor not found');
    return { target_type: 'monitor', target_id: id, target_label: row.label };
  }
  if (type === 'hypervisor') {
    const row = db.prepare('SELECT id, name FROM hypervisor_connections WHERE id = ?').get(id);
    if (!row) throw new Error('Hypervisor connection not found');
    return { target_type: 'hypervisor', target_id: id, target_label: row.name };
  }
  if (type === 'ups') {
    const row = db.prepare('SELECT id, name FROM ups_devices WHERE id = ?').get(id);
    if (!row) throw new Error('UPS not found');
    return { target_type: 'ups', target_id: id, target_label: row.name };
  }
  if (type === 'device') {
    if (!['routers', 'switches', 'access_points'].includes(table)) throw new Error('device_table must be routers, switches or access_points');
    const cols = table === 'routers' ? 'id, name, monitor_id, NULL AS discovered_from_router_id' : 'id, name, monitor_id, discovered_from_router_id';
    const d = db.prepare(`SELECT ${cols} FROM ${table} WHERE id = ?`).get(id);
    if (!d) throw new Error('Device not found');
    // FortiGate-discovered devices raise their alerts from the controller's state; every other device through its ping monitor.
    if (d.discovered_from_router_id) return { target_type: table === 'switches' ? 'switch' : 'access_point', target_id: id, target_label: d.name };
    if (d.monitor_id) return { target_type: 'monitor', target_id: d.monitor_id, target_label: d.name };
    throw new Error('This device has no monitor, so it does not raise alerts that could be muted');
  }
  throw new Error('target_type must be all, monitor, device, hypervisor or ups');
}

// POST /api/maintenance { target_type, target_id, device_table?, starts_at?, ends_at | duration_minutes, reason? }
router.post('/', requireRole('superadmin', 'admin', 'operator'), (req, res) => {
  const b = req.body || {};
  try {
    const target = resolveTarget(b);
    const now = new Date();
    const start = b.starts_at ? new Date(b.starts_at) : now;
    if (Number.isNaN(start.getTime())) throw new Error('starts_at is not a valid date');
    let end;
    if (b.ends_at) end = new Date(b.ends_at);
    else if (b.duration_minutes) end = new Date(start.getTime() + parseInt(b.duration_minutes, 10) * 60000);
    else throw new Error('Give ends_at or duration_minutes');
    if (Number.isNaN(end.getTime())) throw new Error('ends_at is not a valid date');
    if (end <= start) throw new Error('The window must end after it starts');
    if (end <= now) throw new Error('The window must end in the future');
    if ((end - start) / 60000 > m.MAX_WINDOW_MIN) throw new Error('A window can last at most 31 days');
    const reason = String(b.reason || '').trim().slice(0, 200) || null;

    const w = m.createWindow({ ...target, starts_at: start.toISOString(), ends_at: end.toISOString(), reason, created_by: req.user.username });
    writeAuditLog({ user_id: req.user.id, username: req.user.username, action: 'maintenance.create', entity_type: 'maintenance', entity_id: w.id, module: 'maintenance', details: { target: target.target_label, ends_at: w.ends_at, reason }, ip_address: req.ip });
    res.status(201).json({ window: view(w) });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

// POST /api/maintenance/:id/end — end now (a window that has not started yet is just cancelled)
router.post('/:id/end', requireRole('superadmin', 'admin', 'operator'), async (req, res) => {
  const w = db.prepare('SELECT * FROM maintenance_windows WHERE id = ?').get(req.params.id);
  if (!w) return res.status(404).json({ error: 'Not found' });
  const result = await m.endNow(w.id);
  writeAuditLog({ user_id: req.user.id, username: req.user.username, action: 'maintenance.end', entity_type: 'maintenance', entity_id: w.id, module: 'maintenance', details: { target: w.target_label }, ip_address: req.ip });
  res.json({ window: result ? view(result) : null });
});

// DELETE /api/maintenance/:id — remove from the history (an active window is ended first, so nothing stays muted)
router.delete('/:id', requireRole('superadmin', 'admin'), async (req, res) => {
  const w = db.prepare('SELECT * FROM maintenance_windows WHERE id = ?').get(req.params.id);
  if (!w) return res.status(404).json({ error: 'Not found' });
  if (!w.ended_at) await m.endNow(w.id);
  db.prepare('DELETE FROM maintenance_windows WHERE id = ?').run(w.id);
  writeAuditLog({ user_id: req.user.id, username: req.user.username, action: 'maintenance.delete', entity_type: 'maintenance', entity_id: w.id, module: 'maintenance', details: { target: w.target_label }, ip_address: req.ip });
  res.json({ ok: true });
});

module.exports = router;
