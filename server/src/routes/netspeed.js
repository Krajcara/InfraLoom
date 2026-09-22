'use strict';

const express = require('express');
const db = require('../db/database');
const { requireAuth, requireRole } = require('../middleware/auth');
const { writeAuditLog } = require('../middleware/audit');
const netspeed = require('../services/netspeedService');

const router = express.Router();
router.use(requireAuth);

function calcStats(values) {
  const valid = values.filter((v) => v != null && !isNaN(v) && v > 0);
  if (!valid.length) return { min: null, avg: null, max: null };
  return {
    min: Math.round(Math.min(...valid) * 10) / 10,
    avg: Math.round((valid.reduce((a, b) => a + b, 0) / valid.length) * 10) / 10,
    max: Math.round(Math.max(...valid) * 10) / 10,
  };
}

// GET /api/netspeed/tests?limit=
router.get('/tests', (req, res) => {
  const limit = Math.min(parseInt(req.query.limit, 10) || 50, 500);
  res.json(db.prepare('SELECT * FROM speed_tests ORDER BY created_at DESC LIMIT ?').all(limit));
});

// GET /api/netspeed/stats?days=
router.get('/stats', (req, res) => {
  const days = parseInt(req.query.days, 10) || 30;
  const since = new Date(Date.now() - days * 86400000).toISOString().replace('T', ' ').substring(0, 19);
  const tests = db.prepare("SELECT download, upload, ping FROM speed_tests WHERE status='done' AND created_at >= ?").all(since);
  res.json({
    days, count: tests.length,
    download: calcStats(tests.map((t) => t.download)),
    upload: calcStats(tests.map((t) => t.upload)),
    ping: calcStats(tests.map((t) => t.ping)),
  });
});

// GET /api/netspeed/status
router.get('/status', (req, res) => {
  const latest = db.prepare('SELECT * FROM speed_tests ORDER BY created_at DESC LIMIT 1').get();
  res.json({ running: netspeed.isRunning(), last_test: latest || null });
});

// POST /api/netspeed/run
router.post('/run', requireRole('superadmin', 'admin', 'operator'), async (req, res) => {
  if (netspeed.isRunning()) return res.status(409).json({ error: 'A test is already running' });
  res.json({ ok: true, message: 'Speed test started' });
  try {
    await netspeed.executeTest('manual');
  } catch (err) {
    console.error('[NetSpeed] Test error:', err.message);
  }
});

// DELETE /api/netspeed/tests/:id
router.delete('/tests/:id', requireRole('superadmin', 'admin'), (req, res) => {
  db.prepare('DELETE FROM speed_tests WHERE id = ?').run(req.params.id);
  writeAuditLog({ user_id: req.user.id, username: req.user.username, action: 'netspeed.delete', module: 'netspeed', entity_id: req.params.id, ip_address: req.ip });
  res.json({ ok: true });
});

// GET /api/netspeed/config
router.get('/config', (req, res) => {
  const get = (k, fb) => db.prepare('SELECT value FROM settings WHERE key = ?').get(k)?.value ?? fb;
  res.json({
    provider: get('netspeed_provider', 'cloudflare'),
    cron: get('netspeed_cron', '0 * * * *'),
    retention_days: parseInt(get('netspeed_retention_days', '90'), 10),
  });
});

// POST /api/netspeed/config — { provider, cron, retention_days }
router.post('/config', requireRole('superadmin', 'admin'), (req, res) => {
  const { provider, cron, retention_days } = req.body || {};
  const stmt = db.prepare(
    "INSERT INTO settings (key, value, updated_at) VALUES (?, ?, datetime('now')) ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at"
  );

  if (provider && ['cloudflare', 'ookla', 'librespeed'].includes(provider)) {
    stmt.run('netspeed_provider', provider);
  }
  if (retention_days) {
    stmt.run('netspeed_retention_days', String(parseInt(retention_days, 10) || 90));
  }
  if (cron) {
    const applied = netspeed.reschedule(cron);
    if (!applied) return res.status(400).json({ error: 'Invalid cron expression' });
    stmt.run('netspeed_cron', cron);
  }

  writeAuditLog({ user_id: req.user.id, username: req.user.username, action: 'netspeed.config_update', module: 'netspeed', details: { provider, cron }, ip_address: req.ip });
  res.json({ ok: true });
});

module.exports = router;
