import { useEffect, useState } from 'react';
import { RefreshCw } from 'lucide-react';
import { api } from '../api';

export default function DeploymentsPage() {
  const [deployments, setDeployments] = useState([]);
  const [loading, setLoading] = useState(true);

  function load() {
    setLoading(true);
    api.get('/automation/deployments').then((d) => setDeployments(d.deployments)).finally(() => setLoading(false));
  }

  useEffect(() => {
    load();
  }, []);

  return (
    <div className="page">
      <div className="page-header-row">
        <h1>Deployments</h1>
        <button onClick={load} disabled={loading}><RefreshCw size={14} className={loading ? 'spin' : ''} /> Refresh</button>
      </div>
      <section className="card">
        <table className="table">
          <thead><tr><th>Name</th><th>Type</th><th>Node</th><th>Status</th><th>Result</th><th>Triggered by</th><th>Created</th></tr></thead>
          <tbody>
            {deployments.map((d) => (
              <tr key={d.id}>
                <td>{d.name}</td>
                <td className="muted">{d.guest_type === 'lxc' ? 'LXC' : 'VM'}</td>
                <td className="muted">{d.node}</td>
                <td><span className="status-badge">{d.status}</span></td>
                <td className="muted">{d.result_vmid ? `#${d.result_vmid}` : (d.error || '—')}</td>
                <td className="muted">{d.triggered_by}</td>
                <td className="muted">{d.created_at}</td>
              </tr>
            ))}
            {deployments.length === 0 && !loading && <tr><td colSpan={7} className="muted">No deployments yet.</td></tr>}
          </tbody>
        </table>
      </section>
    </div>
  );
}
