'use strict';

const axios = require('axios');
const https = require('https');

const httpsAgent = new https.Agent({ rejectUnauthorized: false }); // k3s/kubeadm clusters commonly use self-signed certs

function client(conn) {
  return axios.create({
    baseURL: conn.api_server,
    httpsAgent,
    timeout: 15000,
    headers: { Authorization: `Bearer ${conn.token}` },
  });
}

/** Basic connectivity + auth check. Throws with a clear message on failure. */
async function checkConnection(conn) {
  const api = client(conn);
  try {
    const res = await api.get('/version');
    return { ok: true, version: res.data.gitVersion };
  } catch (err) {
    if (err.response?.status === 401 || err.response?.status === 403) throw new Error('Authentication failed — check the token and its RBAC permissions');
    throw new Error(err.code === 'ECONNREFUSED' || err.code === 'ETIMEDOUT' ? `Could not reach ${conn.api_server}` : err.message);
  }
}

/** Returns normalized node summaries: name, status (Ready/NotReady),
 * roles, kubelet version, OS image, capacity (cpu/memory as reported). */
async function getNodes(conn) {
  const api = client(conn);
  const res = await api.get('/api/v1/nodes');
  return (res.data.items || []).map((n) => {
    const conditions = n.status?.conditions || [];
    const readyCond = conditions.find((c) => c.type === 'Ready');
    const roles = Object.keys(n.metadata?.labels || {})
      .filter((k) => k.startsWith('node-role.kubernetes.io/'))
      .map((k) => k.replace('node-role.kubernetes.io/', ''));
    return {
      name: n.metadata.name,
      status: readyCond?.status === 'True' ? 'Ready' : 'NotReady',
      roles: roles.length ? roles : ['worker'],
      kubelet_version: n.status?.nodeInfo?.kubeletVersion,
      os_image: n.status?.nodeInfo?.osImage,
      cpu_capacity: n.status?.capacity?.cpu,
      memory_capacity: n.status?.capacity?.memory,
      internal_ip: (n.status?.addresses || []).find((a) => a.type === 'InternalIP')?.address,
    };
  });
}

/** Returns normalized pod summaries across all namespaces. */
async function getPods(conn) {
  const api = client(conn);
  const res = await api.get('/api/v1/pods');
  return (res.data.items || []).map((p) => {
    const containerStatuses = p.status?.containerStatuses || [];
    const restarts = containerStatuses.reduce((sum, c) => sum + (c.restartCount || 0), 0);
    return {
      name: p.metadata.name,
      namespace: p.metadata.namespace,
      status: p.status?.phase || 'Unknown',
      node: p.spec?.nodeName || null,
      restarts,
      ready: `${containerStatuses.filter((c) => c.ready).length}/${containerStatuses.length}`,
      created_at: p.metadata.creationTimestamp,
    };
  });
}

/** Returns normalized deployment summaries across all namespaces. */
async function getDeployments(conn) {
  const api = client(conn);
  const res = await api.get('/apis/apps/v1/deployments');
  return (res.data.items || []).map((d) => ({
    name: d.metadata.name,
    namespace: d.metadata.namespace,
    replicas_desired: d.spec?.replicas ?? 0,
    replicas_ready: d.status?.readyReplicas ?? 0,
    replicas_available: d.status?.availableReplicas ?? 0,
  }));
}

/** Returns namespace names. */
async function getNamespaces(conn) {
  const api = client(conn);
  const res = await api.get('/api/v1/namespaces');
  return (res.data.items || []).map((n) => n.metadata.name);
}

module.exports = { checkConnection, getNodes, getPods, getDeployments, getNamespaces };
