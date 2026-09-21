'use strict';

const express = require('express');
const db = require('../db/database');

const router = express.Router();

// GET /api/status/public — for the public /status page
router.get('/public', (req, res) => {
  const monitors = db
    .prepare(
      `SELECT id, label, type, last_status, last_latency_ms, last_checked_at, ssl_days, ssl_expiry, ssl_error
       FROM monitors WHERE enabled = 1 ORDER BY label`
    )
    .all();
  res.json({ monitors });
});

// GET /api/status/public/:id/checks — sparkline data, no auth
router.get('/public/:id/checks', (req, res) => {
  const hours = Math.min(parseInt(req.query.hours, 10) || 3, 24);
  const since = new Date(Date.now() - hours * 3600 * 1000).toISOString().replace('T', ' ').substring(0, 19);
  const checks = db
    .prepare('SELECT status, latency_ms, checked_at FROM monitor_checks WHERE monitor_id = ? AND checked_at >= ? ORDER BY checked_at ASC LIMIT 500')
    .all(req.params.id, since);
  res.json({ checks });
});

// POST/GET /api/status/push/:token — heartbeat ingestion from an external system
function handlePush(req, res) {
  const monitor = db.prepare("SELECT * FROM monitors WHERE push_token = ? AND type = 'push'").get(req.params.token);
  if (!monitor) return res.status(404).json({ error: 'Unknown push token' });
  if (!monitor.enabled) return res.status(403).json({ error: 'Monitor is disabled' });

  const latency = req.query.latency ? parseInt(req.query.latency, 10) : null;

  db.prepare("UPDATE monitors SET last_push_at = datetime('now') WHERE id = ?").run(monitor.id);

  try {
    const { recordResult } = require('../services/monitorWorker');
    recordResult(monitor, { status: 'up', latency_ms: latency });
  } catch {
    // worker unavailable — heartbeat timestamp is still recorded above
  }

  res.json({ ok: true });
}
router.get('/push/:token', handlePush);
router.post('/push/:token', handlePush);

module.exports = router;
