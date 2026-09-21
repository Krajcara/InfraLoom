import { useCallback, useEffect, useState } from 'react';
import { Activity, Shield, Database, Users, Globe, RefreshCw } from 'lucide-react';
import { api } from '../api';

const PERIODS = [
  ['LastHour', 'Last hour'],
  ['LastDay', 'Last 24h'],
  ['LastWeek', 'Last 7 days'],
  ['LastMonth', 'Last 30 days'],
];

function fmtNum(n) {
  if (!n) return '0';
  if (n >= 1000000) return `${(n / 1000000).toFixed(1)}M`;
  if (n >= 1000) return `${(n / 1000).toFixed(1)}K`;
  return String(n);
}

function StatCard({ icon: Icon, label, value, color }) {
  return (
    <div className="widget-card analytics-stat-card">
      <div className={`analytics-stat-icon analytics-stat-icon-${color}`}>
        <Icon size={18} />
      </div>
      <div>
        <p className="muted">{label}</p>
        <p className="stat-number">{fmtNum(value)}</p>
      </div>
    </div>
  );
}

function TopList({ title, items, nameKey = 'name', valueKey = 'hits', colorClass = 'bar-blue' }) {
  if (!items?.length) {
    return (
      <div className="card">
        <h3>{title}</h3>
        <p className="muted">No data</p>
      </div>
    );
  }
  const max = Math.max(...items.map((i) => i[valueKey] || 0), 1);
  return (
    <div className="card">
      <h3>{title}</h3>
      <div className="top-list">
        {items.map((item, idx) => (
          <div key={idx} className="top-list-row">
            <div className="top-list-labels">
              <span className="top-list-name">{item[nameKey] || '(empty)'}</span>
              <span className="mono muted">{fmtNum(item[valueKey])}</span>
            </div>
            <div className="top-list-track">
              <div className={`top-list-bar ${colorClass}`} style={{ width: `${Math.round(((item[valueKey] || 0) / max) * 100)}%` }} />
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}

export default function DnsAnalyticsPage() {
  const [period, setPeriod] = useState('LastDay');
  const [servers, setServers] = useState([]);
  const [selected, setSelected] = useState(null);
  const [stats, setStats] = useState(null);
  const [tops, setTops] = useState({});
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(null);

  useEffect(() => {
    api.get('/dns/local').then((srv) => {
      setServers(srv || []);
      if (srv?.length) setSelected(srv.find((s) => s.role === 'primary') || srv[0]);
    });
  }, []);

  const load = useCallback(async () => {
    if (!selected) return;
    setLoading(true);
    setError(null);
    try {
      const [statsRes, domainsRes, clientsRes, blockedRes] = await Promise.allSettled([
        api.get(`/dns-analytics/stats?serverId=${selected.id}&period=${period}`),
        api.get(`/dns-analytics/top?serverId=${selected.id}&period=${period}&type=TopDomains`),
        api.get(`/dns-analytics/top?serverId=${selected.id}&period=${period}&type=TopClients`),
        api.get(`/dns-analytics/top?serverId=${selected.id}&period=${period}&type=TopBlockedDomains`),
      ]);
      if (statsRes.status === 'fulfilled') setStats(statsRes.value);
      else setError(statsRes.reason?.message || 'Failed to load stats');
      setTops({
        domains: domainsRes.status === 'fulfilled' ? domainsRes.value?.topDomains || [] : [],
        clients: clientsRes.status === 'fulfilled' ? clientsRes.value?.topClients || [] : [],
        blocked: blockedRes.status === 'fulfilled' ? blockedRes.value?.topBlockedDomains || [] : [],
      });
    } finally {
      setLoading(false);
    }
  }, [selected, period]);

  useEffect(() => {
    load();
  }, [load]);

  const s = stats?.stats || {};

  return (
    <div className="page">
      <div className="page-header-row">
        <div>
          <h1>DNS Analytics</h1>
          <p className="muted">Technitium DNS query statistics</p>
        </div>
        <div className="analytics-controls">
          {servers.length > 1 && (
            <select value={selected?.id || ''} onChange={(e) => setSelected(servers.find((sv) => sv.id === parseInt(e.target.value, 10)))}>
              {servers.map((sv) => (
                <option key={sv.id} value={sv.id}>{sv.label || sv.role} ({sv.ip})</option>
              ))}
            </select>
          )}
          <div className="tab-bar tab-bar-compact">
            {PERIODS.map(([v, l]) => (
              <button key={v} className={period === v ? 'active' : ''} onClick={() => setPeriod(v)}>{l}</button>
            ))}
          </div>
          <button className="icon-btn" onClick={load} disabled={loading}><RefreshCw size={16} className={loading ? 'spin' : ''} /></button>
        </div>
      </div>

      {error && <p className="error">{error}</p>}

      {loading && !stats ? (
        <p className="muted">Loading...</p>
      ) : (
        <>
          <div className="analytics-stats-grid">
            <StatCard icon={Activity} label="Total queries" value={s.totalQueries} color="blue" />
            <StatCard icon={Globe} label="No error" value={s.totalNoError} color="green" />
            <StatCard icon={Database} label="Cached" value={s.totalCached} color="purple" />
            <StatCard icon={Shield} label="Blocked" value={s.totalBlocked} color="red" />
            <StatCard icon={Users} label="Clients" value={s.totalClients} color="amber" />
            <StatCard icon={Activity} label="NX Domain" value={s.totalNxDomain} color="blue" />
          </div>

          <div className="analytics-top-grid">
            <TopList title="Top 10 domains" items={tops.domains?.slice(0, 10)} colorClass="bar-blue" />
            <TopList title="Top 10 clients" items={tops.clients?.slice(0, 10)} colorClass="bar-purple" />
            <TopList title="Top 10 blocked domains" items={tops.blocked?.slice(0, 10)} colorClass="bar-red" />
          </div>

          <div className="analytics-extra-grid">
            {[
              ['Server Failure', s.totalServerFailure],
              ['Authoritative', s.totalAuthoritative],
              ['Recursive', s.totalRecursive],
              ['Dropped', s.totalDropped],
            ].map(([label, value]) => (
              <div key={label} className="widget-card analytics-extra-card">
                <p className="muted">{label}</p>
                <p className="stat-number">{fmtNum(value)}</p>
              </div>
            ))}
          </div>
        </>
      )}
    </div>
  );
}
