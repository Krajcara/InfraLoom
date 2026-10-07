'use strict';

const express = require('express');
const { requireAuth, requireRole } = require('../middleware/auth');
const { writeAuditLog } = require('../middleware/audit');
const health = require('../services/deviceHealthService');

const router = express.Router();
router.use(requireAuth);

// GET /api/device-health/thresholds — settings, defaults and everything over a level right now
router.get('/thresholds', (req, res) => {
  res.json({ config: health.getConfig(), defaults: health.DEFAULTS, active: health.activeBreaches() });
});

// PUT /api/device-health/thresholds
router.put('/thresholds', requireRole('superadmin', 'admin'), (req, res) => {
  try {
    const config = health.saveConfig(req.body || {});
    writeAuditLog({ user_id: req.user.id, username: req.user.username, action: 'device_health.thresholds.update', entity_type: 'device_health', entity_id: null, module: 'device_health', details: config, ip_address: req.ip });
    res.json({ config });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

module.exports = router;
