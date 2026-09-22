import { useEffect, useState } from 'react';
import { RefreshCw, Search, Power, Trash2, ChevronDown, ChevronUp, Star } from 'lucide-react';
import { api } from '../api';
import { useAuth } from '../context/AuthContext';
import { useSocket } from '../hooks/useSocket';

export default function NetworkScannerPage() {
  const { user } = useAuth();
  const canEdit = ['superadmin', 'admin', 'operator'].includes(user?.role);
  const canConfig = ['superadmin', 'admin'].includes(user?.role);

  const [devices, setDevices] = useState([]);
  const [status, setStatus] = useState(null);
  const [filter, setFilter] = useState('all'); // all | online | offline
  const [search, setSearch] = useState('');
  const [expandedId, setExpandedId] = useState(null);
  const [error, setError] = useState(null);
  const [showConfig, setShowConfig] = useState(false);

  async function load() {
    try {
      const params = new URLSearchParams();
      if (filter === 'online') params.set('online', '1');
      if (filter === 'offline') params.set('online', '0');
      if (search.trim()) params.set('search', search.trim());
      const [d, s] = await Promise.all([api.get(`/network-scanner/devices?${params}`), api.get('/network-scanner/status')]);
      setDevices(d.devices);
      setStatus(s);
    } catch (err) {
      setError(err.message);
    }
  }

  useEffect(() => {
    load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [filter, search]);

  useSocket({
    'netscan:complete': () => load(),
    'netscan:device': () => load(),
  });

  async function triggerScan() {
    setError(null);
    try {
      await api.post('/network-scanner/scan');
    } catch (err) {
      setError(err.message);
    }
  }

  return (
    <div className="page">
      <div className="page-header-row">
        <div>
          <h1>Network Scanner</h1>
          <p className="muted">Persistent device inventory via arp-scan — {status ? `${status.online}/${status.total} devices online` : ''}</p>
        </div>
        {canEdit && (
          <button onClick={triggerScan} disabled={status?.scanning}>
            <RefreshCw size={14} className={status?.scanning ? 'spin' : ''} /> {status?.scanning ? 'Scanning...' : 'Scan now'}
          </button>
        )}
      </div>

      {error && <p className="error">{error}</p>}

      <div className="filters">
        <div className="tab-bar tab-bar-compact">
          <button className={filter === 'all' ? 'active' : ''} onClick={() => setFilter('all')}>All</button>
          <button className={filter === 'online' ? 'active' : ''} onClick={() => setFilter('online')}>Online</button>
          <button className={filter === 'offline' ? 'active' : ''} onClick={() => setFilter('offline')}>Offline</button>
        </div>
        <div className="search-box">
          <Search size={14} />
          <input value={search} onChange={(e) => setSearch(e.target.value)} placeholder="Search name, IP, MAC, vendor..." />
        </div>
        {canConfig && <button onClick={() => setShowConfig(!showConfig)}>Settings</button>}
      </div>

      {showConfig && canConfig && <ConfigSection onSaved={() => setShowConfig(false)} />}

      <section className="card">
        <table className="table">
          <thead>
            <tr><th></th><th>Name</th><th>IP</th><th>MAC</th><th>Vendor</th><th>Status</th><th>First seen</th><th>Last seen</th><th></th></tr>
          </thead>
          <tbody>
            {devices.map((d) => (
              <DeviceRow
                key={d.id}
                device={d}
                canEdit={canEdit}
                expanded={expandedId === d.id}
                onToggle={() => setExpandedId(expandedId === d.id ? null : d.id)}
                onChanged={load}
              />
            ))}
            {devices.length === 0 && (
              <tr><td colSpan={9} className="muted">No devices found yet — click "Scan now" above.</td></tr>
            )}
          </tbody>
        </table>
      </section>
    </div>
  );
}

function DeviceRow({ device: d, canEdit, expanded, onToggle, onChanged }) {
  const [name, setName] = useState(d.name || '');
  const [notes, setNotes] = useState(d.notes || '');
  const [scans, setScans] = useState(null);
  const [events, setEvents] = useState(null);
  const [scanning, setScanning] = useState(false);
  const [error, setError] = useState(null);

  useEffect(() => {
    if (!expanded) return;
    api.get(`/network-scanner/devices/${d.id}/scans`).then((r) => setScans(r.scans));
    api.get(`/network-scanner/devices/${d.id}/events`).then((r) => setEvents(r.events));
    if (d.is_new) api.post(`/network-scanner/devices/${d.id}/dismiss-new`).catch(() => {});
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [expanded]);

  async function save() {
    try {
      await api.put(`/network-scanner/devices/${d.id}`, { name, notes });
      onChanged();
    } catch (err) {
      setError(err.message);
    }
  }

  async function toggleFavorite() {
    try {
      await api.put(`/network-scanner/devices/${d.id}`, { is_favorite: !d.is_favorite });
      onChanged();
    } catch (err) {
      setError(err.message);
    }
  }

  async function deepScan() {
    setScanning(true);
    setError(null);
    try {
      const r = await api.post(`/network-scanner/devices/${d.id}/deep-scan`);
      setScans((prev) => [{ ports: r.ports, scanned_at: 'just now' }, ...(prev || [])]);
    } catch (err) {
      setError(err.message);
    } finally {
      setScanning(false);
    }
  }

  async function wake() {
    setError(null);
    try {
      await api.post(`/network-scanner/devices/${d.id}/wake`);
    } catch (err) {
      setError(err.message);
    }
  }

  async function archive() {
    if (!confirm(`Remove ${d.name || d.mac} from inventory?`)) return;
    await api.del(`/network-scanner/devices/${d.id}`);
    onChanged();
  }

  return (
    <>
      <tr>
        <td>
          <button className="icon-btn" onClick={onToggle}>{expanded ? <ChevronUp size={14} /> : <ChevronDown size={14} />}</button>
        </td>
        <td>
          {d.name || <span className="muted">unnamed</span>}
          {d.is_new === 1 && <span className="status-badge status-degraded netscan-new-badge">new</span>}
          {d.is_favorite === 1 && <Star size={12} className="netscan-star" />}
        </td>
        <td className="mono">{d.ip || '—'}</td>
        <td className="mono muted">{d.mac}</td>
        <td className="muted">{d.vendor || '—'}</td>
        <td><span className={`status-badge ${d.is_online ? 'status-up' : 'status-down'}`}>{d.is_online ? 'online' : 'offline'}</span></td>
        <td className="muted">{d.first_seen}</td>
        <td className="muted">{d.last_seen}</td>
        <td className="actions">
          {canEdit && !d.is_online && (
            <button className="icon-btn" title="Wake on LAN" onClick={wake}><Power size={14} /></button>
          )}
          {canEdit && <button className="icon-btn" onClick={toggleFavorite} title="Favorite"><Star size={14} className={d.is_favorite ? 'netscan-star-active' : ''} /></button>}
          {canEdit && <button className="icon-btn" onClick={archive} title="Remove"><Trash2 size={14} /></button>}
        </td>
      </tr>
      {expanded && (
        <tr>
          <td colSpan={9}>
            <div className="netscan-detail">
              {error && <p className="error">{error}</p>}
              {canEdit && (
                <div className="form-row">
                  <label>
                    Name
                    <input value={name} onChange={(e) => setName(e.target.value)} placeholder="Living room TV" />
                  </label>
                  <label>
                    Notes
                    <input value={notes} onChange={(e) => setNotes(e.target.value)} placeholder="Optional" />
                  </label>
                  <button onClick={save}>Save</button>
                  <button onClick={deepScan} disabled={scanning || !d.ip}>{scanning ? 'Scanning...' : 'Deep scan (nmap)'}</button>
                </div>
              )}

              {scans?.length > 0 && (
                <div className="netscan-scan-block">
                  <p className="muted">Last deep scan — {scans[0].scanned_at}</p>
                  {scans[0].ports.length === 0 ? (
                    <p className="muted">No open ports found.</p>
                  ) : (
                    <table className="table">
                      <thead><tr><th>Port</th><th>Protocol</th><th>Service</th><th>Product</th></tr></thead>
                      <tbody>
                        {scans[0].ports.map((p, i) => (
                          <tr key={i}>
                            <td>{p.port}</td>
                            <td className="muted">{p.protocol}</td>
                            <td>{p.service || '—'}</td>
                            <td className="muted">{[p.product, p.version].filter(Boolean).join(' ') || '—'}</td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  )}
                </div>
              )}

              {events?.length > 0 && (
                <div className="netscan-events-block">
                  <p className="muted">Recent activity</p>
                  <ul className="widget-list">
                    {events.slice(0, 8).map((e) => (
                      <li key={e.id} className="muted">{e.event_type} — {e.created_at}</li>
                    ))}
                  </ul>
                </div>
              )}
            </div>
          </td>
        </tr>
      )}
    </>
  );
}

function ConfigSection({ onSaved }) {
  const [config, setConfig] = useState(null);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState(null);

  useEffect(() => {
    api.get('/network-scanner/config').then(setConfig);
  }, []);

  async function save(e) {
    e.preventDefault();
    setSaving(true);
    setError(null);
    try {
      await api.post('/network-scanner/config', config);
      onSaved();
    } catch (err) {
      setError(err.message);
    } finally {
      setSaving(false);
    }
  }

  if (!config) return null;

  return (
    <section className="card">
      <h2>Configuration</h2>
      <form onSubmit={save} autoComplete="off">
        {error && <p className="error">{error}</p>}
        <div className="form-row">
          <label>
            Scan interval (cron)
            <input className="mono" value={config.cron} onChange={(e) => setConfig({ ...config, cron: e.target.value })} placeholder="*/5 * * * *" />
          </label>
          <label>
            Subnet (optional)
            <input className="mono" value={config.subnet} onChange={(e) => setConfig({ ...config, subnet: e.target.value })} placeholder="192.168.1.0/24 (blank = auto-detect)" />
          </label>
        </div>
        <button type="submit" disabled={saving}>{saving ? 'Saving...' : 'Save'}</button>
      </form>
    </section>
  );
}
