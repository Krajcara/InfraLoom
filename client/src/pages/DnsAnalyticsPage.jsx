import { useCallback, useEffect, useState } from 'react';
import { Activity, Shield, Database, Users, Globe, RefreshCw } from 'lucide-react';
import { api } from '../api';
import { useAuth } from '../context/AuthContext';
import './dnsAnalytics.css';

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

function LocalDnsAnalytics() {
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
    <div>
      <div className="page-header-row">
        <div>
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

// ── Cloudflare: the queries that the domains hosted there get ───────────────────────────────────────

const CF_RANGES = [['24h', 'Last 24h'], ['7d', 'Last 7 days'], ['30d', 'Last 30 days']];
const pct = (n, total) => (total > 0 ? `${((n / total) * 100).toFixed(n / total < 0.1 ? 1 : 0)}%` : '—');

function QueryBars({ s }) {
  const [hover, setHover] = useState(null);
  const pts = s.timeline || [];
  if (!pts.length) return <p className="muted cf-empty">{s.timeline === null ? 'The timeline is not available (see below).' : 'No queries in this range.'}</p>;
  const W = 900; const H = 150; const L = 48; const R = 8; const T = 8; const B = 22;
  const max = Math.max(1, ...pts.map((p) => p.queries)); const n = Math.max(pts.length, Math.round((s.to - s.from) / s.bucket));
  const bw = (W - L - R) / n; const x0 = Math.floor(s.from / s.bucket) * s.bucket;
  const fmt = (t) => { const d = new Date(t * 1000); return s.bucket < 86400 ? d.toLocaleString([], { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' }) : d.toLocaleDateString(); };
  return (
    <div>
      <svg viewBox={`0 0 ${W} ${H}`} className="cf-svg" role="img" aria-label="Queries over time" onMouseLeave={() => setHover(null)}>
        {[0, 0.5, 1].map((f) => (<g key={f}><line x1={L} x2={W - R} y1={T + (H - T - B) * (1 - f)} y2={T + (H - T - B) * (1 - f)} className="cf-grid" /><text x={L - 6} y={T + (H - T - B) * (1 - f) + 4} textAnchor="end" className="cf-axis">{fmtNum(Math.round(max * f))}</text></g>))}
        {pts.map((p) => <rect key={p.ts} className="cf-bar" onMouseEnter={() => setHover(p)} x={L + ((p.ts - x0) / s.bucket) * bw + 0.5} y={T + (H - T - B) * (1 - p.queries / max)} width={Math.max(1, bw - 1)} height={(H - T - B) * (p.queries / max)} />)}
        <text x={L} y={H - 6} className="cf-axis">{fmt(s.from)}</text><text x={W - R} y={H - 6} textAnchor="end" className="cf-axis">{fmt(s.to)}</text>
      </svg>
      <div className="cf-hover" aria-live="polite">{hover ? <><strong>{fmt(hover.ts)}</strong> — {hover.queries.toLocaleString()} queries</> : <span className="muted">Move over the bars for the numbers.</span>}</div>
    </div>
  );
}

function CloudflareAnalytics() {
  const { user } = useAuth();
  const isAdmin = ['superadmin', 'admin'].includes(user?.role);
  const [range, setRange] = useState('24h');
  const [zone, setZone] = useState('all');
  const [zones, setZones] = useState([]);
  const [data, setData] = useState(null);
  const [error, setError] = useState(null);
  const [loading, setLoading] = useState(false);

  const load = useCallback((refresh = false) => {
    setLoading(true);
    api.get(`/dns-analytics/cloudflare/stats?zone=${zone}&range=${range}${refresh ? '&refresh=1' : ''}`)
      .then((d) => { setData(d); setError(null); if (d.zone === 'all') setZones(d.zones.map((z) => ({ id: z.zone, name: z.name }))); })
      .catch((e) => { setData(null); setError(e.message); })
      .finally(() => setLoading(false));
  }, [zone, range]);
  useEffect(() => { load(); }, [load]);

  const noToken = error && /token is not set/.test(error);
  const codes = data?.top?.codes || [];
  const codeTotal = codes.reduce((t, c) => t + c.count, 0);
  const share = (name) => pct(codes.find((c) => c.name === name)?.count || 0, codeTotal);
  const hours = data ? (data.to - data.from) / 3600 : 1;

  return (
    <div>
      <div className="page-header-row">
        <p className="muted">The queries that your domains get at Cloudflare, where they are hosted</p>
        <div className="analytics-controls">
          {zones.length > 0 && (
            <select value={zone} onChange={(e) => setZone(e.target.value)} aria-label="Domain">
              <option value="all">All domains</option>
              {zones.map((z) => <option key={z.id} value={z.id}>{z.name}</option>)}
            </select>
          )}
          <div className="tab-bar tab-bar-compact">{CF_RANGES.map(([v, l]) => <button key={v} className={range === v ? 'active' : ''} onClick={() => setRange(v)}>{l}</button>)}</div>
          <button className="icon-btn" onClick={() => load(true)} disabled={loading} aria-label="Refresh"><RefreshCw size={16} className={loading ? 'spin' : ''} /></button>
        </div>
      </div>

      {noToken && <div className="card"><p>The Cloudflare API token is not set. It is kept on the <a href="/dns">DNS page</a>, under Cloudflare. For these figures it needs <strong>Zone → Analytics → Read</strong> as well, besides Zone → Zone → Read.</p></div>}
      {error && !noToken && <div className="card"><p className="error" role="alert">{error}</p></div>}
      {loading && !data && !error && <p className="muted">Loading...</p>}

      {data && (
        <>
          <div className="analytics-stats-grid">
            <StatCard icon={Activity} label="Queries" value={data.queries} color="blue" />
            <StatCard icon={RefreshCw} label={data.bucket >= 86400 ? 'Per day (average)' : 'Per hour (average)'} value={Math.round(data.queries / (data.bucket >= 86400 ? hours / 24 : hours))} color="purple" />
            {data.zone !== 'all' && <div className="widget-card analytics-stat-card"><div className="analytics-stat-icon analytics-stat-icon-amber"><Globe size={18} /></div><div><p className="muted">Name does not exist</p><p className="stat-number">{codes.length ? share('NXDOMAIN') : '—'}</p></div></div>}
            {data.zone !== 'all' && <div className="widget-card analytics-stat-card"><div className="analytics-stat-icon analytics-stat-icon-red"><Shield size={18} /></div><div><p className="muted">Server failure</p><p className="stat-number">{codes.length ? share('SERVFAIL') : '—'}</p></div></div>}
          </div>

          <div className="card"><QueryBars s={data} /></div>

          {data.zone === 'all' ? (
            <div className="card">
              <h3>Domains</h3>
              <table className="table cf-zones"><thead><tr><th>Domain</th><th className="num">Queries</th><th /></tr></thead>
                <tbody>{data.zones.map((z) => (
                  <tr key={z.zone} className="cf-zone" onClick={() => setZone(z.zone)} tabIndex={0} onKeyDown={(e) => e.key === 'Enter' && setZone(z.zone)} aria-label={`Look into ${z.name}`}>
                    <td><strong>{z.name}</strong>{data.errors[z.name] && <div className="txt-bad cf-err" title={data.errors[z.name]}>{data.errors[z.name]}</div>}</td>
                    <td className="num mono">{z.queries === null ? '—' : z.queries.toLocaleString()}</td>
                    <td className="cf-share"><div className="top-list-track"><div className="top-list-bar bar-blue" style={{ width: `${data.queries ? Math.round(((z.queries || 0) / Math.max(1, data.zones[0].queries || 1)) * 100) : 0}%` }} /></div></td>
                  </tr>))}</tbody></table>
              <p className="muted cf-note">Click a domain for the names that were asked, the record types, the answers and the data centres.</p>
            </div>
          ) : (
            <>
              <h3 className="cf-h3">{data.name}</h3>
              <div className="analytics-top-grid cf-top">
                {[['names', 'Most queried names', 'bar-blue'], ['types', 'Record types', 'bar-purple'], ['codes', 'Answers (response codes)', 'bar-green'], ['colos', 'Cloudflare data centres', 'bar-amber']].map(([k, title, color]) => (
                  data.errors[k]
                    ? <div key={k} className="card"><h3>{title}</h3><p className="muted">Not available: {data.errors[k]}</p></div>
                    : <TopList key={k} title={title} items={data.top[k]} nameKey="name" valueKey="count" colorClass={color} />
                ))}
              </div>
              {data.errors.timeline && <p className="muted">Timeline not available: {data.errors.timeline}</p>}
            </>
          )}
          <p className="muted cf-note">From Cloudflare{data.cached ? ' (remembered for up to five minutes)' : ''}, {new Date(data.fetched_at).toLocaleTimeString()}. Cloudflare keeps these figures for a limited time that depends on the plan.</p>
          {isAdmin && <CloudflareRaw zone={data.zone === 'all' ? null : data.zone} again={data.fetched_at} />}
        </>
      )}
    </div>
  );
}

/** What Cloudflare last answered, for an administrator: the way to see why a figure is missing or which field a value comes from. */
function CloudflareRaw({ zone, again }) {
  const [rows, setRows] = useState(null);
  const [open, setOpen] = useState(false);
  useEffect(() => { if (open) api.get(`/dns-analytics/cloudflare/raw${zone ? `?zone=${zone}` : ''}`).then(setRows).catch(() => setRows([])); }, [open, zone, again]);
  return (
    <details className="cf-raw" onToggle={(e) => setOpen(e.currentTarget.open)}>
      <summary>What Cloudflare answered</summary>
      {rows && rows.length === 0 && <p className="muted">Nothing yet.</p>}
      {rows && rows.slice(-6).map((r) => <div key={`${r.part}${r.at}`}><p className="muted">{r.part} · HTTP {r.http} · {new Date(r.at).toLocaleTimeString()}</p><pre className="cf-pre">{r.response}</pre></div>)}
    </details>
  );
}

export default function DnsAnalyticsPage() {
  const [tab, setTab] = useState('local');
  return (
    <div className="page">
      <h1>DNS Analytics</h1>
      <div className="tab-bar cf-tabs" role="tablist">
        <button role="tab" aria-selected={tab === 'local'} className={tab === 'local' ? 'active' : ''} onClick={() => setTab('local')}>Local DNS (Technitium)</button>
        <button role="tab" aria-selected={tab === 'cloudflare'} className={tab === 'cloudflare' ? 'active' : ''} onClick={() => setTab('cloudflare')}>Cloudflare: your domains</button>
      </div>
      {tab === 'local' ? <LocalDnsAnalytics /> : <CloudflareAnalytics />}
    </div>
  );
}
