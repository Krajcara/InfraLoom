import { useCallback, useEffect, useRef, useState } from 'react';
import {
  Server, Globe, Key, RefreshCw, CheckCircle, XCircle,
  BarChart2, ChevronDown, ChevronUp, Settings, Plus, Trash2,
} from 'lucide-react';
import { api } from '../api';
import { useAuth } from '../context/AuthContext';

const DNS_TYPES = [
  ['technitium', 'Technitium DNS'],
  ['pihole', 'Pi-hole'],
  ['adguard', 'AdGuard Home'],
  ['bind9', 'BIND9'],
  ['windows_dns', 'Windows Server DNS'],
  ['other', 'Other'],
];

const REFRESH_OPTS = [
  [1, '1 min'],
  [5, '5 min'],
  [15, '15 min'],
  [30, '30 min'],
];

export default function DnsPage() {
  const { user } = useAuth();
  const canEdit = ['superadmin', 'admin', 'operator'].includes(user?.role);
  const [tab, setTab] = useState('local');
  const [refreshMin, setRefreshMin] = useState(5);

  return (
    <div className="page">
      <div className="page-header-row">
        <div>
          <h1>DNS</h1>
          <p className="muted">Local DNS servers and domain security records</p>
        </div>
        <select value={refreshMin} onChange={(e) => setRefreshMin(parseInt(e.target.value, 10))}>
          {REFRESH_OPTS.map(([v, l]) => (
            <option key={v} value={v}>Refresh: {l}</option>
          ))}
        </select>
      </div>

      <div className="tab-bar">
        <button className={tab === 'local' ? 'active' : ''} onClick={() => setTab('local')}>
          <Server size={15} /> Local DNS
        </button>
        <button className={tab === 'cloudflare' ? 'active' : ''} onClick={() => setTab('cloudflare')}>
          <Globe size={15} /> Cloudflare DNS
        </button>
        <button className={tab === 'manual' ? 'active' : ''} onClick={() => setTab('manual')}>
          <Key size={15} /> Manual check
        </button>
      </div>

      {tab === 'local' && <LocalDnsTab canEdit={canEdit} refreshMin={refreshMin} />}
      {tab === 'cloudflare' && <CloudflareTab canEdit={canEdit} refreshMin={refreshMin} />}
      {tab === 'manual' && <ManualCheckTab canEdit={canEdit} />}
    </div>
  );
}

// ── Local DNS ────────────────────────────────────────────────────────────

function LocalDnsTab({ canEdit, refreshMin }) {
  const [servers, setServers] = useState([]);
  const [loading, setLoading] = useState(true);
  const [form, setForm] = useState(null);

  const load = useCallback(() => {
    setLoading(true);
    api.get('/dns/local').then(setServers).catch(() => {}).finally(() => setLoading(false));
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  const primary = servers.find((s) => s.role === 'primary');
  const backup = servers.find((s) => s.role === 'backup');

  async function remove(s) {
    if (!confirm(`Remove ${s.role} DNS server (${s.label || s.ip})?`)) return;
    await api.del(`/dns/local/${s.id}`);
    load();
  }

  async function save(data) {
    await api.post('/dns/local', data);
    setForm(null);
    load();
  }

  if (loading) return <p className="muted">Loading...</p>;

  return (
    <div className="dns-grid-2col">
      {primary ? (
        <LocalDnsCard server={primary} canEdit={canEdit} refreshMin={refreshMin} onEdit={() => setForm(primary)} onDelete={() => remove(primary)} />
      ) : (
        canEdit && <AddDnsPlaceholder label="Add Primary DNS" onClick={() => setForm({ role: 'primary' })} />
      )}
      {backup ? (
        <LocalDnsCard server={backup} canEdit={canEdit} refreshMin={refreshMin} onEdit={() => setForm(backup)} onDelete={() => remove(backup)} />
      ) : (
        canEdit && <AddDnsPlaceholder label="Add Backup DNS" onClick={() => setForm({ role: 'backup' })} />
      )}
      {!primary && !backup && !canEdit && <p className="muted">No local DNS configured.</p>}

      {form && <LocalDnsFormModal initial={form} onSave={save} onCancel={() => setForm(null)} />}
    </div>
  );
}

function AddDnsPlaceholder({ label, onClick }) {
  return (
    <button className="dns-add-placeholder" onClick={onClick}>
      <Server size={28} />
      <span>{label}</span>
    </button>
  );
}

function LocalDnsCard({ server, canEdit, refreshMin, onEdit, onDelete }) {
  const [status, setStatus] = useState(null);
  const [checking, setChecking] = useState(false);
  const intervalRef = useRef(null);

  const check = useCallback(async () => {
    setChecking(true);
    try {
      const data = await api.get(`/dns/local/${server.id}/status`);
      setStatus(data);
    } catch {
      setStatus({ online: false });
    } finally {
      setChecking(false);
    }
  }, [server.id]);

  // Auto-check immediately on mount, then on the configured refresh interval —
  // matches v1: the card never sits at "not checked" waiting for a manual click.
  useEffect(() => {
    check();
    intervalRef.current = setInterval(check, refreshMin * 60 * 1000);
    return () => clearInterval(intervalRef.current);
  }, [check, refreshMin]);

  const typeLabel = DNS_TYPES.find((t) => t[0] === server.type)?.[1] || server.type;

  return (
    <div className="card dns-server-card">
      <div className="dns-server-card-header">
        <div className="dns-server-card-title">
          <span className={`role-chip role-chip-${server.role}`}>{server.role}</span>
          <strong>{server.label || typeLabel}</strong>
        </div>
        <div className="dns-server-card-status">
          {status ? (
            status.online ? (
              <span className="status-inline status-inline-up"><CheckCircle size={15} /> Online</span>
            ) : (
              <span className="status-inline status-inline-down"><XCircle size={15} /> Offline</span>
            )
          ) : (
            <span className="muted">—</span>
          )}
          <button className="icon-btn" onClick={check} disabled={checking} title="Check now">
            <RefreshCw size={14} className={checking ? 'spin' : ''} />
          </button>
        </div>
      </div>
      <p className="mono muted dns-server-ip">{server.ip}</p>
      <p className="muted dns-server-type">{typeLabel}</p>

      {status?.online && status?.stats && ['technitium', 'pihole', 'adguard'].includes(server.type) && (
        <div className="dns-stats-block">
          <p className="dns-stats-label"><BarChart2 size={13} /> Stats — last hour</p>
          <div className="dns-stats-row">
            <div className="dns-stat-mini">
              <p className="stat-mini-value blue">{status.stats.totalQueries?.toLocaleString()}</p>
              <p className="muted">Queries</p>
            </div>
            <div className="dns-stat-mini">
              <p className="stat-mini-value red">{status.stats.totalBlocked?.toLocaleString()}</p>
              <p className="muted">Blocked</p>
            </div>
            <div className="dns-stat-mini">
              <p className="stat-mini-value purple">{status.stats.totalClients?.toLocaleString()}</p>
              <p className="muted">Clients</p>
            </div>
          </div>
        </div>
      )}

      {canEdit && (
        <div className="dns-card-actions">
          <button className="btn-link" onClick={onEdit}>Edit</button>
          <span className="muted">·</span>
          <button className="btn-link danger" onClick={onDelete}>Remove</button>
        </div>
      )}
    </div>
  );
}

function LocalDnsFormModal({ initial, onSave, onCancel }) {
  const [form, setForm] = useState({ role: initial.role || 'primary', type: initial.type || 'technitium', ip: initial.ip || '', api_key: '', label: initial.label || '' });
  const [error, setError] = useState(null);
  const [saving, setSaving] = useState(false);

  async function submit(e) {
    e.preventDefault();
    setSaving(true);
    setError(null);
    try {
      await onSave(form);
    } catch (err) {
      setError(err.message);
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="modal-backdrop" onClick={onCancel}>
      <div className="modal-box" onClick={(e) => e.stopPropagation()}>
        <h2>{initial.id ? 'Edit' : `Add ${form.role === 'backup' ? 'Backup' : 'Primary'}`} DNS</h2>
        <form onSubmit={submit} autoComplete="off">
          {error && <p className="error">{error}</p>}
          <label>
            Role
            <select value={form.role} onChange={(e) => setForm({ ...form, role: e.target.value })}>
              <option value="primary">Primary DNS</option>
              <option value="backup">Backup DNS</option>
            </select>
          </label>
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
            <input value={form.ip} onChange={(e) => setForm({ ...form, ip: e.target.value })} placeholder="192.168.1.53 or http://192.168.1.53:5380" required />
          </label>
          <label>
            Label (optional)
            <input value={form.label} onChange={(e) => setForm({ ...form, label: e.target.value })} placeholder="e.g. Home DNS" />
          </label>
          {['technitium', 'pihole', 'adguard'].includes(form.type) && (
            <label>
              API key / password
              <input type="password" value={form.api_key} onChange={(e) => setForm({ ...form, api_key: e.target.value })} placeholder={initial.id ? 'unchanged' : ''} autoComplete="new-password" name="dns_api_key_field" />
            </label>
          )}
          <div className="form-row">
            <button type="submit" disabled={saving}>{saving ? 'Saving...' : 'Save'}</button>
            <button type="button" onClick={onCancel}>Cancel</button>
          </div>
        </form>
      </div>
    </div>
  );
}

// ── Cloudflare ───────────────────────────────────────────────────────────

function RecordBadge({ value, label }) {
  return value ? (
    <span className="record-badge record-badge-ok"><CheckCircle size={11} /> {label}</span>
  ) : (
    <span className="record-badge record-badge-missing"><XCircle size={11} /> No {label}</span>
  );
}

function ZoneCard({ zone }) {
  const [open, setOpen] = useState(false);
  return (
    <div className="zone-card">
      <div className="zone-card-header">
        <div className="zone-card-title">
          <Globe size={15} />
          <span className="mono">{zone.domain}</span>
          {zone.status && <span className={`status-badge ${zone.status === 'active' ? 'status-up' : ''}`}>{zone.status}</span>}
        </div>
        <div className="zone-card-badges">
          <RecordBadge value={zone.spf} label="SPF" />
          <RecordBadge value={zone.dkim} label="DKIM" />
          <RecordBadge value={zone.dmarc} label="DMARC" />
          <RecordBadge value={zone.mx?.length > 0} label="MX" />
          <button className="icon-btn" onClick={() => setOpen(!open)}>
            {open ? <ChevronUp size={14} /> : <ChevronDown size={14} />}
          </button>
        </div>
      </div>
      {open && (
        <div className="zone-card-detail">
          {zone.spf ? <p><strong className="success">SPF</strong> <code>{zone.spf}</code></p> : <p className="error">No SPF record found</p>}
          {zone.dmarc ? <p><strong className="success">DMARC</strong> <code>{zone.dmarc}</code></p> : <p className="error">No DMARC record found</p>}
          {zone.dkim ? <p><strong className="success">DKIM</strong> selector: <strong>{zone.dkim.selector}</strong></p> : <p className="warning">No DKIM found (checked common selectors)</p>}
          {zone.mx?.length > 0 && (
            <p><strong className="muted">MX</strong> {zone.mx.slice(0, 3).map((m, i) => <span key={i} className="mono"> {m.priority} {m.exchange}</span>)}</p>
          )}
          {zone.checked_at && <p className="muted">Checked: {zone.checked_at}</p>}
        </div>
      )}
    </div>
  );
}

function CloudflareTab({ canEdit, refreshMin }) {
  const [config, setConfig] = useState(null);
  const [zones, setZones] = useState([]);
  const [loading, setLoading] = useState(false);
  const [showSetup, setShowSetup] = useState(false);
  const [token, setToken] = useState('');
  const [zoneId, setZoneId] = useState('');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState(null);
  const intervalRef = useRef(null);

  const loadConfig = useCallback(() => {
    api.get('/dns/cloudflare/config').then(setConfig).catch(() => {});
  }, []);

  const fetchZones = useCallback(async () => {
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
  }, []);

  useEffect(() => {
    loadConfig();
  }, [loadConfig]);

  useEffect(() => {
    clearInterval(intervalRef.current);
    if (!config?.configured) return;
    fetchZones();
    intervalRef.current = setInterval(fetchZones, refreshMin * 60 * 1000);
    return () => clearInterval(intervalRef.current);
  }, [config?.configured, refreshMin, fetchZones]);

  async function saveConfig(e) {
    e.preventDefault();
    setSaving(true);
    setError(null);
    try {
      await api.post('/dns/cloudflare/config', { token: token || undefined, zone_id: zoneId });
      setToken('');
      setShowSetup(false);
      loadConfig();
    } catch (err) {
      setError(err.message);
    } finally {
      setSaving(false);
    }
  }

  if (!config?.configured && !showSetup) {
    return (
      <div className="dns-add-placeholder-wide">
        <Globe size={36} className="muted" />
        <p><strong>Cloudflare not configured</strong></p>
        <p className="muted">Add your Cloudflare API token to see DNS and email security records for all zones.</p>
        {canEdit && <button onClick={() => setShowSetup(true)}><Key size={14} /> Configure Cloudflare</button>}
      </div>
    );
  }

  return (
    <div>
      <div className="card cloudflare-header-card">
        <div className="cloudflare-header-row">
          <div className="cloudflare-header-left">
            <span className={`status-dot ${config?.configured ? 'status-dot-up' : 'status-dot-unknown'}`} />
            <div>
              <p><strong>Cloudflare API</strong></p>
              <p className="muted">{config?.configured ? `Token configured — zones refresh every ${refreshMin} min` : 'Not configured'}</p>
            </div>
          </div>
          <div className="form-row">
            <button onClick={fetchZones} disabled={loading}><RefreshCw size={14} className={loading ? 'spin' : ''} /> Refresh now</button>
            {canEdit && <button className="icon-btn" onClick={() => setShowSetup(!showSetup)}><Settings size={16} /></button>}
          </div>
        </div>

        {showSetup && canEdit && (
          <form onSubmit={saveConfig} autoComplete="off" className="cloudflare-setup-form">
            {error && <p className="error">{error}</p>}
            <label>
              API Token (Zone:Read permission)
              <input type="password" value={token} onChange={(e) => setToken(e.target.value)} placeholder={config?.configured ? 'unchanged' : 'Paste API token...'} autoComplete="new-password" name="cf_token_field" />
            </label>
            <label>
              Zone ID (optional — blank = all zones)
              <input className="mono" value={zoneId} onChange={(e) => setZoneId(e.target.value)} autoComplete="off" name="cf_zone_field" />
            </label>
            <div className="form-row">
              <button type="submit" disabled={saving}><Key size={14} /> {saving ? 'Saving...' : 'Save'}</button>
              <button type="button" onClick={() => setShowSetup(false)}>Cancel</button>
            </div>
          </form>
        )}
      </div>

      {error && !showSetup && <p className="error">{error}</p>}
      {loading && zones.length === 0 && <p className="muted">Loading zones...</p>}

      {zones.length > 0 && (
        <div className="zone-list">
          <p className="muted">{zones.length} zone{zones.length !== 1 ? 's' : ''}</p>
          {zones.map((z) => (
            <ZoneCard key={z.zone_id || z.domain} zone={z} />
          ))}
        </div>
      )}
    </div>
  );
}

// ── Manual check ─────────────────────────────────────────────────────────

function ManualCheckTab({ canEdit }) {
  const [domains, setDomains] = useState([]);
  const [results, setResults] = useState([]);
  const [loading, setLoading] = useState(true);
  const [checking, setChecking] = useState(false);
  const [newDomain, setNewDomain] = useState('');
  const [addError, setAddError] = useState(null);

  const loadDomains = useCallback(() => {
    api.get('/dns/domains').then(setDomains).catch(() => {}).finally(() => setLoading(false));
  }, []);

  useEffect(() => {
    loadDomains();
  }, [loadDomains]);

  async function addDomain(e) {
    e.preventDefault();
    if (!newDomain.trim()) return;
    setAddError(null);
    try {
      await api.post('/dns/domains', { domain: newDomain.trim() });
      setNewDomain('');
      loadDomains();
    } catch (err) {
      setAddError(err.message);
    }
  }

  async function removeDomain(d) {
    await api.del(`/dns/domains/${d.id}`);
    loadDomains();
  }

  async function checkAll() {
    setChecking(true);
    try {
      const data = await api.get('/dns/check-all');
      setResults(data);
    } finally {
      setChecking(false);
    }
  }

  async function checkOne(domain) {
    setChecking(true);
    try {
      const data = await api.post('/dns/check', { domain });
      setResults((prev) => {
        const idx = prev.findIndex((r) => r.domain === domain);
        if (idx >= 0) {
          const next = [...prev];
          next[idx] = data;
          return next;
        }
        return [...prev, data];
      });
    } finally {
      setChecking(false);
    }
  }

  return (
    <div>
      {canEdit && (
        <section className="card">
          <form onSubmit={addDomain} className="form-row" autoComplete="off">
            <label>
              Add domain
              <input value={newDomain} onChange={(e) => setNewDomain(e.target.value)} placeholder="example.com" />
            </label>
            <button type="submit"><Plus size={14} /> Add</button>
          </form>
          {addError && <p className="error">{addError}</p>}
        </section>
      )}

      {loading ? (
        <p className="muted">Loading...</p>
      ) : domains.length === 0 ? (
        <p className="muted">No domains yet.</p>
      ) : (
        <section className="card">
          <div className="dns-domains-header">
            <p className="muted">{domains.length} domain{domains.length !== 1 ? 's' : ''}</p>
            <button onClick={checkAll} disabled={checking}><RefreshCw size={14} className={checking ? 'spin' : ''} /> Check all</button>
          </div>
          <table className="table">
            <thead><tr><th>Domain</th><th>Added</th><th></th></tr></thead>
            <tbody>
              {domains.map((d) => (
                <tr key={d.id}>
                  <td className="mono">{d.domain}</td>
                  <td className="muted">{d.created_at}</td>
                  <td className="actions">
                    <button className="icon-btn" onClick={() => checkOne(d.domain)} disabled={checking}><RefreshCw size={14} className={checking ? 'spin' : ''} /></button>
                    {canEdit && <button className="icon-btn" onClick={() => removeDomain(d)}><Trash2 size={14} /></button>}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </section>
      )}

      {results.length > 0 && (
        <div className="zone-list">
          {results.map((r) => (
            <ZoneCard key={r.domain} zone={r} />
          ))}
        </div>
      )}
    </div>
  );
}
