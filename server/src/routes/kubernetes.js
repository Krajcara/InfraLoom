'use strict';

const express = require('express');
const db = require('../db/database');
const { requireAuth, requireRole } = require('../middleware/auth');
const { writeAuditLog } = require('../middleware/audit');
const k8s = require('../lib/k8sClient');

const router = express.Router();
router.use(requireAuth);

function masked(conn) {
  if (!conn) return conn;
  return { ...conn, token: conn.token ? '***' : null };
}

// GET /api/kubernetes/connections
router.get('/connections', (req, res) => {
  const conns = db.prepare('SELECT id, name, api_server, enabled, last_status, last_checked_at, created_at FROM k8s_connections ORDER BY name').all();
  res.json({ connections: conns });
});

// POST /api/kubernetes/connections
router.post('/connections', requireRole('superadmin', 'admin'), async (req, res) => {
  const { name, api_server, token } = req.body || {};
  if (!name?.trim() || !api_server?.trim() || !token?.trim()) {
    return res.status(400).json({ error: 'name, api_server, and token are required' });
  }
  const conn = { api_server: api_server.trim(), token: token.trim() };
  try {
    await k8s.checkConnection(conn);
  } catch (err) {
    return res.status(400).json({ error: `Could not connect: ${err.message}` });
  }

  const result = db
    .prepare('INSERT INTO k8s_connections (name, api_server, token, last_status, last_checked_at) VALUES (?,?,?,?,datetime(\'now\'))')
    .run(name.trim(), api_server.trim(), token.trim(), 'ok');

  writeAuditLog({ user_id: req.user.id, username: req.user.username, action: 'kubernetes.connection_create', module: 'kubernetes', entity_id: result.lastInsertRowid, details: { name, api_server }, ip_address: req.ip });
  res.status(201).json({ connection: masked(db.prepare('SELECT * FROM k8s_connections WHERE id = ?').get(result.lastInsertRowid)) });
});

// DELETE /api/kubernetes/connections/:id
router.delete('/connections/:id', requireRole('superadmin', 'admin'), (req, res) => {
  const conn = db.prepare('SELECT * FROM k8s_connections WHERE id = ?').get(req.params.id);
  if (!conn) return res.status(404).json({ error: 'Not found' });
  db.prepare('DELETE FROM k8s_connections WHERE id = ?').run(req.params.id);
  writeAuditLog({ user_id: req.user.id, username: req.user.username, action: 'kubernetes.connection_delete', module: 'kubernetes', entity_id: conn.id, details: { name: conn.name }, ip_address: req.ip });
  res.json({ ok: true });
});

// POST /api/kubernetes/connections/:id/check — re-verify connectivity
router.post('/connections/:id/check', requireRole('superadmin', 'admin', 'operator'), async (req, res) => {
  const conn = db.prepare('SELECT * FROM k8s_connections WHERE id = ?').get(req.params.id);
  if (!conn) return res.status(404).json({ error: 'Not found' });
  try {
    const result = await k8s.checkConnection(conn);
    db.prepare("UPDATE k8s_connections SET last_status = ?, last_checked_at = datetime('now') WHERE id = ?").run(`ok: ${result.version}`, conn.id);
    res.json({ ok: true, version: result.version });
  } catch (err) {
    db.prepare("UPDATE k8s_connections SET last_status = ?, last_checked_at = datetime('now') WHERE id = ?").run(`error: ${err.message}`, conn.id);
    res.status(500).json({ error: err.message });
  }
});

function getConnOr404(req, res) {
  const conn = db.prepare('SELECT * FROM k8s_connections WHERE id = ?').get(req.params.id);
  if (!conn) {
    res.status(404).json({ error: 'Not found' });
    return null;
  }
  return conn;
}

// GET /api/kubernetes/connections/:id/nodes
router.get('/connections/:id/nodes', async (req, res) => {
  const conn = getConnOr404(req, res);
  if (!conn) return;
  try {
    res.json({ nodes: await k8s.getNodes(conn) });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET /api/kubernetes/connections/:id/pods
router.get('/connections/:id/pods', async (req, res) => {
  const conn = getConnOr404(req, res);
  if (!conn) return;
  try {
    res.json({ pods: await k8s.getPods(conn) });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET /api/kubernetes/connections/:id/deployments
router.get('/connections/:id/deployments', async (req, res) => {
  const conn = getConnOr404(req, res);
  if (!conn) return;
  try {
    res.json({ deployments: await k8s.getDeployments(conn) });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET /api/kubernetes/connections/:id/namespaces
router.get('/connections/:id/namespaces', async (req, res) => {
  const conn = getConnOr404(req, res);
  if (!conn) return;
  try {
    res.json({ namespaces: await k8s.getNamespaces(conn) });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
