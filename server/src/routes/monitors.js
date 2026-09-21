'use strict';

const express = require('express');
const crypto = require('crypto');
const db = require('../db/database');
const { requireAuth, requireRole } = require('../middleware/auth');
const { writeAuditLog } = require('../middleware/audit');

const router = express.Router();

const VALID_TYPES = ['http', 'https', 'tcp', 'icmp', 'dns', 'keyword', 'json_query', 'push', 'docker'];

let worker;
function getWorker() {
  if (!worker) {
    try {
      worker = require('../services/monitorWorker');
    } catch {
      // worker module failed to load — routes still function, just without live scheduling
    }
  }
  return worker;
}

router.use(requireAuth);

// GET /api/monitors
router.get('/', (req, res) => {
  res.json({ monitors: db.prepare('SELECT * FROM monitors ORDER BY label').all() });
});

// GET /api/monitors/:id/checks?hours=3
router.get('/:id/checks', (req, res) => {
  const hours = parseInt(req.query.hours, 10) || 3;
  const since = new Date(Date.now() - hours * 3600 * 1000).toISOString().replace('T', ' ').substring(0, 19);
  const checks = db
    .prepare('SELECT * FROM monitor_checks WHERE monitor_id = ? AND checked_at >= ? ORDER BY checked_at ASC LIMIT 1440')
    .all(req.params.id, since);
  res.json({ checks });
});

// GET /api/monitors/:id/uptime — daily uptime % for the last 30 days
router.get('/:id/uptime', (req, res) => {
  const since = new Date(Date.now() - 30 * 24 * 3600 * 1000).toISOString().replace('T', ' ').substring(0, 19);
  const checks = db
    .prepare('SELECT status, checked_at FROM monitor_checks WHERE monitor_id = ? AND checked_at >= ? ORDER BY checked_at ASC')
    .all(req.params.id, since);
  const days = {};
  for (const c of checks) {
    const day = c.checked_at.substring(0, 10);
    if (!days[day]) days[day] = { total: 0, up: 0 };
    days[day].total++;
    if (c.status === 'up' || c.status === 'degraded') days[day].up++;
  }
  res.json({
    days: Object.entries(days).map(([date, { total, up }]) => ({
      date,
      uptime: total > 0 ? Math.round((up / total) * 100) : null,
    })),
  });
});

// POST /api/monitors
router.post('/', requireRole('superadmin', 'admin', 'operator'), (req, res) => {
  const {
    label, type, target, port, interval_s, timeout_s,
    keyword, json_path, json_expected, expected_status,
    push_interval_s, docker_container,
  } = req.body || {};

  if (!label?.trim()) return res.status(400).json({ error: 'label is required' });
  if (!VALID_TYPES.includes(type)) return res.status(400).json({ error: 'Invalid type' });
  if (type !== 'push' && !target?.trim()) return res.status(400).json({ error: 'target is required' });
  if (type === 'keyword' && !keyword?.trim()) return res.status(400).json({ error: 'keyword is required for this type' });
  if (type === 'json_query' && (!json_path?.trim() || json_expected === undefined)) {
    return res.status(400).json({ error: 'json_path and json_expected are required for this type' });
  }
  if (type === 'docker' && !docker_container?.trim() && !target?.trim()) {
    return res.status(400).json({ error: 'docker_container (or target) is required for this type' });
  }

  const pushToken = type === 'push' ? crypto.randomBytes(16).toString('hex') : null;

  const r = db
    .prepare(
      `INSERT INTO monitors
        (label, type, target, port, interval_s, timeout_s, keyword, json_path, json_expected,
         expected_status, push_token, push_interval_s, docker_container)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`
    )
    .run(
      label.trim(), type, target?.trim() || '',
      port ? parseInt(port, 10) : null,
      parseInt(interval_s, 10) || 60,
      parseInt(timeout_s, 10) || 10,
      keyword || null, json_path || null, json_expected != null ? String(json_expected) : null,
      parseInt(expected_status, 10) || 200,
      pushToken, parseInt(push_interval_s, 10) || 60,
      docker_container || null
    );

  const monitor = db.prepare('SELECT * FROM monitors WHERE id = ?').get(r.lastInsertRowid);
  getWorker()?.registerMonitor(monitor);

  if (['http', 'https', 'keyword', 'json_query'].includes(type)) {
    require('../services/sslChecker')
      .checkAllSSL()
      .catch((e) => console.error('[Monitor] Immediate SSL check failed:', e.message));
  }

  writeAuditLog({
    user_id: req.user.id, username: req.user.username, action: 'monitor.create',
    entity_type: 'monitor', entity_id: r.lastInsertRowid, module: 'monitors',
    details: { label: label.trim(), type }, ip_address: req.ip,
  });

  res.status(201).json({ monitor });
});

// PUT /api/monitors/:id
router.put('/:id', requireRole('superadmin', 'admin', 'operator'), (req, res) => {
  const existing = db.prepare('SELECT * FROM monitors WHERE id = ?').get(req.params.id);
  if (!existing) return res.status(404).json({ error: 'Not found' });

  const {
    label, target, port, interval_s, timeout_s,
    keyword, json_path, json_expected, expected_status,
    push_interval_s, docker_container, enabled,
  } = req.body || {};

  db.prepare(
    `UPDATE monitors SET
      label=?, target=?, port=?, interval_s=?, timeout_s=?, keyword=?, json_path=?, json_expected=?,
      expected_status=?, push_interval_s=?, docker_container=?, enabled=?
     WHERE id=?`
  ).run(
    label ?? existing.label,
    target !== undefined ? target : existing.target,
    port !== undefined ? (port ? parseInt(port, 10) : null) : existing.port,
    parseInt(interval_s, 10) || existing.interval_s,
    parseInt(timeout_s, 10) || existing.timeout_s,
    keyword !== undefined ? keyword || null : existing.keyword,
    json_path !== undefined ? json_path || null : existing.json_path,
    json_expected !== undefined ? String(json_expected) : existing.json_expected,
    parseInt(expected_status, 10) || existing.expected_status,
    parseInt(push_interval_s, 10) || existing.push_interval_s,
    docker_container !== undefined ? docker_container || null : existing.docker_container,
    enabled !== undefined ? (enabled ? 1 : 0) : existing.enabled,
    req.params.id
  );

  const updated = db.prepare('SELECT * FROM monitors WHERE id = ?').get(req.params.id);
  getWorker()?.unregisterMonitor(parseInt(req.params.id, 10));
  if (updated.enabled) getWorker()?.registerMonitor(updated);

  writeAuditLog({
    user_id: req.user.id, username: req.user.username, action: 'monitor.update',
    entity_type: 'monitor', entity_id: req.params.id, module: 'monitors',
    details: { label: updated.label }, ip_address: req.ip,
  });

  res.json({ monitor: updated });
});

// DELETE /api/monitors/:id
router.delete('/:id', requireRole('superadmin', 'admin'), (req, res) => {
  const m = db.prepare('SELECT label FROM monitors WHERE id = ?').get(req.params.id);
  if (!m) return res.status(404).json({ error: 'Not found' });
  getWorker()?.unregisterMonitor(parseInt(req.params.id, 10));
  db.prepare('DELETE FROM monitors WHERE id = ?').run(req.params.id);
  writeAuditLog({
    user_id: req.user.id, username: req.user.username, action: 'monitor.delete',
    entity_type: 'monitor', entity_id: req.params.id, module: 'monitors',
    details: { label: m.label }, ip_address: req.ip,
  });
  res.json({ ok: true });
});

module.exports = router;
