'use strict';

const express = require('express');
const db = require('../db/database');
const { requireAuth, requireRole } = require('../middleware/auth');
const { writeAuditLog } = require('../middleware/audit');
const diag = require('../services/diagnostics');

const router = express.Router();
router.use(requireAuth);
// The server can reach what the people who run these can't, so only operators and administrators run them; each run is logged.
const canRun = requireRole('superadmin', 'admin', 'operator');

// the DNS servers InfraLoom knows (the local ones of the DNS page), to pick from when comparing answers
router.get('/dns-servers', canRun, (req, res) => {
  res.json(db.prepare('SELECT id, role, type, ip, label FROM dns_local ORDER BY role ASC').all());
});

router.post('/:tool', canRun, async (req, res) => {
  const tool = req.params.tool;
  const body = req.body || {};
  try {
    const result = await diag.runTool(tool, body);
    writeAuditLog({
      user_id: req.user.id, username: req.user.username, action: `diagnostics.${tool}`, module: 'diagnostics',
      details: { target: body.host || body.url || body.name || null, ...(tool === 'port' ? { ports: body.ports } : {}) }, ip_address: req.ip,
    });
    res.json(result);
  } catch (e) {
    if (e instanceof diag.DiagError) return res.status(e.status).json({ error: e.message });
    console.error('[diagnostics]', e);
    return res.status(500).json({ error: 'Internal error' });
  }
});

module.exports = router;
