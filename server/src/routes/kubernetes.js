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

// POST /api/kubernetes/connections/:id/deployer-token — set the separate,
// write-capable service account token for this connection. Kept distinct
// from the read-only monitoring token.
router.post('/connections/:id/deployer-token', requireRole('superadmin', 'admin'), async (req, res) => {
  const { token } = req.body || {};
  if (!token?.trim()) return res.status(400).json({ error: 'token is required' });
  const conn = db.prepare('SELECT * FROM k8s_connections WHERE id = ?').get(req.params.id);
  if (!conn) return res.status(404).json({ error: 'Not found' });
  try {
    await k8s.checkConnection({ ...conn, token: token.trim() }); // basic sanity check — at least a valid, reachable token
  } catch (err) {
    return res.status(400).json({ error: `Could not verify token: ${err.message}` });
  }
  db.prepare("UPDATE k8s_connections SET deployer_token = ?, updated_at = datetime('now') WHERE id = ?").run(token.trim(), req.params.id);
  writeAuditLog({ user_id: req.user.id, username: req.user.username, action: 'kubernetes.deployer_token_set', module: 'kubernetes', entity_id: conn.id, ip_address: req.ip });
  res.json({ ok: true });
});

// POST /api/kubernetes/connections/:id/deploy — form-based simple deploy
router.post('/connections/:id/deploy', requireRole('superadmin', 'admin', 'operator'), async (req, res) => {
  const conn = db.prepare('SELECT * FROM k8s_connections WHERE id = ?').get(req.params.id);
  if (!conn) return res.status(404).json({ error: 'Not found' });
  const { name, namespace, image, replicas, containerPort, servicePort } = req.body || {};
  if (!name?.trim() || !image?.trim()) return res.status(400).json({ error: 'name and image are required' });
  try {
    const results = await k8s.deployWorkload(conn, {
      name: name.trim(), namespace: namespace?.trim() || 'default', image: image.trim(),
      replicas: parseInt(replicas, 10) || 1,
      containerPort: containerPort ? parseInt(containerPort, 10) : null,
      servicePort: servicePort ? parseInt(servicePort, 10) : null,
    });
    for (const r of results) {
      db.prepare(
        `INSERT INTO k8s_workloads (connection_id, namespace, name, kind, triggered_by) VALUES (?,?,?,?,?)
         ON CONFLICT DO NOTHING`
      ).run(conn.id, r.namespace, r.name, r.kind, req.user.username);
    }
    writeAuditLog({ user_id: req.user.id, username: req.user.username, action: 'kubernetes.deploy', module: 'kubernetes', entity_id: conn.id, details: { name, image }, ip_address: req.ip });
    res.json({ ok: true, results });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST /api/kubernetes/connections/:id/apply-yaml — raw YAML/JSON manifest(s)
router.post('/connections/:id/apply-yaml', requireRole('superadmin', 'admin', 'operator'), async (req, res) => {
  const conn = db.prepare('SELECT * FROM k8s_connections WHERE id = ?').get(req.params.id);
  if (!conn) return res.status(404).json({ error: 'Not found' });
  const { yaml: yamlText } = req.body || {};
  if (!yamlText?.trim()) return res.status(400).json({ error: 'yaml is required' });
  try {
    const yaml = require('js-yaml');
    const docs = yaml.loadAll(yamlText).filter(Boolean);
    if (!docs.length) return res.status(400).json({ error: 'No valid YAML documents found' });
    const results = [];
    for (const doc of docs) {
      const r = await k8s.applyManifest(conn, doc);
      results.push(r);
      db.prepare(
        `INSERT INTO k8s_workloads (connection_id, namespace, name, kind, manifest, triggered_by) VALUES (?,?,?,?,?,?)
         ON CONFLICT DO NOTHING`
      ).run(conn.id, r.namespace, r.name, r.kind, yamlText, req.user.username);
    }
    writeAuditLog({ user_id: req.user.id, username: req.user.username, action: 'kubernetes.apply_yaml', module: 'kubernetes', entity_id: conn.id, details: { count: results.length }, ip_address: req.ip });
    res.json({ ok: true, results });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET /api/kubernetes/connections/:id/workloads — InfraLoom's own deploy history
router.get('/connections/:id/workloads', (req, res) => {
  res.json({ workloads: db.prepare('SELECT id, namespace, name, kind, triggered_by, created_at, updated_at FROM k8s_workloads WHERE connection_id = ? ORDER BY updated_at DESC').all(req.params.id) });
});

// POST /api/kubernetes/connections/:id/scale
router.post('/connections/:id/scale', requireRole('superadmin', 'admin', 'operator'), async (req, res) => {
  const conn = db.prepare('SELECT * FROM k8s_connections WHERE id = ?').get(req.params.id);
  if (!conn) return res.status(404).json({ error: 'Not found' });
  const { namespace, name, replicas } = req.body || {};
  try {
    const result = await k8s.scaleDeployment(conn, { namespace, name, replicas: parseInt(replicas, 10) });
    writeAuditLog({ user_id: req.user.id, username: req.user.username, action: 'kubernetes.scale', module: 'kubernetes', entity_id: conn.id, details: { namespace, name, replicas }, ip_address: req.ip });
    res.json(result);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST /api/kubernetes/connections/:id/restart
router.post('/connections/:id/restart', requireRole('superadmin', 'admin', 'operator'), async (req, res) => {
  const conn = db.prepare('SELECT * FROM k8s_connections WHERE id = ?').get(req.params.id);
  if (!conn) return res.status(404).json({ error: 'Not found' });
  const { namespace, name } = req.body || {};
  try {
    const result = await k8s.restartDeployment(conn, { namespace, name });
    writeAuditLog({ user_id: req.user.id, username: req.user.username, action: 'kubernetes.restart', module: 'kubernetes', entity_id: conn.id, details: { namespace, name }, ip_address: req.ip });
    res.json(result);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// DELETE /api/kubernetes/connections/:id/workloads/:kind/:namespace/:name
router.delete('/connections/:id/workloads/:kind/:namespace/:name', requireRole('superadmin', 'admin'), async (req, res) => {
  const conn = db.prepare('SELECT * FROM k8s_connections WHERE id = ?').get(req.params.id);
  if (!conn) return res.status(404).json({ error: 'Not found' });
  try {
    await k8s.deleteResource(conn, { kind: req.params.kind, namespace: req.params.namespace, name: req.params.name });
    db.prepare('DELETE FROM k8s_workloads WHERE connection_id = ? AND kind = ? AND namespace = ? AND name = ?').run(conn.id, req.params.kind, req.params.namespace, req.params.name);
    writeAuditLog({ user_id: req.user.id, username: req.user.username, action: 'kubernetes.delete_workload', module: 'kubernetes', entity_id: conn.id, details: req.params, ip_address: req.ip });
    res.json({ ok: true });
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

// DELETE /api/kubernetes/clusters/:id — best-effort destroys each node's
// VM (if it got far enough to exist) then removes the records.
router.delete('/clusters/:id', requireRole('superadmin', 'admin'), async (req, res) => {
  try {
    const { deleteCluster } = require('../services/k8sProvisionService');
    const destroyResults = await deleteCluster(req.params.id);
    writeAuditLog({ user_id: req.user.id, username: req.user.username, action: 'kubernetes.cluster_delete', module: 'kubernetes', entity_id: req.params.id, details: { destroyResults }, ip_address: req.ip });
    res.json({ ok: true, destroyResults });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
