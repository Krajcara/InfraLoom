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

  async function removeCluster(cluster) {
    if (!confirm(`Delete "${cluster.name}"? This tries to destroy any VMs it created first, then removes the record either way.`)) return;
    try {
      await api.del(`/kubernetes/clusters/${cluster.id}`);
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
                  <td className="actions">
                    <Link to={`/kubernetes/clusters/${c.id}`}><button type="button" className="btn-link">View progress</button></Link>
                    <button className="icon-btn" title="Delete" onClick={() => removeCluster(c)}><Trash2 size={15} /></button>
                  </td>
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
  const [message, setMessage] = useState(null);
  const [tab, setTab] = useState('nodes');
  const [deployForm, setDeployForm] = useState({ name: '', namespace: 'default', image: '', replicas: 1, containerPort: '', servicePort: '' });
  const [yamlText, setYamlText] = useState('');
  const [deploying, setDeploying] = useState(false);
  const [deployerTokenInput, setDeployerTokenInput] = useState('');
  const [hasDeployerToken, setHasDeployerToken] = useState(false);

  function loadDeployments() {
    api.get(`/kubernetes/connections/${connId}/deployments`).then((d) => setDeployments(d.deployments)).catch((err) => setError(err.message));
  }

  useEffect(() => {
    api.get(`/kubernetes/connections/${connId}/nodes`).then((d) => setNodes(d.nodes)).catch((err) => setError(err.message));
    api.get(`/kubernetes/connections/${connId}/pods`).then((d) => setPods(d.pods)).catch((err) => setError(err.message));
    loadDeployments();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [connId]);

  async function setupDeployerToken(e) {
    e.preventDefault();
    try {
      await api.post(`/kubernetes/connections/${connId}/deployer-token`, { token: deployerTokenInput });
      setHasDeployerToken(true);
      setMessage('Deploy access configured.');
      setDeployerTokenInput('');
    } catch (err) {
      setError(err.message);
    }
  }

  async function deployFromForm(e) {
    e.preventDefault();
    setDeploying(true);
    setError(null);
    try {
      await api.post(`/kubernetes/connections/${connId}/deploy`, {
        ...deployForm,
        containerPort: deployForm.containerPort || null,
        servicePort: deployForm.servicePort || null,
      });
      setMessage(`Deployed "${deployForm.name}".`);
      loadDeployments();
    } catch (err) {
      setError(err.message);
    } finally {
      setDeploying(false);
    }
  }

  async function applyYaml(e) {
    e.preventDefault();
    setDeploying(true);
    setError(null);
    try {
      const d = await api.post(`/kubernetes/connections/${connId}/apply-yaml`, { yaml: yamlText });
      setMessage(`Applied ${d.results.length} resource(s): ${d.results.map((r) => `${r.kind}/${r.name} (${r.action})`).join(', ')}`);
      loadDeployments();
    } catch (err) {
      setError(err.message);
    } finally {
      setDeploying(false);
    }
  }

  async function scale(d, replicas) {
    try {
      await api.post(`/kubernetes/connections/${connId}/scale`, { namespace: d.namespace, name: d.name, replicas });
      loadDeployments();
    } catch (err) {
      setError(err.message);
    }
  }

  async function restart(d) {
    try {
      await api.post(`/kubernetes/connections/${connId}/restart`, { namespace: d.namespace, name: d.name });
      setMessage(`Restarting "${d.name}"...`);
    } catch (err) {
      setError(err.message);
    }
  }

  async function removeWorkload(d) {
    if (!confirm(`Delete Deployment "${d.name}" in namespace "${d.namespace}"?`)) return;
    try {
      await api.del(`/kubernetes/connections/${connId}/workloads/Deployment/${d.namespace}/${d.name}`);
      loadDeployments();
    } catch (err) {
      setError(err.message);
    }
  }

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
        <button onClick={() => setTab('deploy')} className={tab === 'deploy' ? 'active' : ''}>Deploy</button>
      </div>
      {message && <p className="success">{message}</p>}

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
            <thead><tr><th>Name</th><th>Namespace</th><th>Desired</th><th>Ready</th><th>Available</th><th></th></tr></thead>
            <tbody>
              {deployments.map((d) => (
                <tr key={`${d.namespace}/${d.name}`}>
                  <td>{d.name}</td>
                  <td className="muted">{d.namespace}</td>
                  <td className="muted">{d.replicas_desired}</td>
                  <td className="muted">{d.replicas_ready}</td>
                  <td className="muted">{d.replicas_available}</td>
                  <td className="actions">
                    <button className="btn-link" onClick={() => scale(d, d.replicas_desired + 1)}>Scale +</button>
                    <button className="btn-link" onClick={() => scale(d, Math.max(0, d.replicas_desired - 1))}>Scale -</button>
                    <button className="btn-link" onClick={() => restart(d)}>Restart</button>
                    <button className="btn-link danger" onClick={() => removeWorkload(d)}>Delete</button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </section>
      )}

      {tab === 'deploy' && (
        <>
          <section className="card">
            <h2>Deploy access</h2>
            <p className="muted">
              Separate from the read-only monitoring token — this one needs write permissions (create/update/delete
              Deployments, Services, etc.). Create a dedicated service account with a ClusterRole granting those
              verbs, then paste its token here.
            </p>
            <form onSubmit={setupDeployerToken} autoComplete="off">
              <div className="form-row">
                <input
                  type="password"
                  value={deployerTokenInput}
                  onChange={(e) => setDeployerTokenInput(e.target.value)}
                  placeholder={hasDeployerToken ? 'Deploy access is configured — paste a new token to replace it' : 'Paste write-capable service account token'}
                  style={{ flex: 1 }}
                />
                <button type="submit">Save</button>
              </div>
            </form>
          </section>

          <section className="card">
            <h2>Quick deploy</h2>
            <form onSubmit={deployFromForm} autoComplete="off">
              <div className="form-row">
                <label>Name<input value={deployForm.name} onChange={(e) => setDeployForm({ ...deployForm, name: e.target.value })} placeholder="my-app" required /></label>
                <label>Namespace<input value={deployForm.namespace} onChange={(e) => setDeployForm({ ...deployForm, namespace: e.target.value })} /></label>
                <label>Image<input value={deployForm.image} onChange={(e) => setDeployForm({ ...deployForm, image: e.target.value })} placeholder="nginx:latest" required /></label>
              </div>
              <div className="form-row">
                <label>Replicas<input type="number" min="0" value={deployForm.replicas} onChange={(e) => setDeployForm({ ...deployForm, replicas: parseInt(e.target.value, 10) || 1 })} /></label>
                <label>Container port (optional)<input type="number" value={deployForm.containerPort} onChange={(e) => setDeployForm({ ...deployForm, containerPort: e.target.value })} placeholder="80" /></label>
                <label>Expose as Service on port (optional)<input type="number" value={deployForm.servicePort} onChange={(e) => setDeployForm({ ...deployForm, servicePort: e.target.value })} placeholder="8080" /></label>
              </div>
              <button type="submit" disabled={deploying}>{deploying ? 'Deploying...' : 'Deploy'}</button>
            </form>
          </section>

          <section className="card">
            <h2>Apply YAML manifest(s)</h2>
            <p className="muted">Supports Namespace, Pod, Service, ConfigMap, Secret, and Deployment — multiple documents separated by "---" are applied in order.</p>
            <form onSubmit={applyYaml} autoComplete="off">
              <textarea
                value={yamlText}
                onChange={(e) => setYamlText(e.target.value)}
                rows={14}
                className="mono"
                placeholder={'apiVersion: apps/v1\nkind: Deployment\nmetadata:\n  name: my-app\n  namespace: default\nspec:\n  replicas: 2\n  selector:\n    matchLabels:\n      app: my-app\n  template:\n    metadata:\n      labels:\n        app: my-app\n    spec:\n      containers:\n        - name: my-app\n          image: nginx:latest'}
                required
              />
              <button type="submit" disabled={deploying}>{deploying ? 'Applying...' : 'Apply'}</button>
            </form>
          </section>
        </>
      )}
    </div>
  );
}
