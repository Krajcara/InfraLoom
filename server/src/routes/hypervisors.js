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

// GET /api/hypervisors/connections/:id/nodes — fast summary, no guest-agent calls
router.get('/connections/:id/nodes', async (req, res) => {
  const conn = getConnection(req.params.id);
  if (!conn) return res.status(404).json({ error: 'Not found' });
  if (!conn.enabled) return res.status(400).json({ error: 'Connection is disabled' });

  const client = clientFor(conn.type);
  if (!client) return res.status(400).json({ error: `Unsupported hypervisor type: ${conn.type}` });

  try {
    const nodes = await client.fetchNodesSummary(conn);
    res.json({ nodes });
  } catch (err) {
    const status = err.response?.status;
    let msg = err.response?.data?.errors?.[0]?.message || err.message;
    if (status === 401) msg = `Authentication failed — check Token ID "${conn.token_id}" and secret in Proxmox → Datacenter → API Tokens`;
    res.status(status === 401 || status === 403 ? 503 : status || 500).json({ error: msg });
  }
});

// GET /api/hypervisors/connections/:id/nodes/:node — full VM/LXC/storage detail,
// fetched only when a node is expanded (guest-agent calls make this the slow part).
router.get('/connections/:id/nodes/:node', async (req, res) => {
  const conn = getConnection(req.params.id);
  if (!conn) return res.status(404).json({ error: 'Not found' });
  if (!conn.enabled) return res.status(400).json({ error: 'Connection is disabled' });

  const client = clientFor(conn.type);
  if (!client) return res.status(400).json({ error: `Unsupported hypervisor type: ${conn.type}` });

  try {
    const detail = await client.fetchNodeDetail(conn, req.params.node);
    res.json(detail);
  } catch (err) {
    const status = err.response?.status;
    res.status(status || 500).json({ error: err.response?.data?.errors?.[0]?.message || err.message });
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

// ── Saved SSH credentials (optional defaults per VM) ─────────────────────

// GET /api/hypervisors/connections/:id/vms/:vmid/ssh-credentials
router.get('/connections/:id/vms/:vmid/ssh-credentials', requireRole('superadmin', 'admin'), (req, res) => {
  const row = db
    .prepare('SELECT * FROM ssh_credentials WHERE connection_id = ? AND vmid = ?')
    .get(req.params.id, req.params.vmid);
  if (!row) return res.json({ saved: false });
  res.json({
    saved: true,
    port: row.port,
    username: row.username,
    hasPassword: !!row.password,
    hasPrivateKey: !!row.private_key,
  });
});

// PUT /api/hypervisors/connections/:id/vms/:vmid/ssh-credentials
router.put('/connections/:id/vms/:vmid/ssh-credentials', requireRole('superadmin', 'admin'), (req, res) => {
  const { port, username, password, private_key, passphrase } = req.body || {};
  if (!username?.trim()) return res.status(400).json({ error: 'username is required' });

  const existing = db
    .prepare('SELECT * FROM ssh_credentials WHERE connection_id = ? AND vmid = ?')
    .get(req.params.id, req.params.vmid);

  const newPassword = password && password !== '***' ? password : existing?.password || null;
  const newKey = private_key && private_key !== '***' ? private_key : existing?.private_key || null;
  const newPassphrase = passphrase && passphrase !== '***' ? passphrase : existing?.passphrase || null;

  db.prepare(
    `INSERT INTO ssh_credentials (connection_id, vmid, port, username, password, private_key, passphrase, updated_at)
     VALUES (?,?,?,?,?,?,?,datetime('now'))
     ON CONFLICT(connection_id, vmid) DO UPDATE SET
       port=excluded.port, username=excluded.username, password=excluded.password,
       private_key=excluded.private_key, passphrase=excluded.passphrase, updated_at=excluded.updated_at`
  ).run(req.params.id, req.params.vmid, parseInt(port, 10) || 22, username.trim(), newPassword, newKey, newPassphrase);

  writeAuditLog({
    user_id: req.user.id, username: req.user.username, action: 'hypervisor.ssh_credentials_save',
    module: 'hypervisors', details: { vmid: req.params.vmid }, ip_address: req.ip,
  });

  res.json({ ok: true });
});

// DELETE /api/hypervisors/connections/:id/vms/:vmid/ssh-credentials
router.delete('/connections/:id/vms/:vmid/ssh-credentials', requireRole('superadmin', 'admin'), (req, res) => {
  db.prepare('DELETE FROM ssh_credentials WHERE connection_id = ? AND vmid = ?').run(req.params.id, req.params.vmid);
  res.json({ ok: true });
});

// POST /api/hypervisors/connections/:id/vms/:vmid/ssh-credentials/reveal — password only, audited
router.post('/connections/:id/vms/:vmid/ssh-credentials/reveal', requireRole('superadmin', 'admin'), (req, res) => {
  const row = db
    .prepare('SELECT * FROM ssh_credentials WHERE connection_id = ? AND vmid = ?')
    .get(req.params.id, req.params.vmid);
  if (!row) return res.status(404).json({ error: 'Not found' });
  writeAuditLog({
    user_id: req.user.id, username: req.user.username, action: 'hypervisor.ssh_credentials_reveal',
    module: 'hypervisors', details: { vmid: req.params.vmid }, ip_address: req.ip,
  });
  res.json({ username: row.username, password: row.password, private_key: row.private_key, passphrase: row.passphrase, port: row.port });
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
