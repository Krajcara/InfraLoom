import { useEffect, useState } from 'react';
import { Globe, Search, Server } from 'lucide-react';
import { api } from '../api';

const RECORD_TYPES = ['A', 'AAAA', 'CNAME', 'MX', 'NS', 'TXT', 'SOA', 'CAA'];

export default function MyIpPage() {
  const [tab, setTab] = useState('cards');

  return (
    <div className="page">
      <h1>MyIP</h1>
      <p className="muted">IP lookup and DNS resolver toolbox.</p>

      <div className="tab-bar">
        <button className={tab === 'cards' ? 'active' : ''} onClick={() => setTab('cards')}>
          <Server size={15} /> IP Cards
        </button>
        <button className={tab === 'query' ? 'active' : ''} onClick={() => setTab('query')}>
          <Search size={15} /> Query IP
        </button>
        <button className={tab === 'dns' ? 'active' : ''} onClick={() => setTab('dns')}>
          <Globe size={15} /> DNS Resolver
        </button>
      </div>

      {tab === 'cards' && <IpCardsTab />}
      {tab === 'query' && <QueryIpTab />}
      {tab === 'dns' && <DnsResolverTab />}
    </div>
  );
}

function IpCard({ result }) {
  if (result.error) {
    return (
      <div className="card myip-card">
        <p className="muted">{result.source}</p>
        <p className="error">{result.error}</p>
      </div>
    );
  }
  return (
    <div className="card myip-card">
      <p className="muted">{result.source}</p>
      <p className="myip-ip mono">{result.ip}</p>
      <div className="myip-fields">
        <div><span className="muted">Location</span><span>{[result.city, result.region, result.country_name].filter(Boolean).join(', ') || '—'}</span></div>
        <div><span className="muted">Organization</span><span>{result.org || '—'}</span></div>
        <div><span className="muted">ASN</span><span className="mono">{result.asn || '—'}</span></div>
        <div><span className="muted">Coordinates</span><span className="mono">{result.latitude != null ? `${result.latitude}, ${result.longitude}` : '—'}</span></div>
        {result.timezone && <div><span className="muted">Timezone</span><span>{result.timezone}</span></div>}
      </div>
    </div>
  );
}

function IpCardsTab() {
  const [results, setResults] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);

  async function load() {
    setLoading(true);
    setError(null);
    try {
      const data = await api.get('/myip/cards');
      setResults(data.results);
    } catch (err) {
      setError(err.message);
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    load();
  }, []);

  return (
    <div>
      <div className="filters">
        <p className="muted">This server's public IP, cross-checked against multiple sources.</p>
        <button onClick={load} disabled={loading}>{loading ? 'Refreshing...' : 'Refresh'}</button>
      </div>
      {error && <p className="error">{error}</p>}
      {loading && !results ? (
        <p className="muted">Looking up...</p>
      ) : (
        <div className="myip-card-grid">
          {results?.map((r) => (
            <IpCard key={r.source} result={r} />
          ))}
        </div>
      )}
    </div>
  );
}

function QueryIpTab() {
  const [ip, setIp] = useState('');
  const [results, setResults] = useState(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(null);

  async function query(e) {
    e.preventDefault();
    if (!ip.trim()) return;
    setLoading(true);
    setError(null);
    setResults(null);
    try {
      const data = await api.get(`/myip/query?ip=${encodeURIComponent(ip.trim())}`);
      setResults(data.results);
    } catch (err) {
      setError(err.message);
    } finally {
      setLoading(false);
    }
  }

  return (
    <div>
      <section className="card">
        <form onSubmit={query} className="form-row" autoComplete="off">
          <label>
            IP address
            <input value={ip} onChange={(e) => setIp(e.target.value)} placeholder="8.8.8.8 or 2606:4700:4700::1111" />
          </label>
          <button type="submit" disabled={loading}>{loading ? 'Looking up...' : 'Query'}</button>
        </form>
      </section>
      {error && <p className="error">{error}</p>}
      {results && (
        <div className="myip-card-grid">
          {results.map((r) => (
            <IpCard key={r.source} result={r} />
          ))}
        </div>
      )}
    </div>
  );
}

function DnsResolverTab() {
  const [hostname, setHostname] = useState('');
  const [type, setType] = useState('A');
  const [results, setResults] = useState(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(null);

  async function resolve(e) {
    e.preventDefault();
    if (!hostname.trim()) return;
    setLoading(true);
    setError(null);
    setResults(null);
    try {
      const data = await api.get(`/myip/dns-resolver?hostname=${encodeURIComponent(hostname.trim())}&type=${type}`);
      setResults(data.results);
    } catch (err) {
      setError(err.message);
    } finally {
      setLoading(false);
    }
  }

  // Group by provider so udp/doh rows for the same server sit together.
  const grouped = results
    ? Object.values(
        results.reduce((acc, r) => {
          acc[r.id] = acc[r.id] || { provider: r.provider, country: r.country, rows: [] };
          acc[r.id].rows.push(r);
          return acc;
        }, {})
      )
    : null;

  return (
    <div>
      <section className="card">
        <form onSubmit={resolve} className="form-row" autoComplete="off">
          <label>
            Hostname
            <input value={hostname} onChange={(e) => setHostname(e.target.value)} placeholder="example.com" />
          </label>
          <label>
            Record type
            <select value={type} onChange={(e) => setType(e.target.value)}>
              {RECORD_TYPES.map((t) => (
                <option key={t} value={t}>{t}</option>
              ))}
            </select>
          </label>
          <button type="submit" disabled={loading}>{loading ? 'Resolving...' : 'Resolve'}</button>
        </form>
      </section>
      {error && <p className="error">{error}</p>}
      {grouped && (
        <section className="card">
          <table className="table">
            <thead>
              <tr><th>Provider</th><th>Country</th><th>Transport</th><th>Result</th></tr>
            </thead>
            <tbody>
              {grouped.map((g) =>
                g.rows.map((row, i) => (
                  <tr key={`${g.provider}-${row.transport}`}>
                    {i === 0 && <td rowSpan={g.rows.length}>{g.provider}</td>}
                    {i === 0 && <td rowSpan={g.rows.length} className="muted">{g.country}</td>}
                    <td className="muted">{row.transport.toUpperCase()}</td>
                    <td className="mono">
                      {row.result === 'N/A' ? <span className="muted">N/A</span> : Array.isArray(row.result) ? row.result.join(', ') : row.result}
                    </td>
                  </tr>
                ))
              )}
            </tbody>
          </table>
        </section>
      )}
    </div>
  );
}
