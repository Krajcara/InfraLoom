'use strict';

const axios = require('axios');
const https = require('https');

const httpsAgent = new https.Agent({ rejectUnauthorized: false }); // k3s/kubeadm clusters commonly use self-signed certs

function client(conn, useDeployerToken = false) {
  const token = useDeployerToken ? conn.deployer_token : conn.token;
  if (useDeployerToken && !token) throw new Error('This connection has no deploy (write) access set up yet — see "Set up deploy access" on the Kubernetes page.');
  return axios.create({
    baseURL: conn.api_server,
    httpsAgent,
    timeout: 15000,
    headers: { Authorization: `Bearer ${token}` },
  });
}

/** Maps a resource "kind" to its REST API base path. Covers the common
 * kinds a typical workload deploy needs — not a full API-discovery
 * client, but enough for Deployments/Services/ConfigMaps/Secrets/Pods/
 * Namespaces, which covers the large majority of real-world manifests. */
function resourcePath(kind, namespace) {
  const k = kind.toLowerCase();
  const paths = {
    namespace: () => '/api/v1/namespaces',
    pod: (ns) => `/api/v1/namespaces/${ns}/pods`,
    service: (ns) => `/api/v1/namespaces/${ns}/services`,
    configmap: (ns) => `/api/v1/namespaces/${ns}/configmaps`,
    secret: (ns) => `/api/v1/namespaces/${ns}/secrets`,
    deployment: (ns) => `/apis/apps/v1/namespaces/${ns}/deployments`,
  };
  if (!paths[k]) throw new Error(`Unsupported resource kind "${kind}" — supported: Namespace, Pod, Service, ConfigMap, Secret, Deployment`);
  return paths[k](namespace || 'default');
}

/** Applies one manifest object (already-parsed, not YAML text) — creates
 * it if it doesn't exist yet, replaces it (same resourceVersion) if it
 * does, mirroring `kubectl apply`'s create-or-update behavior for the
 * common kinds this supports. */
async function applyManifest(conn, manifest) {
  if (!manifest?.kind || !manifest?.metadata?.name) throw new Error('Manifest needs at least kind and metadata.name');
  const api = client(conn, true);
  const namespace = manifest.metadata.namespace || 'default';
  const basePath = resourcePath(manifest.kind, namespace);
  const name = manifest.metadata.name;

  try {
    const existing = await api.get(`${basePath}/${name}`);
    manifest.metadata.resourceVersion = existing.data.metadata.resourceVersion;
    const res = await api.put(`${basePath}/${name}`, manifest);
    return { action: 'updated', name, kind: manifest.kind, namespace, uid: res.data.metadata.uid };
  } catch (err) {
    if (err.response?.status !== 404) throw new Error(`Apply failed for ${manifest.kind}/${name}: ${err.response?.data?.message || err.message}`);
    const res = await api.post(basePath, manifest);
    return { action: 'created', name, kind: manifest.kind, namespace, uid: res.data.metadata.uid };
  }
}

/** Convenience: builds and applies a basic Deployment + (optional)
 * Service from simple form fields, rather than requiring the caller to
 * hand-write a manifest for the common "run this image" case. */
async function deployWorkload(conn, { name, namespace = 'default', image, replicas = 1, containerPort, servicePort }) {
  const deployment = {
    apiVersion: 'apps/v1', kind: 'Deployment',
    metadata: { name, namespace, labels: { app: name } },
    spec: {
      replicas,
      selector: { matchLabels: { app: name } },
      template: {
        metadata: { labels: { app: name } },
        spec: { containers: [{ name, image, ports: containerPort ? [{ containerPort }] : [] }] },
      },
    },
  };
  const results = [await applyManifest(conn, deployment)];

  if (containerPort && servicePort) {
    const service = {
      apiVersion: 'v1', kind: 'Service',
      metadata: { name, namespace },
      spec: { selector: { app: name }, ports: [{ port: servicePort, targetPort: containerPort }] },
    };
    results.push(await applyManifest(conn, service));
  }
  return results;
}

async function deleteResource(conn, { kind, namespace = 'default', name }) {
  const api = client(conn, true);
  const basePath = resourcePath(kind, namespace);
  await api.delete(`${basePath}/${name}`);
  return { ok: true };
}

async function scaleDeployment(conn, { namespace = 'default', name, replicas }) {
  const api = client(conn, true);
  await api.patch(
    `/apis/apps/v1/namespaces/${namespace}/deployments/${name}/scale`,
    { spec: { replicas } },
    { headers: { 'Content-Type': 'application/merge-patch+json' } }
  );
  return { ok: true, replicas };
}

/** There's no direct "restart" API — the standard trick (same one
 * `kubectl rollout restart` uses) is patching the pod template's
 * annotations so the Deployment controller sees a spec change and rolls
 * the pods, without actually changing anything that affects behavior. */
async function restartDeployment(conn, { namespace = 'default', name }) {
  const api = client(conn, true);
  const patch = { spec: { template: { metadata: { annotations: { 'infraloom.io/restartedAt': new Date().toISOString() } } } } };
  await api.patch(`/apis/apps/v1/namespaces/${namespace}/deployments/${name}`, patch, { headers: { 'Content-Type': 'application/strategic-merge-patch+json' } });
  return { ok: true };
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

module.exports = { checkConnection, getNodes, getPods, getDeployments, getNamespaces, applyManifest, deployWorkload, deleteResource, scaleDeployment, restartDeployment };
