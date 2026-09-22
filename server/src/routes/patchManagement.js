'use strict';

const express = require('express');
const db = require('../db/database');
const { requireAuth, requireRole } = require('../middleware/auth');
const { writeAuditLog } = require('../middleware/audit');
const patchService = require('../services/patchService');
const proxmox = require('../lib/proxmoxClient');

const router = express.Router();
router.use(requireAuth);

function getConnection(id) {
  return db.prepare('SELECT * FROM hypervisor_connections WHERE id = ?').get(id);
}

// GET /api/patch-management/connections/:id/guests — running QEMU+LXC guests eligible for patching
router.get('/connections/:id/guests', async (req, res) => {
  const conn = getConnection(req.params.id);
  if (!conn) return res.status(404).json({ error: 'Not found' });
  if (conn.type !== 'proxmox') return res.status(400).json({ error: 'Patch Management currently supports Proxmox connections only' });

  try {
    const nodes = await proxmox.fetchNodesSummary(conn);
    const guests = [];
    for (const node of nodes) {
      if (node.status !== 'online') continue;
      const detail = await proxmox.fetchNodeDetail(conn, node.node);
      for (const vm of [...detail.vms, ...detail.lxc]) {
        if (vm.status !== 'running') continue;
        guests.push({ node: node.node, vmid: vm.vmid, name: vm.name, type: vm.type, ip: vm.ip });
      }
    }
    res.json({ guests });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST /api/patch-management/connections/:id/:node/:type/:vmid/dry-run
router.post('/connections/:id/:node/:type/:vmid/dry-run', requireRole('superadmin', 'admin', 'operator'), async (req, res) => {
  const { node, type, vmid } = req.params;
  if (!['qemu', 'lxc'].includes(type)) return res.status(400).json({ error: 'Invalid guest type' });

  const conn = getConnection(req.params.id);
  if (!conn) return res.status(404).json({ error: 'Not found' });

  try {
    const run = await patchService.runDryRun({
      connectionId: conn.id, conn, node, guestType: type, vmid, vmName: req.body?.name, triggeredBy: req.user.username,
    });
    writeAuditLog({
      user_id: req.user.id, username: req.user.username, action: 'patch.dry_run',
      module: 'patch_management', entity_id: run.id, details: { node, type, vmid, os_family: run.os_family }, ip_address: req.ip,
    });
    res.json({ run: { ...run, packages_affected: JSON.parse(run.packages_affected || '[]') } });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST /api/patch-management/runs/:id/approve
router.post('/runs/:id/approve', requireRole('superadmin', 'admin'), async (req, res) => {
  const run = db.prepare('SELECT * FROM patch_runs WHERE id = ?').get(req.params.id);
  if (!run) return res.status(404).json({ error: 'Not found' });
  if (run.status !== 'awaiting_approval') return res.status(400).json({ error: `Run is not awaiting approval (status: ${run.status})` });

  res.json({ ok: true, message: 'Patch run approved and started' });
  writeAuditLog({
    user_id: req.user.id, username: req.user.username, action: 'patch.approve',
    module: 'patch_management', entity_id: run.id, details: { vmid: run.vmid, os_family: run.os_family }, ip_address: req.ip,
  });

  try {
    await patchService.applyPatches(run.id, req.user.username);
  } catch (err) {
    console.error('[PatchManagement] Apply failed:', err.message);
  }
});

// POST /api/patch-management/runs/:id/cancel — only while still awaiting approval
router.post('/runs/:id/cancel', requireRole('superadmin', 'admin', 'operator'), (req, res) => {
  patchService.cancelRun(req.params.id);
  res.json({ ok: true });
});

// GET /api/patch-management/runs/:id
router.get('/runs/:id', (req, res) => {
  const run = db.prepare('SELECT * FROM patch_runs WHERE id = ?').get(req.params.id);
  if (!run) return res.status(404).json({ error: 'Not found' });
  res.json({ run: { ...run, packages_affected: JSON.parse(run.packages_affected || '[]') } });
});

// GET /api/patch-management/runs?connection_id=&status=&limit=
router.get('/runs', (req, res) => {
  const { connection_id, status, limit } = req.query;
  let sql = 'SELECT * FROM patch_runs WHERE 1=1';
  const params = [];
  if (connection_id) {
    sql += ' AND connection_id = ?';
    params.push(connection_id);
  }
  if (status) {
    sql += ' AND status = ?';
    params.push(status);
  }
  sql += ' ORDER BY created_at DESC LIMIT ?';
  params.push(Math.min(parseInt(limit, 10) || 50, 200));

  const runs = db.prepare(sql).all(...params);
  res.json({ runs: runs.map((r) => ({ ...r, packages_affected: JSON.parse(r.packages_affected || '[]') })) });
});

module.exports = router;
