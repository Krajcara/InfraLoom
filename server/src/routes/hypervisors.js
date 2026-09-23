'use strict';

const express = require('express');
const db = require('../db/database');
const { requireAuth, requireRole } = require('../middleware/auth');
const { writeAuditLog } = require('../middleware/audit');
const proxmox = require('../lib/proxmoxClient');
const hyperv = require('../lib/hypervClient');
const esxi = require('../lib/esxiClient');

const router = express.Router();
router.use(requireAuth);

const VALID_TYPES = ['proxmox', 'hyperv', 'esxi'];

function maskConnection(conn) {
  return { ...conn, api_token: conn.api_token ? '***' : null, password: conn.password ? '***' : null, patch_ssh_password: conn.patch_ssh_password ? '***' : null };
}

function getConnection(id) {
  return db.prepare('SELECT * FROM hypervisor_connections WHERE id = ?').get(id);
}

function clientFor(type) {
  if (type === 'proxmox') return proxmox;
  if (type === 'hyperv') return hyperv;
  if (type === 'esxi') return esxi;
  return null;
}

// GET /api/hypervisors/connections
router.get('/connections', (req, res) => {
  const rows = db.prepare('SELECT * FROM hypervisor_connections ORDER BY name').all();
  res.json({ connections: rows.map(maskConnection) });
});

// POST /api/hypervisors/connections
router.post('/connections', requireRole('superadmin', 'admin'), (req, res) => {
  const { type, name, url, username, token_id, api_token, password, port } = req.body || {};
  if (!name?.trim()) return res.status(400).json({ error: 'name is required' });
  if (!url?.trim()) return res.status(400).json({ error: 'url is required' });
  if (!VALID_TYPES.includes(type)) return res.status(400).json({ error: `type must be one of: ${VALID_TYPES.join(', ')}` });

  const r = db
    .prepare(
      `INSERT INTO hypervisor_connections (type, name, url, username, token_id, api_token, password, port)
       VALUES (?,?,?,?,?,?,?,?)`
    )
    .run(
      type, name.trim(), url.trim().replace(/\/$/, ''), username || (type === 'proxmox' ? 'root@pam' : ''),
      token_id || null, api_token || null, password || null, port ? parseInt(port, 10) : null
    );

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

  const { name, url, username, token_id, api_token, password, port, enabled, patch_ssh_username, patch_ssh_password, patch_ssh_port, patch_ssh_host, health_check_enabled } = req.body || {};
  const newToken = api_token && api_token !== '***' ? api_token : existing.api_token;
  const newPassword = password && password !== '***' ? password : existing.password;
  const newPatchSshPassword = patch_ssh_password && patch_ssh_password !== '***' ? patch_ssh_password : existing.patch_ssh_password;

  db.prepare(
    `UPDATE hypervisor_connections SET
      name=?, url=?, username=?, token_id=?, api_token=?, password=?, port=?, enabled=?,
      patch_ssh_username=?, patch_ssh_password=?, patch_ssh_port=?, patch_ssh_host=?, health_check_enabled=?, updated_at=datetime('now')
     WHERE id=?`
  ).run(
    name?.trim() || existing.name,
    url ? url.trim().replace(/\/$/, '') : existing.url,
    username || existing.username,
    token_id !== undefined ? token_id || null : existing.token_id,
    newToken,
    newPassword,
    port !== undefined ? (port ? parseInt(port, 10) : null) : existing.port,
    enabled !== undefined ? (enabled ? 1 : 0) : existing.enabled,
    patch_ssh_username !== undefined ? patch_ssh_username || null : existing.patch_ssh_username,
    newPatchSshPassword,
    patch_ssh_port !== undefined ? (patch_ssh_port ? parseInt(patch_ssh_port, 10) : null) : existing.patch_ssh_port,
    patch_ssh_host !== undefined ? patch_ssh_host || null : existing.patch_ssh_host,
    health_check_enabled !== undefined ? (health_check_enabled ? 1 : 0) : existing.health_check_enabled,
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
      const nodes = await client.fetchNodesSummary(conn);
      return { connectionId: conn.id, connectionName: conn.name, connectionType: conn.type, nodes };
    })
  );

  res.json({
    results: results.map((r, i) =>
      r.status === 'fulfilled'
        ? r.value
        : { connectionId: connections[i].id, connectionName: connections[i].name, connectionType: connections[i].type, error: r.reason.message }
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

// ── Saved WinRM credentials (Windows guest patching, e.g. Hyper-V VMs) ──

// GET /api/hypervisors/connections/:id/vms/:vmid/winrm-credentials
router.get('/connections/:id/vms/:vmid/winrm-credentials', requireRole('superadmin', 'admin'), (req, res) => {
  const row = db.prepare('SELECT * FROM guest_winrm_credentials WHERE connection_id = ? AND vmid = ?').get(req.params.id, req.params.vmid);
  if (!row) return res.json({ saved: false });
  res.json({ saved: true, host: row.host, port: row.port, username: row.username, hasPassword: !!row.password });
});

// PUT /api/hypervisors/connections/:id/vms/:vmid/winrm-credentials
router.put('/connections/:id/vms/:vmid/winrm-credentials', requireRole('superadmin', 'admin'), (req, res) => {
  const { host, port, username, password } = req.body || {};
  if (!username?.trim()) return res.status(400).json({ error: 'username is required' });

  const existing = db.prepare('SELECT * FROM guest_winrm_credentials WHERE connection_id = ? AND vmid = ?').get(req.params.id, req.params.vmid);
  const newPassword = password && password !== '***' ? password : existing?.password || null;

  db.prepare(
    `INSERT INTO guest_winrm_credentials (connection_id, vmid, host, port, username, password, updated_at)
     VALUES (?,?,?,?,?,?,datetime('now'))
     ON CONFLICT(connection_id, vmid) DO UPDATE SET
       host=excluded.host, port=excluded.port, username=excluded.username, password=excluded.password, updated_at=excluded.updated_at`
  ).run(req.params.id, req.params.vmid, host || null, port ? parseInt(port, 10) : 5985, username.trim(), newPassword);

  writeAuditLog({
    user_id: req.user.id, username: req.user.username, action: 'hypervisor.winrm_credentials_save',
    module: 'hypervisors', details: { vmid: req.params.vmid }, ip_address: req.ip,
  });
  res.json({ ok: true });
});

// DELETE /api/hypervisors/connections/:id/vms/:vmid/winrm-credentials
router.delete('/connections/:id/vms/:vmid/winrm-credentials', requireRole('superadmin', 'admin'), (req, res) => {
  db.prepare('DELETE FROM guest_winrm_credentials WHERE connection_id = ? AND vmid = ?').run(req.params.id, req.params.vmid);
  res.json({ ok: true });
});


// POST /api/hypervisors/connections/:id/:node/:type/:vmid/:action
router.post('/connections/:id/:node/:type/:vmid/:action', requireRole('superadmin', 'admin'), async (req, res) => {
  const { node, type, vmid, action } = req.params;
  if (!['start', 'stop', 'reboot', 'shutdown', 'reset', 'suspend', 'resume'].includes(action)) {
    return res.status(400).json({ error: 'Invalid action' });
  }
  if (!['qemu', 'lxc', 'vm'].includes(type)) return res.status(400).json({ error: 'Invalid type' });

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

// ── Per-node SSH override (LXC patch management on multi-node clusters) ──

// GET /api/hypervisors/connections/:id/nodes/:node/ssh
router.get('/connections/:id/nodes/:node/ssh', requireRole('superadmin', 'admin'), (req, res) => {
  const row = db.prepare('SELECT * FROM hypervisor_node_ssh WHERE connection_id = ? AND node = ?').get(req.params.id, req.params.node);
  if (!row) return res.json({ configured: false });
  res.json({
    configured: true,
    ssh_host: row.ssh_host,
    ssh_username: row.ssh_username,
    ssh_port: row.ssh_port,
    hasPassword: !!row.ssh_password,
  });
});

// PUT /api/hypervisors/connections/:id/nodes/:node/ssh
router.put('/connections/:id/nodes/:node/ssh', requireRole('superadmin', 'admin'), (req, res) => {
  const { ssh_host, ssh_username, ssh_password, ssh_port } = req.body || {};
  const existing = db.prepare('SELECT * FROM hypervisor_node_ssh WHERE connection_id = ? AND node = ?').get(req.params.id, req.params.node);
  const newPassword = ssh_password && ssh_password !== '***' ? ssh_password : existing?.ssh_password || null;

  db.prepare(
    `INSERT INTO hypervisor_node_ssh (connection_id, node, ssh_host, ssh_username, ssh_password, ssh_port)
     VALUES (?,?,?,?,?,?)
     ON CONFLICT(connection_id, node) DO UPDATE SET
       ssh_host=excluded.ssh_host, ssh_username=excluded.ssh_username,
       ssh_password=excluded.ssh_password, ssh_port=excluded.ssh_port`
  ).run(req.params.id, req.params.node, ssh_host || null, ssh_username || null, newPassword, ssh_port ? parseInt(ssh_port, 10) : null);

  writeAuditLog({
    user_id: req.user.id, username: req.user.username, action: 'hypervisor.node_ssh_save',
    module: 'hypervisors', details: { node: req.params.node }, ip_address: req.ip,
  });
  res.json({ ok: true });
});

// DELETE /api/hypervisors/connections/:id/nodes/:node/ssh — clear override, fall back to connection default
router.delete('/connections/:id/nodes/:node/ssh', requireRole('superadmin', 'admin'), (req, res) => {
  db.prepare('DELETE FROM hypervisor_node_ssh WHERE connection_id = ? AND node = ?').run(req.params.id, req.params.node);
  res.json({ ok: true });
});

// ── Background health check configuration ────────────────────────────────

// GET /api/hypervisors/health-check/config
router.get('/health-check/config', (req, res) => {
  const cron = db.prepare("SELECT value FROM settings WHERE key = 'hypervisor_health_cron'").get()?.value || '*/5 * * * *';
  res.json({ cron });
});

// POST /api/hypervisors/health-check/config
router.post('/health-check/config', requireRole('superadmin', 'admin'), (req, res) => {
  const { cron } = req.body || {};
  if (!cron) return res.status(400).json({ error: 'cron is required' });
  const applied = require('../services/hypervisorHealthService').reschedule(cron);
  if (!applied) return res.status(400).json({ error: 'Invalid cron expression' });
  db.prepare(
    "INSERT INTO settings (key, value, updated_at) VALUES ('hypervisor_health_cron', ?, datetime('now')) ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at"
  ).run(cron);
  res.json({ ok: true });
});

module.exports = router;
