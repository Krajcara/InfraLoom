'use strict';

const express = require('express');
const { requireAuth, requireRole } = require('../middleware/auth');
const { writeAuditLog } = require('../middleware/audit');
const svc = require('../services/syslog/service');

const router = express.Router();
router.use(requireAuth);
// Firewall logs hold addresses, user names and what people reach: for operators and administrators.
const canSee = requireRole('superadmin', 'admin', 'operator');
const canAdmin = requireRole('superadmin', 'admin');

const h = (fn) => (req, res) => Promise.resolve().then(() => fn(req, res)).catch((e) => {
  if (e instanceof svc.ConfigError) return res.status(400).json({ error: e.message });
  console.error('[syslog]', e); return res.status(500).json({ error: 'Internal error' });
});

router.get('/status', canSee, h((req, res) => res.json(svc.status())));

router.get('/summary', canSee, h((req, res) => res.json(svc.summary(String(req.query.range || '24h'), req.query.device ? String(req.query.device) : null))));

router.get('/events', canSee, h((req, res) => {
  const { limit, kind, level, q, before, device } = req.query;
  res.json(svc.events({ limit, kind: kind ? String(kind) : null, level: level ? String(level) : null, q: q ? String(q).slice(0, 80) : null, before, device: device ? String(device) : null }));
}));

router.get('/settings', canAdmin, h((req, res) => res.json(svc.getConfig())));
router.put('/settings', canAdmin, h((req, res) => {
  const c = svc.saveConfig(req.body || {}); svc.reload();
  writeAuditLog({ user_id: req.user.id, username: req.user.username, action: 'syslog.settings', module: 'syslog', details: { ...c, allowed_sources: c.allowed_sources || null }, ip_address: req.ip });
  res.json(c);
}));

module.exports = router;
