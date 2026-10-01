import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { Trash2 } from 'lucide-react';
import { api } from '../api';
import { formatDbDate } from '../utils/formatDate';

export default function KubernetesPage() {
  const [connections, setConnections] = useState([]);
  const [clusters, setClusters] = useState([]);
  const [form, setForm] = useState({ name: '', api_server: '', token: '' });
  const [showForm, setShowForm] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState(null);
  const [activeId, setActiveId] = useState(null);

  function load() {
    api.get('/kubernetes/connections').then((d) => setConnections(d.connections));
    api.get('/kubernetes/clusters').then((d) => setClusters(d.clusters));
  }

  useEffect(load, []);

  async function save(e) {
    e.preventDefault();
    setSaving(true);
    setError(null);
    try {
      await api.post('/kubernetes/connections', form);
      setForm({ name: '', api_server: '', token: '' });
      setShowForm(false);
      load();
    } catch (err) {
      setError(err.message);
    } finally {
      setSaving(false);
    }
  }

  async function remove(conn) {
    if (!confirm(`Remove connection "${conn.name}"? This only forgets it here.`)) return;
    try {
      await api.del(`/kubernetes/connections/${conn.id}`);
      load();
    } catch (err) {
      setError(err.message);
    }
  }

  async function recheck(conn) {
    try {
      await api.post(`/kubernetes/connections/${conn.id}/check`);
      load();
    } catch (err) {
      setError(err.message);
    }
  }

  if (activeId) {
    return <ClusterDetail connId={activeId} onClose={() => { setActiveId(null); load(); }} />;
  }

  return (
    <div className="page">
      <div className="page-header-row">
        <h1>Kubernetes</h1>
        <div className="form-row">
          <Link to="/kubernetes/new"><button type="button">+ Provision new cluster</button></Link>
          <button onClick={() => setShowForm(!showForm)}>{showForm ? 'Cancel' : '+ Connect existing cluster'}</button>
        </div>
      </div>
      <p className="muted">
        Connects using a read-only service account token — see the "install-k3s-test.sh" script for how to create
        one, or set up an equivalent ServiceAccount + ClusterRole on any existing cluster.
      </p>

      {error && <p className="error">{error}</p>}

      {clusters.length > 0 && (
        <section className="card">
          <h2>Provisioned clusters</h2>
          <table className="table">
            <thead><tr><th>Name</th><th>Status</th><th>Created</th><th></th></tr></thead>
            <tbody>
              {clusters.map((c) => (
                <tr key={c.id}>
                  <td>{c.name}</td>
                  <td><span className={`status-badge ${c.status === 'failed' ? 'status-down' : c.status === 'ready' ? 'status-up' : ''}`}>{c.status}</span></td>
                  <td className="muted">{formatDbDate(c.created_at)}</td>
                  <td className="actions"><Link to={`/kubernetes/clusters/${c.id}`}><button type="button" className="btn-link">View progress</button></Link></td>
                </tr>
              ))}
            </tbody>
          </table>
        </section>
      )}

      {showForm && (
        <section className="card">
          <h2>New connection</h2>
          <form onSubmit={save} autoComplete="off">
            <label>
              Name
              <input value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} placeholder="Test cluster" required />
            </label>
            <label>
              API server URL
              <input value={form.api_server} onChange={(e) => setForm({ ...form, api_server: e.target.value })} placeholder="https://10.1.0.208:6443" required />
            </label>
            <label>
              Service account token
              <textarea value={form.token} onChange={(e) => setForm({ ...form, token: e.target.value })} rows={3} required />
            </label>
            <button type="submit" disabled={saving}>{saving ? 'Connecting...' : 'Connect'}</button>
          </form>
        </section>
      )}

      <section className="card">
        <table className="table">
          <thead><tr><th>Name</th><th>API server</th><th>Status</th><th>Checked</th><th></th></tr></thead>
          <tbody>
            {connections.map((c) => (
              <tr key={c.id}>
                <td>{c.name}</td>
                <td className="mono">{c.api_server}</td>
                <td className="muted">{c.last_status || 'Not checked'}</td>
                <td className="muted">{c.last_checked_at ? formatDbDate(c.last_checked_at) : '—'}</td>
                <td className="actions">
                  <button className="btn-link" onClick={() => setActiveId(c.id)}>View</button>
                  <button className="btn-link" onClick={() => recheck(c)}>Re-check</button>
                  <button className="icon-btn" title="Remove" onClick={() => remove(c)}><Trash2 size={15} /></button>
                </td>
              </tr>
            ))}
            {connections.length === 0 && <tr><td colSpan={5} className="muted">No clusters connected yet.</td></tr>}
          </tbody>
        </table>
      </section>
    </div>
  );
}

function ClusterDetail({ connId, onClose }) {
  const [nodes, setNodes] = useState([]);
  const [pods, setPods] = useState([]);
  const [deployments, setDeployments] = useState([]);
  const [error, setError] = useState(null);
  const [tab, setTab] = useState('nodes');

  useEffect(() => {
    api.get(`/kubernetes/connections/${connId}/nodes`).then((d) => setNodes(d.nodes)).catch((err) => setError(err.message));
    api.get(`/kubernetes/connections/${connId}/pods`).then((d) => setPods(d.pods)).catch((err) => setError(err.message));
    api.get(`/kubernetes/connections/${connId}/deployments`).then((d) => setDeployments(d.deployments)).catch((err) => setError(err.message));
  }, [connId]);

  return (
    <div className="page">
      <div className="page-header-row">
        <h1>Cluster detail</h1>
        <button onClick={onClose}>Back</button>
      </div>
      {error && <p className="error">{error}</p>}

      <div className="form-row">
        <button onClick={() => setTab('nodes')} className={tab === 'nodes' ? 'active' : ''}>Nodes ({nodes.length})</button>
        <button onClick={() => setTab('pods')} className={tab === 'pods' ? 'active' : ''}>Pods ({pods.length})</button>
        <button onClick={() => setTab('deployments')} className={tab === 'deployments' ? 'active' : ''}>Deployments ({deployments.length})</button>
      </div>

      {tab === 'nodes' && (
        <section className="card">
          <table className="table">
            <thead><tr><th>Name</th><th>Status</th><th>Roles</th><th>Version</th><th>Internal IP</th><th>CPU</th><th>Memory</th></tr></thead>
            <tbody>
              {nodes.map((n) => (
                <tr key={n.name}>
                  <td>{n.name}</td>
                  <td><span className={`status-badge status-${n.status === 'Ready' ? 'up' : 'down'}`}>{n.status}</span></td>
                  <td className="muted">{n.roles.join(', ')}</td>
                  <td className="muted">{n.kubelet_version}</td>
                  <td className="mono">{n.internal_ip}</td>
                  <td className="muted">{n.cpu_capacity}</td>
                  <td className="muted">{n.memory_capacity}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </section>
      )}

      {tab === 'pods' && (
        <section className="card">
          <table className="table">
            <thead><tr><th>Name</th><th>Namespace</th><th>Status</th><th>Ready</th><th>Restarts</th><th>Node</th></tr></thead>
            <tbody>
              {pods.map((p) => (
                <tr key={`${p.namespace}/${p.name}`}>
                  <td>{p.name}</td>
                  <td className="muted">{p.namespace}</td>
                  <td><span className={`status-badge status-${p.status === 'Running' ? 'up' : 'down'}`}>{p.status}</span></td>
                  <td className="muted">{p.ready}</td>
                  <td className="muted">{p.restarts}</td>
                  <td className="muted">{p.node}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </section>
      )}

      {tab === 'deployments' && (
        <section className="card">
          <table className="table">
            <thead><tr><th>Name</th><th>Namespace</th><th>Desired</th><th>Ready</th><th>Available</th></tr></thead>
            <tbody>
              {deployments.map((d) => (
                <tr key={`${d.namespace}/${d.name}`}>
                  <td>{d.name}</td>
                  <td className="muted">{d.namespace}</td>
                  <td className="muted">{d.replicas_desired}</td>
                  <td className="muted">{d.replicas_ready}</td>
                  <td className="muted">{d.replicas_available}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </section>
      )}
    </div>
  );
}
