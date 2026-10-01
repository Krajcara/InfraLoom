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

// POST /api/kubernetes/clusters — provision a new cluster
router.post('/clusters', requireRole('superadmin', 'admin'), async (req, res) => {
  const { name, connectionId, node, storage, templateVmid, cores, memoryMb, diskGb, network, nodeIps, nodeVmids, nodeNames, nodeSshUsernames, nodeSshPasswords, controlPlaneCount, workerCount } = req.body || {};
  if (!name?.trim() || !connectionId || !node || !templateVmid) {
    return res.status(400).json({ error: 'name, connectionId, node, and templateVmid are required' });
  }
  const totalNodes = (parseInt(controlPlaneCount, 10) || 1) + (parseInt(workerCount, 10) || 0);
  if (!Array.isArray(nodeIps) || nodeIps.length !== totalNodes || nodeIps.some((ip) => !/^\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}\/\d{1,2}$/.test(ip))) {
    return res.status(400).json({ error: `nodeIps must have exactly ${totalNodes} valid CIDR addresses (one per node)` });
  }
  try {
    const conn = db.prepare('SELECT * FROM hypervisor_connections WHERE id = ?').get(connectionId);
    if (!conn) return res.status(404).json({ error: 'Hypervisor connection not found' });

    const { startClusterProvision } = require('../services/k8sProvisionService');
    const result = await startClusterProvision({
      name: name.trim(), connectionId, conn, node, storage, templateVmid,
      cores: parseInt(cores, 10) || 2, memoryMb: parseInt(memoryMb, 10) || 4096, diskGb: parseInt(diskGb, 10) || 20,
      network, nodeIps, nodeVmids: Array.isArray(nodeVmids) ? nodeVmids : [], nodeNames: Array.isArray(nodeNames) ? nodeNames : [],
      nodeSshUsernames: Array.isArray(nodeSshUsernames) ? nodeSshUsernames : [], nodeSshPasswords: Array.isArray(nodeSshPasswords) ? nodeSshPasswords : [],
      controlPlaneCount: parseInt(controlPlaneCount, 10) || 1, workerCount: parseInt(workerCount, 10) || 0,
      triggeredBy: req.user.username,
    });

    writeAuditLog({ user_id: req.user.id, username: req.user.username, action: 'kubernetes.cluster_provision', module: 'kubernetes', entity_id: result.clusterId, details: { name, ...result }, ip_address: req.ip });
    res.status(201).json(result);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET /api/kubernetes/clusters
router.get('/clusters', (req, res) => {
  const clusters = db.prepare('SELECT * FROM k8s_clusters ORDER BY created_at DESC').all();
  res.json({ clusters: clusters.map((c) => ({ ...c, node_config: JSON.parse(c.node_config), progress_log: c.progress_log ? JSON.parse(c.progress_log) : [] })) });
});

// GET /api/kubernetes/clusters/:id
router.get('/clusters/:id', (req, res) => {
  const cluster = db.prepare('SELECT * FROM k8s_clusters WHERE id = ?').get(req.params.id);
  if (!cluster) return res.status(404).json({ error: 'Not found' });
  const nodes = db.prepare('SELECT * FROM k8s_cluster_nodes WHERE cluster_id = ?').all(req.params.id);
  res.json({
    cluster: { ...cluster, node_config: JSON.parse(cluster.node_config), progress_log: cluster.progress_log ? JSON.parse(cluster.progress_log) : [] },
    nodes,
  });
});

module.exports = router;
