'use strict';

const express = require('express');
const db = require('../db/database');
const { requireAuth, requireRole } = require('../middleware/auth');
const { writeAuditLog } = require('../middleware/audit');
const iacService = require('../services/iacService');
const proxmox = require('../lib/proxmoxClient');

const router = express.Router();
router.use(requireAuth);

function getConnection(id) {
  return db.prepare('SELECT * FROM hypervisor_connections WHERE id = ?').get(id);
}

// GET /api/automation/connections/:id/templates?node=X
router.get('/connections/:id/templates', async (req, res) => {
  const conn = getConnection(req.params.id);
  if (!conn) return res.status(404).json({ error: 'Not found' });
  if (conn.type !== 'proxmox') return res.status(400).json({ error: 'Automation currently supports Proxmox connections only' });
  const node = req.query.node;
  if (!node) return res.status(400).json({ error: 'node query param is required' });

  try {
    const [vmTemplates, storages] = await Promise.all([
      proxmox.listVmTemplates(conn, node),
      proxmox.listStorages(conn, node),
    ]);
    const lxcTemplatesByStorage = {};
    for (const s of storages) {
      try {
        lxcTemplatesByStorage[s.storage] = await proxmox.listDownloadedLxcTemplates(conn, node, s.storage);
      } catch {
        lxcTemplatesByStorage[s.storage] = [];
      }
    }
    res.json({ vmTemplates, storages, lxcTemplatesByStorage });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET /api/automation/deployments?connection_id=&limit=
router.get('/deployments', (req, res) => {
  const { connection_id, limit } = req.query;
  let sql = 'SELECT id, name, guest_type, connection_id, node, status, result_vmid, error, triggered_by, created_at, applied_at FROM iac_deployments WHERE 1=1';
  const params = [];
  if (connection_id) {
    sql += ' AND connection_id = ?';
    params.push(connection_id);
  }
  sql += ' ORDER BY created_at DESC LIMIT ?';
  params.push(Math.min(parseInt(limit, 10) || 50, 200));
  res.json({ deployments: db.prepare(sql).all(...params) });
});

// GET /api/automation/deployments/:id
router.get('/deployments/:id', (req, res) => {
  const d = db.prepare('SELECT * FROM iac_deployments WHERE id = ?').get(req.params.id);
  if (!d) return res.status(404).json({ error: 'Not found' });
  res.json({ deployment: { ...d, tf_vars: JSON.parse(d.tf_vars || '{}') } });
});

// POST /api/automation/deployments — plan a new VM/LXC (dry-run, nothing created yet)
router.post('/deployments', requireRole('superadmin', 'admin', 'operator'), async (req, res) => {
  const { name, guestType, connectionId, vars } = req.body || {};
  if (!name || !guestType || !connectionId || !vars) return res.status(400).json({ error: 'name, guestType, connectionId, and vars are required' });

  const conn = getConnection(connectionId);
  if (!conn) return res.status(404).json({ error: 'Connection not found' });
  if (conn.type !== 'proxmox') return res.status(400).json({ error: 'Automation currently supports Proxmox connections only' });

  try {
    const deployment = await iacService.planDeployment({ name, guestType, connectionId, conn, vars, triggeredBy: req.user.username });
    writeAuditLog({
      user_id: req.user.id, username: req.user.username, action: 'automation.plan',
      module: 'automation', entity_id: deployment.id, details: { name, guestType, node: vars.node }, ip_address: req.ip,
    });
    res.json({ deployment: { ...deployment, tf_vars: JSON.parse(deployment.tf_vars || '{}') } });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST /api/automation/deployments/:id/approve — actually creates the VM/LXC
router.post('/deployments/:id/approve', requireRole('superadmin', 'admin'), async (req, res) => {
  const deployment = db.prepare('SELECT * FROM iac_deployments WHERE id = ?').get(req.params.id);
  if (!deployment) return res.status(404).json({ error: 'Not found' });
  if (deployment.status !== 'awaiting_approval') return res.status(400).json({ error: `Deployment is not awaiting approval (status: ${deployment.status})` });

  res.json({ ok: true, message: 'Deployment approved and applying' });
  writeAuditLog({
    user_id: req.user.id, username: req.user.username, action: 'automation.approve',
    module: 'automation', entity_id: deployment.id, details: { name: deployment.name }, ip_address: req.ip,
  });

  try {
    await iacService.applyDeployment(deployment.id, req.user.username);
  } catch (err) {
    console.error('[Automation] Apply failed:', err.message);
  }
});

// POST /api/automation/deployments/:id/cancel — only while still awaiting approval
router.post('/deployments/:id/cancel', requireRole('superadmin', 'admin', 'operator'), (req, res) => {
  iacService.cancelDeployment(req.params.id);
  res.json({ ok: true });
});

module.exports = router;
