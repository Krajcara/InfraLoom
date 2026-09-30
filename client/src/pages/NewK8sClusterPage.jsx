import { useEffect, useState } from 'react';
import { api } from '../api';
import { useSocket } from '../hooks/useSocket';

export default function NewK8sClusterPage() {
  const [connections, setConnections] = useState([]);
  const [connId, setConnId] = useState(null);
  const [nodes, setNodes] = useState([]);
  const [node, setNode] = useState('');
  const [templates, setTemplates] = useState(null);
  const [form, setForm] = useState({
    name: '', templateVmid: '', storage: '',
    cores: 2, memoryMb: 4096, diskGb: 20,
    address: '', gateway: '', dns: '1.1.1.1',
    controlPlaneCount: 1, workerCount: 2,
  });
  const [error, setError] = useState(null);
  const [starting, setStarting] = useState(false);
  const [clusterId, setClusterId] = useState(null);

  useEffect(() => {
    api.get('/hypervisors/connections').then((d) => {
      const proxmoxConns = d.connections.filter((c) => c.type === 'proxmox');
      setConnections(proxmoxConns);
      if (proxmoxConns.length) setConnId(proxmoxConns[0].id);
    });
  }, []);

  useEffect(() => {
    if (!connId) return;
    api.get(`/hypervisors/connections/${connId}/nodes`).then((d) => {
      setNodes(d.nodes || []);
      if (d.nodes?.length) setNode(d.nodes[0].node);
    }).catch(() => setNodes([]));
  }, [connId]);

  useEffect(() => {
    if (!connId || !node) return;
    setTemplates(null);
    api.get(`/automation/connections/${connId}/templates?node=${node}`).then(setTemplates).catch((err) => setError(err.message));
  }, [connId, node]);

  async function start(e) {
    e.preventDefault();
    if (!/^\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}\/\d{1,2}$/.test(form.address)) {
      setError('Starting IP address needs a CIDR prefix, e.g. 10.1.0.50/24.');
      return;
    }
    setStarting(true);
    setError(null);
    try {
      const d = await api.post('/kubernetes/clusters', {
        name: form.name, connectionId: connId, node, storage: form.storage, templateVmid: parseInt(form.templateVmid, 10),
        cores: form.cores, memoryMb: form.memoryMb, diskGb: form.diskGb,
        network: { address: form.address, gateway: form.gateway, dns: form.dns.split(',').map((s) => s.trim()).filter(Boolean) },
        controlPlaneCount: form.controlPlaneCount, workerCount: form.workerCount,
      });
      setClusterId(d.clusterId);
    } catch (err) {
      setError(err.message);
    } finally {
      setStarting(false);
    }
  }

  if (clusterId) {
    return <ProvisionProgress clusterId={clusterId} onClose={() => setClusterId(null)} />;
  }

  const totalNodes = (parseInt(form.controlPlaneCount, 10) || 0) + (parseInt(form.workerCount, 10) || 0);

  return (
    <div className="page">
      <h1>New Kubernetes Cluster</h1>
      <p className="muted">
        Creates control-plane and worker VMs via the same OpenTofu flow used for single VMs, installs k3s over SSH,
        joins the workers, and registers the cluster for monitoring automatically. Static IPs are required — each
        node gets the starting IP address, incremented by one per node (control-plane nodes first, then workers).
      </p>

      {error && <p className="error">{error}</p>}

      <form onSubmit={start} autoComplete="off">
        <section className="card">
          <h2>Where</h2>
          <div className="form-row">
            <label>
              Proxmox connection
              <select value={connId || ''} onChange={(e) => setConnId(parseInt(e.target.value, 10))}>
                {connections.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
              </select>
            </label>
            <label>
              Node
              <select value={node} onChange={(e) => setNode(e.target.value)}>
                {nodes.map((n) => <option key={n.node} value={n.node}>{n.node}</option>)}
              </select>
            </label>
            <label>
              Storage
              <select value={form.storage} onChange={(e) => setForm({ ...form, storage: e.target.value })}>
                <option value="">Select...</option>
                {templates?.storages.map((s) => (
                  <option key={s.storage} value={s.storage}>{s.storage} — {s.avail_gb} GB free</option>
                ))}
              </select>
            </label>
          </div>
          <label>
            Base template (cloud image)
            <select value={form.templateVmid} onChange={(e) => setForm({ ...form, templateVmid: e.target.value })}>
              <option value="">Select...</option>
              {templates?.templates.map((t) => <option key={t.vmid} value={t.vmid}>{t.name}</option>)}
            </select>
          </label>
        </section>

        <section className="card">
          <h2>Cluster shape</h2>
          <label>
            Cluster name (used as a prefix for each node's VM name)
            <input value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} placeholder="prod-k8s" required />
          </label>
          <div className="form-row">
            <label>
              Control-plane nodes
              <input type="number" min="1" value={form.controlPlaneCount} onChange={(e) => setForm({ ...form, controlPlaneCount: parseInt(e.target.value, 10) || 1 })} />
            </label>
            <label>
              Worker nodes
              <input type="number" min="0" value={form.workerCount} onChange={(e) => setForm({ ...form, workerCount: parseInt(e.target.value, 10) || 0 })} />
            </label>
          </div>
          <p className="muted">{totalNodes} VM{totalNodes !== 1 ? 's' : ''} will be created.</p>
        </section>

        <section className="card">
          <h2>Per-node resources (applied to every node)</h2>
          <div className="form-row">
            <label>CPU cores<input type="number" value={form.cores} onChange={(e) => setForm({ ...form, cores: parseInt(e.target.value, 10) })} /></label>
            <label>Memory (MB)<input type="number" value={form.memoryMb} onChange={(e) => setForm({ ...form, memoryMb: parseInt(e.target.value, 10) })} /></label>
            <label>Disk (GB)<input type="number" value={form.diskGb} onChange={(e) => setForm({ ...form, diskGb: parseInt(e.target.value, 10) })} /></label>
          </div>
        </section>

        <section className="card">
          <h2>Network (static IPs required)</h2>
          <div className="form-row">
            <label>
              Starting IP / CIDR
              <input value={form.address} onChange={(e) => setForm({ ...form, address: e.target.value })} placeholder="10.1.0.50/24" required />
            </label>
            <label>
              Gateway
              <input value={form.gateway} onChange={(e) => setForm({ ...form, gateway: e.target.value })} placeholder="10.1.0.1" required />
            </label>
            <label>
              DNS (comma-separated)
              <input value={form.dns} onChange={(e) => setForm({ ...form, dns: e.target.value })} />
            </label>
          </div>
        </section>

        <button type="submit" disabled={starting}>{starting ? 'Starting...' : `Create cluster (${totalNodes} nodes)`}</button>
      </form>
    </div>
  );
}

function ProvisionProgress({ clusterId, onClose }) {
  const [cluster, setCluster] = useState(null);
  const [nodes, setNodes] = useState([]);

  function load() {
    api.get(`/kubernetes/clusters/${clusterId}`).then((d) => {
      setCluster(d.cluster);
      setNodes(d.nodes);
    });
  }

  useEffect(load, [clusterId]);
  useSocket({ 'k8s-cluster:progress': (payload) => { if (payload.clusterId === clusterId) load(); } });

  if (!cluster) return <div className="page"><p className="muted">Loading...</p></div>;

  return (
    <div className="page">
      <div className="page-header-row">
        <h1>{cluster.name}</h1>
        <button onClick={onClose}>Back</button>
      </div>
      <p className="muted">Status: <strong>{cluster.status}</strong></p>
      {cluster.error && <p className="error">{cluster.error}</p>}

      <section className="card">
        <h2>Nodes</h2>
        <table className="table">
          <thead><tr><th>Name</th><th>Role</th><th>IP</th><th>Status</th></tr></thead>
          <tbody>
            {nodes.map((n) => (
              <tr key={n.id}>
                <td>{n.name}</td>
                <td className="muted">{n.role}</td>
                <td className="mono">{n.ip_address}</td>
                <td><span className="status-badge">{n.status}</span></td>
              </tr>
            ))}
          </tbody>
        </table>
      </section>

      <section className="card">
        <h2>Progress</h2>
        <ul>
          {cluster.progress_log.map((p, i) => (
            <li key={i} className={p.status === 'failed' ? 'error' : 'muted'}>
              <strong>{p.step}</strong>: {p.message}
            </li>
          ))}
        </ul>
      </section>
    </div>
  );
}
