import { useEffect, useState } from 'react';
import { api } from '../api';

const PERIODS = [
  ['LastHour', 'Last hour'],
  ['LastDay', 'Last 24 hours'],
  ['LastWeek', 'Last 7 days'],
  ['LastMonth', 'Last 30 days'],
];

export default function DnsAnalyticsPage() {
  const [servers, setServers] = useState([]);
  const [serverId, setServerId] = useState('');
  const [period, setPeriod] = useState('LastDay');
  const [stats, setStats] = useState(null);
  const [topDomains, setTopDomains] = useState(null);
  const [topClients, setTopClients] = useState(null);
  const [error, setError] = useState(null);
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    api.get('/dns/local').then((data) => {
      setServers(data);
      const technitium = data.find((s) => s.type === 'technitium');
      if (technitium) setServerId(String(technitium.id));
    });
  }, []);

  async function load() {
    if (!serverId) return;
    setLoading(true);
    setError(null);
    try {
      const [s, td, tc] = await Promise.all([
        api.get(`/dns-analytics/stats?serverId=${serverId}&period=${period}`),
        api.get(`/dns-analytics/top?serverId=${serverId}&period=${period}&type=TopDomains&limit=10`),
        api.get(`/dns-analytics/top?serverId=${serverId}&period=${period}&type=TopClients&limit=10`),
      ]);
      setStats(s);
      setTopDomains(td);
      setTopClients(tc);
    } catch (err) {
      setError(err.message);
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    if (serverId) load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [serverId, period]);

  return (
    <div className="page">
      <h1>DNS Analytics</h1>
      <p className="muted">Requires a Technitium DNS server configured with an API token (see DNS page).</p>

      <div className="filters">
        <label>
          Server
          <select value={serverId} onChange={(e) => setServerId(e.target.value)}>
            <option value="">Select a server</option>
            {servers.map((s) => (
              <option key={s.id} value={s.id}>{s.label || s.ip} ({s.role})</option>
            ))}
          </select>
        </label>
        <label>
          Period
          <select value={period} onChange={(e) => setPeriod(e.target.value)}>
            {PERIODS.map(([v, l]) => (
              <option key={v} value={v}>{l}</option>
            ))}
          </select>
        </label>
        <button onClick={load} disabled={loading || !serverId}>{loading ? 'Loading...' : 'Refresh'}</button>
      </div>

      {error && <p className="error">{error}</p>}

      {stats?.stats && (
        <div className="dashboard-grid">
          <div className="widget-card">
            <div className="widget-header"><h3>Total queries</h3></div>
            <div className="widget-body"><p className="stat-number">{stats.stats.totalQueries?.toLocaleString()}</p></div>
          </div>
          <div className="widget-card">
            <div className="widget-header"><h3>Blocked</h3></div>
            <div className="widget-body"><p className="stat-number">{stats.stats.totalBlocked?.toLocaleString()}</p></div>
          </div>
          <div className="widget-card">
            <div className="widget-header"><h3>Clients</h3></div>
            <div className="widget-body"><p className="stat-number">{stats.stats.totalClients?.toLocaleString()}</p></div>
          </div>
          <div className="widget-card">
            <div className="widget-header"><h3>No error</h3></div>
            <div className="widget-body"><p className="stat-number">{stats.stats.totalNoError?.toLocaleString() ?? '—'}</p></div>
          </div>
        </div>
      )}

      {topDomains && (
        <section className="card">
          <h2>Top domains</h2>
          <table className="table">
            <thead><tr><th>Domain</th><th>Hits</th></tr></thead>
            <tbody>
              {(topDomains.topDomains || []).map((d) => (
                <tr key={d.name}><td>{d.name}</td><td>{d.hits}</td></tr>
              ))}
            </tbody>
          </table>
        </section>
      )}

      {topClients && (
        <section className="card">
          <h2>Top clients</h2>
          <table className="table">
            <thead><tr><th>Client</th><th>Hits</th></tr></thead>
            <tbody>
              {(topClients.topClients || []).map((c) => (
                <tr key={c.name}><td>{c.name}</td><td>{c.hits}</td></tr>
              ))}
            </tbody>
          </table>
        </section>
      )}
    </div>
  );
}
