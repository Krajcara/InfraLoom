'use strict';

const express = require('express');
const db = require('../db/database');
const { requireAuth, requireRole } = require('../middleware/auth');
const { writeAuditLog } = require('../middleware/audit');
const proxmox = require('../lib/proxmoxClient');

const router = express.Router();
router.use(requireAuth);

function maskConnection(conn) {
  return { ...conn, api_token: conn.api_token ? '***' : null };
}

function getConnection(id) {
  return db.prepare('SELECT * FROM hypervisor_connections WHERE id = ?').get(id);
}

function clientFor(type) {
  // Only 'proxmox' exists in Phase 11 — VMware/Hyper-V register here in later phases.
  if (type === 'proxmox') return proxmox;
  return null;
}

// GET /api/hypervisors/connections
router.get('/connections', (req, res) => {
  const rows = db.prepare('SELECT * FROM hypervisor_connections ORDER BY name').all();
  res.json({ connections: rows.map(maskConnection) });
});

// POST /api/hypervisors/connections
router.post('/connections', requireRole('superadmin', 'admin'), (req, res) => {
  const { type, name, url, username, token_id, api_token } = req.body || {};
  if (!name?.trim()) return res.status(400).json({ error: 'name is required' });
  if (!url?.trim()) return res.status(400).json({ error: 'url is required' });
  if (type !== 'proxmox') return res.status(400).json({ error: 'Only the proxmox type is supported in this phase' });

  const r = db
    .prepare(
      `INSERT INTO hypervisor_connections (type, name, url, username, token_id, api_token)
       VALUES (?,?,?,?,?,?)`
    )
    .run(type, name.trim(), url.trim().replace(/\/$/, ''), username || 'root@pam', token_id || null, api_token || null);

  writeAuditLog({
    user_id: req.user.id, username: req.user.username, action: 'hypervisor.connection_create',
    entity_type: 'hypervisor_connection', entity_id: r.lastInsertRowid, module: 'hypervisors',
    details: { name: name.trim(), type }, ip_address: req.ip,
  });

  res.status(201).json({ connection: maskConnection(getConnection(r.lastInsertRowid)) });
});

// PUT /api/hypervisors/connections/:id
router.put('/connections/:id', requireRole('superadmin', 'admin'), (req, res) => {
  const existing = getConnection(req.params.id);
  if (!existing) return res.status(404).json({ error: 'Not found' });

  const { name, url, username, token_id, api_token, enabled } = req.body || {};
  const newToken = api_token && api_token !== '***' ? api_token : existing.api_token;

  db.prepare(
    `UPDATE hypervisor_connections SET
      name=?, url=?, username=?, token_id=?, api_token=?, enabled=?, updated_at=datetime('now')
     WHERE id=?`
  ).run(
    name?.trim() || existing.name,
    url ? url.trim().replace(/\/$/, '') : existing.url,
    username || existing.username,
    token_id !== undefined ? token_id || null : existing.token_id,
    newToken,
    enabled !== undefined ? (enabled ? 1 : 0) : existing.enabled,
    req.params.id
  );

  writeAuditLog({
    user_id: req.user.id, username: req.user.username, action: 'hypervisor.connection_update',
    entity_type: 'hypervisor_connection', entity_id: req.params.id, module: 'hypervisors',
    details: { name: name?.trim() || existing.name }, ip_address: req.ip,
  });

  res.json({ connection: maskConnection(getConnection(req.params.id)) });
});

// DELETE /api/hypervisors/connections/:id
router.delete('/connections/:id', requireRole('superadmin', 'admin'), (req, res) => {
  const existing = getConnection(req.params.id);
  if (!existing) return res.status(404).json({ error: 'Not found' });
  db.prepare('DELETE FROM hypervisor_connections WHERE id = ?').run(req.params.id);
  writeAuditLog({
    user_id: req.user.id, username: req.user.username, action: 'hypervisor.connection_delete',
    entity_type: 'hypervisor_connection', entity_id: req.params.id, module: 'hypervisors',
    details: { name: existing.name }, ip_address: req.ip,
  });
  res.json({ ok: true });
});

// GET /api/hypervisors/connections/:id/nodes
router.get('/connections/:id/nodes', async (req, res) => {
  const conn = getConnection(req.params.id);
  if (!conn) return res.status(404).json({ error: 'Not found' });
  if (!conn.enabled) return res.status(400).json({ error: 'Connection is disabled' });

  const client = clientFor(conn.type);
  if (!client) return res.status(400).json({ error: `Unsupported hypervisor type: ${conn.type}` });

  try {
    const nodes = await client.fetchNodes(conn);
    res.json({ nodes });
  } catch (err) {
    const status = err.response?.status;
    let msg = err.response?.data?.errors?.[0]?.message || err.message;
    if (status === 401) msg = `Authentication failed — check Token ID "${conn.token_id}" and secret in Proxmox → Datacenter → API Tokens`;
    res.status(status === 401 || status === 403 ? 503 : status || 500).json({ error: msg });
  }
});

// GET /api/hypervisors/nodes — aggregated across every enabled connection
router.get('/nodes', async (req, res) => {
  const connections = db.prepare('SELECT * FROM hypervisor_connections WHERE enabled = 1').all();
  const results = await Promise.allSettled(
    connections.map(async (conn) => {
      const client = clientFor(conn.type);
      if (!client) throw new Error(`Unsupported type: ${conn.type}`);
      const nodes = await client.fetchNodes(conn);
      return { connectionId: conn.id, connectionName: conn.name, nodes };
    })
  );

  res.json({
    results: results.map((r, i) =>
      r.status === 'fulfilled'
        ? r.value
        : { connectionId: connections[i].id, connectionName: connections[i].name, error: r.reason.message }
    ),
  });
});

// POST /api/hypervisors/connections/:id/:node/:type/:vmid/:action
router.post('/connections/:id/:node/:type/:vmid/:action', requireRole('superadmin', 'admin'), async (req, res) => {
  const { node, type, vmid, action } = req.params;
  if (!['start', 'stop', 'reboot', 'shutdown', 'reset', 'suspend', 'resume'].includes(action)) {
    return res.status(400).json({ error: 'Invalid action' });
  }
  if (!['qemu', 'lxc'].includes(type)) return res.status(400).json({ error: 'Invalid type' });

  const conn = getConnection(req.params.id);
  if (!conn) return res.status(404).json({ error: 'Not found' });
  const client = clientFor(conn.type);
  if (!client) return res.status(400).json({ error: `Unsupported hypervisor type: ${conn.type}` });

  try {
    await client.powerAction(conn, node, type, vmid, action);
    writeAuditLog({
      user_id: req.user.id, username: req.user.username, action: 'hypervisor.power_action',
      entity_type: 'vm', entity_id: vmid, module: 'hypervisors',
      details: { connection: conn.name, node, type, action }, ip_address: req.ip,
    });
    res.json({ ok: true });
  } catch (err) {
    res.status(503).json({ error: err.response?.data?.errors?.[0]?.message || err.message });
  }
});

module.exports = router;
