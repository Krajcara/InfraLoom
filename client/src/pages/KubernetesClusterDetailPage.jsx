import { useEffect, useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { api } from '../api';
import { useSocket } from '../hooks/useSocket';

export default function KubernetesClusterDetailPage() {
  const { id } = useParams();
  const navigate = useNavigate();
  const [cluster, setCluster] = useState(null);
  const [nodes, setNodes] = useState([]);

  function load() {
    api.get(`/kubernetes/clusters/${id}`).then((d) => {
      setCluster(d.cluster);
      setNodes(d.nodes);
    });
  }

  useEffect(load, [id]);
  useSocket({ 'k8s-cluster:progress': (payload) => { if (String(payload.clusterId) === String(id)) load(); } });

  async function remove() {
    if (!confirm(`Delete "${cluster.name}"? This tries to destroy any VMs it created first, then removes the record either way.`)) return;
    try {
      await api.del(`/kubernetes/clusters/${id}`);
      navigate('/kubernetes');
    } catch (err) {
      alert(err.message);
    }
  }

  if (!cluster) return <div className="page"><p className="muted">Loading...</p></div>;

  return (
    <div className="page">
      <div className="page-header-row">
        <h1>{cluster.name}</h1>
        <div className="form-row">
          <button onClick={remove}>Delete</button>
          <button onClick={() => navigate('/kubernetes')}>Back to Kubernetes</button>
        </div>
      </div>
      <p className="muted">
        Status: <strong>{cluster.status}</strong>
        {cluster.status === 'provisioning' && ' — this page updates live, safe to navigate away and come back anytime'}
      </p>
      {cluster.error && <p className="error">{cluster.error}</p>}

      <section className="card">
        <h2>Nodes</h2>
        <table className="table">
          <thead><tr><th>Name</th><th>Role</th><th>IP</th><th>VMID</th><th>Status</th></tr></thead>
          <tbody>
            {nodes.map((n) => (
              <tr key={n.id}>
                <td>{n.name}</td>
                <td className="muted">{n.role}</td>
                <td className="mono">{n.ip_address}</td>
                <td className="muted">{n.vmid || '—'}</td>
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

      {cluster.k8s_connection_id && (
        <p className="muted">
          Registered for monitoring — see it under <a href="/kubernetes">Kubernetes → Connections</a>.
        </p>
      )}
    </div>
  );
}
