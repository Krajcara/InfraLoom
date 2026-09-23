'use strict';

const express = require('express');
const db = require('../db/database');
const { requireAuth, requireRole } = require('../middleware/auth');
const { writeAuditLog } = require('../middleware/audit');
const patchService = require('../services/patchService');
const proxmox = require('../lib/proxmoxClient');
const hyperv = require('../lib/hypervClient');
const esxi = require('../lib/esxiClient');

const router = express.Router();
router.use(requireAuth);

function getConnection(id) {
  return db.prepare('SELECT * FROM hypervisor_connections WHERE id = ?').get(id);
}

// GET /api/patch-management/overview — every hypervisor connection, grouped
// by node, with each guest's most recent known patch status (not a live
// check — that's what "Check for updates" / "Check all" are for).
router.get('/overview', async (req, res) => {
  const connections = db.prepare('SELECT * FROM hypervisor_connections WHERE enabled = 1').all();

  const results = await Promise.allSettled(
    connections.map(async (conn) => {
      if (conn.type === 'esxi') {
        // Structure is ready, but actual patch checking for ESXi isn't implemented yet.
        const nodes = await esxi.fetchNodesSummary(conn);
        return {
          connectionId: conn.id, connectionName: conn.name, connectionType: conn.type, supported: false,
          nodes: nodes.map((n) => ({ node: n.node, online: n.status === 'online', guestCount: n.vm_count || 0, guests: [] })),
        };
      }

      if (conn.type === 'hyperv') {
        const summary = await hyperv.fetchNodesSummary(conn);
        const node = summary[0];
        if (!node || node.status !== 'online') {
          return { connectionId: conn.id, connectionName: conn.name, connectionType: conn.type, supported: true, nodes: [{ node: 'host', online: false, guests: [] }] };
        }
        const detail = await hyperv.fetchNodeDetail(conn);
        const guests = detail.vms.filter((vm) => vm.status === 'running').map((vm) => ({ vmid: vm.vmid, name: vm.name, type: 'vm', ip: vm.ip, os: vm.os }));
        return { connectionId: conn.id, connectionName: conn.name, connectionType: conn.type, supported: true, nodes: [{ node: 'host', online: true, guests }] };
      }

      const nodes = await proxmox.fetchNodesSummary(conn);
      const nodeResults = await Promise.all(
        nodes.map(async (node) => {
          if (node.status !== 'online') return { node: node.node, online: false, guests: [] };
          const guests = await proxmox.listGuestsBasic(conn, node.node);
          return { node: node.node, online: true, guests: guests.filter((g) => g.status === 'running') };
        })
      );
      return { connectionId: conn.id, connectionName: conn.name, connectionType: conn.type, supported: true, nodes: nodeResults };
    })
  );

  // Most recent patch_runs row per (connection, node, vmid) — one query, not N+1.
  const allRuns = db.prepare('SELECT * FROM patch_runs ORDER BY created_at DESC').all();
  const latestByGuest = new Map();
  for (const r of allRuns) {
    const key = `${r.connection_id}:${r.node}:${r.vmid}`;
    if (!latestByGuest.has(key)) latestByGuest.set(key, r);
  }

  const output = results.map((r, i) => {
    if (r.status === 'rejected') {
      return { connectionId: connections[i].id, connectionName: connections[i].name, connectionType: connections[i].type, error: r.reason.message };
    }
    const val = r.value;
    val.nodes.forEach((n) => {
      n.guests.forEach((g) => {
        const key = `${val.connectionId}:${n.node}:${g.vmid}`;
        const lastRun = latestByGuest.get(key);
        g.lastRun = lastRun
          ? { id: lastRun.id, status: lastRun.status, os_family: lastRun.os_family, packages: JSON.parse(lastRun.packages_affected || '[]').length, checked_at: lastRun.created_at }
          : null;
      });
    });
    return val;
  });

  res.json({ connections: output });
});

// GET /api/patch-management/connections/:id/guests — running QEMU+LXC guests eligible for patching
router.get('/connections/:id/guests', async (req, res) => {
  const conn = getConnection(req.params.id);
  if (!conn) return res.status(404).json({ error: 'Not found' });
  if (!['proxmox', 'hyperv'].includes(conn.type)) return res.status(400).json({ error: 'Patch Management supports Proxmox and Hyper-V connections' });

  try {
    if (conn.type === 'proxmox') {
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
      return res.json({ guests });
    }

    // Hyper-V — always one 'host' node, guests are always type 'vm'
    const detail = await hyperv.fetchNodeDetail(conn);
    const guests = detail.vms
      .filter((vm) => vm.status === 'running')
      .map((vm) => ({ node: 'host', vmid: vm.vmid, name: vm.name, type: 'vm', ip: vm.ip, os: vm.os }));
    res.json({ guests });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST /api/patch-management/bulk-dry-run — { guests: [{connectionId, node, type, vmid, name}] }
// Runs multiple dry-runs with limited concurrency, streaming progress over
// Socket.io as each one finishes (used by "Check all" per node / per OS).
router.post('/bulk-dry-run', requireRole('superadmin', 'admin', 'operator'), async (req, res) => {
  const guests = req.body?.guests;
  if (!Array.isArray(guests) || guests.length === 0) return res.status(400).json({ error: 'guests array is required' });
  if (guests.length > 50) return res.status(400).json({ error: 'Too many guests in one batch (max 50)' });

  const batchId = `bulk-${Date.now()}`;
  res.json({ ok: true, batchId, total: guests.length });

  const io = global.io;
  const CONCURRENCY = 4;
  let index = 0;
  let completed = 0;

  async function worker() {
    while (index < guests.length) {
      const g = guests[index++];
      const conn = getConnection(g.connectionId);
      try {
        if (!conn) throw new Error('Connection not found');
        const run = await patchService.runDryRun({
          connectionId: conn.id, conn, node: g.node, guestType: g.type, vmid: g.vmid, vmName: g.name,
          guestHost: g.ip, hintOs: g.os, triggeredBy: req.user.username,
        });
        completed++;
        if (io) io.emit('patch:bulk-progress', { batchId, completed, total: guests.length, guest: g, run: { ...run, packages_affected: JSON.parse(run.packages_affected || '[]') } });
      } catch (err) {
        completed++;
        if (io) io.emit('patch:bulk-progress', { batchId, completed, total: guests.length, guest: g, error: err.message });
      }
    }
  }

  const workers = Array.from({ length: Math.min(CONCURRENCY, guests.length) }, () => worker());
  Promise.all(workers).then(() => {
    if (io) io.emit('patch:bulk-complete', { batchId });
  });
});

// POST /api/patch-management/connections/:id/:node/:type/:vmid/dry-run
router.post('/connections/:id/:node/:type/:vmid/dry-run', requireRole('superadmin', 'admin', 'operator'), async (req, res) => {
  const { node, type, vmid } = req.params;
  if (!['qemu', 'lxc', 'vm'].includes(type)) return res.status(400).json({ error: 'Invalid guest type' });

  const conn = getConnection(req.params.id);
  if (!conn) return res.status(404).json({ error: 'Not found' });

  try {
    const run = await patchService.runDryRun({
      connectionId: conn.id, conn, node, guestType: type, vmid, vmName: req.body?.name,
      guestHost: req.body?.ip, hintOs: req.body?.os, triggeredBy: req.user.username,
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
