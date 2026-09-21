import { useEffect, useState } from 'react';
import { api } from '../api';
import { useAuth } from '../context/AuthContext';

const DNS_TYPES = [
  ['technitium', 'Technitium DNS'],
  ['pihole', 'Pi-hole'],
  ['adguard', 'AdGuard Home'],
  ['bind9', 'BIND9'],
  ['windows_dns', 'Windows Server DNS'],
  ['other', 'DNS Server'],
];

export default function DnsPage() {
  const { user } = useAuth();
  const canEdit = ['superadmin', 'admin', 'operator'].includes(user?.role);

  return (
    <div className="page">
      <h1>DNS</h1>
      <LocalServersSection canEdit={canEdit} />
      <DomainsSection canEdit={canEdit} />
      <CloudflareSection canEdit={canEdit} />
    </div>
  );
}

function LocalServersSection({ canEdit }) {
  const [servers, setServers] = useState([]);
  const [statuses, setStatuses] = useState({});
  const [form, setForm] = useState(null);
  const [error, setError] = useState(null);

  async function load() {
    try {
      const data = await api.get('/dns/local');
      setServers(data);
    } catch (err) {
      setError(err.message);
    }
  }

  useEffect(() => {
    load();
  }, []);

  function openEdit(role) {
    const existing = servers.find((s) => s.role === role);
    setForm(existing ? { ...existing, api_key: '' } : { role, type: 'technitium', ip: '', api_key: '', label: '' });
  }

  async function save(e) {
    e.preventDefault();
    try {
      await api.post('/dns/local', form);
      setForm(null);
      load();
    } catch (err) {
      setError(err.message);
    }
  }

  async function remove(s) {
    if (!confirm(`Remove ${s.role} DNS server?`)) return;
    try {
      await api.del(`/dns/local/${s.id}`);
      load();
    } catch (err) {
      setError(err.message);
    }
  }

  async function checkStatus(s) {
    setStatuses((prev) => ({ ...prev, [s.id]: { loading: true } }));
    try {
      const data = await api.get(`/dns/local/${s.id}/status`);
      setStatuses((prev) => ({ ...prev, [s.id]: data }));
    } catch (err) {
      setStatuses((prev) => ({ ...prev, [s.id]: { online: false, error: err.message } }));
    }
  }

  const primary = servers.find((s) => s.role === 'primary');
  const backup = servers.find((s) => s.role === 'backup');

  return (
    <section className="card">
      <h2>Local DNS servers</h2>
      {error && <p className="error">{error}</p>}

      {['primary', 'backup'].map((role) => {
        const s = role === 'primary' ? primary : backup;
        const st = s ? statuses[s.id] : null;
        return (
          <div key={role} className="dns-server-row">
            <strong className="dns-role-label">{role}</strong>
            {s ? (
              <>
                <span className="mono">{s.ip}</span>
                <span className="muted">{DNS_TYPES.find((t) => t[0] === s.type)?.[1] || s.type}</span>
                {st?.loading ? (
                  <span className="muted">checking...</span>
                ) : st ? (
                  <span className={`status-badge ${st.online ? 'status-up' : 'status-down'}`}>{st.online ? 'online' : 'offline'}</span>
                ) : (
                  <span className="muted">not checked</span>
                )}
                {st?.stats && (
                  <span className="muted">
                    {st.stats.totalQueries} queries · {st.stats.totalBlocked} blocked · {st.stats.totalClients} clients (last hour)
                  </span>
                )}
                <button className="btn-link" onClick={() => checkStatus(s)}>Check</button>
                {canEdit && <button className="btn-link" onClick={() => openEdit(role)}>Edit</button>}
                {canEdit && <button className="btn-link danger" onClick={() => remove(s)}>Remove</button>}
              </>
            ) : (
              canEdit && <button className="btn-link" onClick={() => openEdit(role)}>+ Configure {role}</button>
            )}
          </div>
        );
      })}

      {form && (
        <form onSubmit={save} autoComplete="off" className="dns-form">
          <div className="form-row">
            <label>
              Type
              <select value={form.type} onChange={(e) => setForm({ ...form, type: e.target.value })}>
                {DNS_TYPES.map(([v, l]) => (
                  <option key={v} value={v}>{l}</option>
                ))}
              </select>
            </label>
            <label>
              IP / URL
              <input value={form.ip} onChange={(e) => setForm({ ...form, ip: e.target.value })} placeholder="192.168.1.53 or http://dns.local:5380" required />
            </label>
            <label>
              API token / password
              <input
                type="password"
                value={form.api_key}
                onChange={(e) => setForm({ ...form, api_key: e.target.value })}
                placeholder={form.id ? 'unchanged' : 'optional'}
                autoComplete="new-password"
                name="dns_api_key_field"
              />
            </label>
            <label>
              Label
              <input value={form.label || ''} onChange={(e) => setForm({ ...form, label: e.target.value })} />
            </label>
          </div>
          <div className="form-row">
            <button type="submit">Save</button>
            <button type="button" onClick={() => setForm(null)}>Cancel</button>
          </div>
        </form>
      )}
    </section>
  );
}

function DomainsSection({ canEdit }) {
  const [domains, setDomains] = useState([]);
  const [results, setResults] = useState({});
  const [newDomain, setNewDomain] = useState('');
  const [error, setError] = useState(null);
  const [checkingAll, setCheckingAll] = useState(false);

  async function load() {
    try {
      const data = await api.get('/dns/domains');
      setDomains(data);
    } catch (err) {
      setError(err.message);
    }
  }

  useEffect(() => {
    load();
  }, []);

  async function add(e) {
    e.preventDefault();
    try {
      await api.post('/dns/domains', { domain: newDomain });
      setNewDomain('');
      load();
    } catch (err) {
      setError(err.message);
    }
  }

  async function remove(d) {
    try {
      await api.del(`/dns/domains/${d.id}`);
      load();
    } catch (err) {
      setError(err.message);
    }
  }

  async function checkOne(domain) {
    setResults((prev) => ({ ...prev, [domain]: { loading: true } }));
    try {
      const data = await api.post('/dns/check', { domain });
      setResults((prev) => ({ ...prev, [domain]: data }));
    } catch (err) {
      setResults((prev) => ({ ...prev, [domain]: { status: 'error', error: err.message } }));
    }
  }

  async function checkAll() {
    setCheckingAll(true);
    try {
      const data = await api.get('/dns/check-all');
      const map = {};
      data.forEach((r) => (map[r.domain] = r));
      setResults(map);
    } catch (err) {
      setError(err.message);
    } finally {
      setCheckingAll(false);
    }
  }

  return (
    <section className="card">
      <h2>Monitored domains</h2>
      <p className="muted">SPF / DKIM / DMARC / MX / A / NS lookup, straight from live DNS.</p>
      {error && <p className="error">{error}</p>}

      {canEdit && (
        <form onSubmit={add} className="form-row" autoComplete="off">
          <label>
            Domain
            <input value={newDomain} onChange={(e) => setNewDomain(e.target.value)} placeholder="example.com" required />
          </label>
          <button type="submit">+ Add</button>
          <button type="button" onClick={checkAll} disabled={checkingAll}>{checkingAll ? 'Checking...' : 'Check all'}</button>
        </form>
      )}

      <table className="table">
        <thead>
          <tr>
            <th>Domain</th>
            <th>SPF</th>
            <th>DKIM</th>
            <th>DMARC</th>
            <th>MX</th>
            <th></th>
          </tr>
        </thead>
        <tbody>
          {domains.map((d) => {
            const r = results[d.domain];
            return (
              <tr key={d.id}>
                <td>{d.domain}</td>
                <td>{r?.loading ? '…' : r ? (r.spf ? '✓' : '✕') : '—'}</td>
                <td>{r?.loading ? '…' : r ? (r.dkim ? `✓ (${r.dkim.selector})` : '✕') : '—'}</td>
                <td>{r?.loading ? '…' : r ? (r.dmarc ? '✓' : '✕') : '—'}</td>
                <td>{r?.loading ? '…' : r ? r.mx?.length || 0 : '—'}</td>
                <td className="actions">
                  <button className="btn-link" onClick={() => checkOne(d.domain)}>Check</button>
                  {canEdit && <button className="btn-link danger" onClick={() => remove(d)}>Remove</button>}
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </section>
  );
}

function CloudflareSection({ canEdit }) {
  const [config, setConfig] = useState(null);
  const [token, setToken] = useState('');
  const [zoneId, setZoneId] = useState('');
  const [zones, setZones] = useState(null);
  const [error, setError] = useState(null);
  const [loading, setLoading] = useState(false);
  const [message, setMessage] = useState(null);

  useEffect(() => {
    api.get('/dns/cloudflare/config').then(setConfig).catch((err) => setError(err.message));
  }, []);

  async function save(e) {
    e.preventDefault();
    try {
      await api.post('/dns/cloudflare/config', { token, zone_id: zoneId });
      setToken('');
      setMessage('Saved.');
      const c = await api.get('/dns/cloudflare/config');
      setConfig(c);
    } catch (err) {
      setError(err.message);
    }
  }

  async function loadZones() {
    setLoading(true);
    setError(null);
    try {
      const data = await api.get('/dns/cloudflare/zones');
      setZones(data);
    } catch (err) {
      setError(err.message);
    } finally {
      setLoading(false);
    }
  }

  return (
    <section className="card">
      <h2>Cloudflare</h2>
      {error && <p className="error">{error}</p>}
      {message && <p className="success">{message}</p>}
      {config && <p className="muted">{config.configured ? 'API token configured.' : 'Not configured.'}</p>}

      {canEdit && (
        <form onSubmit={save} className="form-row" autoComplete="off">
          <label>
            API token
            <input type="password" value={token} onChange={(e) => setToken(e.target.value)} placeholder={config?.configured ? 'unchanged' : ''} autoComplete="new-password" name="cf_token_field" />
          </label>
          <label>
            Zone ID (optional, limits to one zone)
            <input value={zoneId} onChange={(e) => setZoneId(e.target.value)} autoComplete="off" name="cf_zone_field" />
          </label>
          <button type="submit">Save</button>
        </form>
      )}

      <div className="filters">
        <button onClick={loadZones} disabled={loading || !config?.configured}>{loading ? 'Loading...' : 'Load zones'}</button>
      </div>

      {zones && (
        <table className="table">
          <thead>
            <tr>
              <th>Domain</th>
              <th>Status</th>
              <th>SPF</th>
              <th>DKIM</th>
              <th>DMARC</th>
              <th>MX</th>
            </tr>
          </thead>
          <tbody>
            {zones.map((z) => (
              <tr key={z.zone_id}>
                <td>{z.domain}</td>
                <td>{z.status}</td>
                <td>{z.spf ? '✓' : '✕'}</td>
                <td>{z.dkim ? `✓ (${z.dkim.selector})` : '✕'}</td>
                <td>{z.dmarc ? '✓' : '✕'}</td>
                <td>{z.mx?.length || 0}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </section>
  );
}
