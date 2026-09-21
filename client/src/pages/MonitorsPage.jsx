import { useEffect, useState } from 'react';
import { api } from '../api';
import { useAuth } from '../context/AuthContext';
import { useSocket } from '../hooks/useSocket';

const TYPES = [
  { value: 'http', label: 'HTTP' },
  { value: 'https', label: 'HTTPS' },
  { value: 'tcp', label: 'TCP Port' },
  { value: 'icmp', label: 'Ping (ICMP)' },
  { value: 'dns', label: 'DNS Resolve' },
  { value: 'keyword', label: 'HTTP(s) Keyword' },
  { value: 'json_query', label: 'HTTP(s) JSON Query' },
  { value: 'docker', label: 'Docker Container' },
  { value: 'push', label: 'Push (heartbeat)' },
];

const emptyForm = {
  label: '', type: 'https', target: '', port: '', interval_s: 60, timeout_s: 10,
  keyword: '', json_path: '', json_expected: '', expected_status: 200,
  push_interval_s: 60, docker_container: '',
};

const STATUS_LABEL = { up: 'Up', down: 'Down', degraded: 'Degraded', unknown: 'Pending' };

function timeAgo(dateStr) {
  if (!dateStr) return 'never';
  const seconds = Math.floor((Date.now() - new Date(dateStr.replace(' ', 'T') + 'Z')) / 1000);
  if (seconds < 60) return 'just now';
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes} minute${minutes === 1 ? '' : 's'} ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours} hour${hours === 1 ? '' : 's'} ago`;
  const days = Math.floor(hours / 24);
  return `${days} day${days === 1 ? '' : 's'} ago`;
}

export default function MonitorsPage() {
  const { user } = useAuth();
  const canEdit = ['superadmin', 'admin', 'operator'].includes(user?.role);
  const canDelete = ['superadmin', 'admin'].includes(user?.role);

  const [monitors, setMonitors] = useState([]);
  const [form, setForm] = useState(null);
  const [error, setError] = useState(null);
  const [message, setMessage] = useState(null);
  const [newPushUrl, setNewPushUrl] = useState(null);
  const [viewMode, setViewMode] = useState(() => localStorage.getItem('infraloom_monitor_view') || 'cards');

  function changeView(mode) {
    setViewMode(mode);
    localStorage.setItem('infraloom_monitor_view', mode);
  }

  async function load() {
    try {
      const data = await api.get('/monitors');
      setMonitors(data.monitors);
    } catch (err) {
      setError(err.message);
    }
  }

  useEffect(() => {
    load();
  }, []);

  useSocket({
    'monitor:status': ({ monitorId, status, latency_ms, checked_at }) => {
      setMonitors((prev) =>
        prev.map((m) => (m.id === monitorId ? { ...m, last_status: status, last_latency_ms: latency_ms, last_checked_at: checked_at } : m))
      );
    },
  });

  function flash(msg) {
    setMessage(msg);
    setError(null);
    setTimeout(() => setMessage(null), 4000);
  }

  function openCreate() {
    setForm({ ...emptyForm });
    setNewPushUrl(null);
  }

  function openEdit(m) {
    setForm({
      id: m.id, label: m.label, type: m.type, target: m.target || '',
      port: m.port || '', interval_s: m.interval_s, timeout_s: m.timeout_s,
      keyword: m.keyword || '', json_path: m.json_path || '', json_expected: m.json_expected || '',
      expected_status: m.expected_status, push_interval_s: m.push_interval_s || 60,
      docker_container: m.docker_container || '',
    });
    setNewPushUrl(null);
  }

  async function save(e) {
    e.preventDefault();
    try {
      if (form.id) {
        await api.put(`/monitors/${form.id}`, form);
        setForm(null);
        flash('Saved.');
      } else {
        const data = await api.post('/monitors', form);
        if (data.monitor.type === 'push') {
          setNewPushUrl(`${window.location.origin}/api/status/push/${data.monitor.push_token}`);
        } else {
          setForm(null);
        }
        flash('Created.');
      }
      load();
    } catch (err) {
      setError(err.message);
    }
  }

  async function remove(m) {
    if (!confirm(`Delete monitor "${m.label}"?`)) return;
    try {
      await api.del(`/monitors/${m.id}`);
      flash('Deleted.');
      load();
    } catch (err) {
      setError(err.message);
    }
  }

  async function toggleEnabled(m) {
    try {
      await api.put(`/monitors/${m.id}`, { enabled: m.enabled ? 0 : 1 });
      load();
    } catch (err) {
      setError(err.message);
    }
  }

  return (
    <div className="page">
      <h1>Uptime Monitor</h1>
      <p className="muted">{monitors.length} monitor{monitors.length === 1 ? '' : 's'}</p>
      {message && <p className="success">{message}</p>}
      {error && <p className="error">{error}</p>}

      <div className="monitor-summary">
        <span className="summary-chip">Up: <strong className="success">{monitors.filter((m) => m.last_status === 'up').length}</strong></span>
        <span className="summary-chip">Down: <strong className="error">{monitors.filter((m) => m.last_status === 'down').length}</strong></span>
        <span className="summary-chip">Degraded: <strong className="warning">{monitors.filter((m) => m.last_status === 'degraded').length}</strong></span>
      </div>

      {!form && (
        <div className="filters">
          {canEdit && <button onClick={openCreate}>+ New monitor</button>}
          <div className="view-toggle">
            <button className={viewMode === 'cards' ? 'active' : ''} onClick={() => changeView('cards')}>Cards</button>
            <button className={viewMode === 'table' ? 'active' : ''} onClick={() => changeView('table')}>Table</button>
          </div>
        </div>
      )}

      {form && (
        <section className="card">
          <h2>{form.id ? 'Edit monitor' : 'New monitor'}</h2>
          {newPushUrl ? (
            <div>
              <p className="success">Monitor created. Point your external system at this URL to send heartbeats:</p>
              <p className="mono"><code>{newPushUrl}</code></p>
              <p className="muted">Optional: append <code>?latency=123</code> to report latency in ms.</p>
              <button onClick={() => setForm(null)}>Done</button>
            </div>
          ) : (
            <form onSubmit={save} autoComplete="off">
              <div className="form-row">
                <label>
                  Label
                  <input value={form.label} onChange={(e) => setForm({ ...form, label: e.target.value })} required />
                </label>
                <label>
                  Type
                  <select value={form.type} onChange={(e) => setForm({ ...form, type: e.target.value })} disabled={!!form.id}>
                    {TYPES.map((t) => (
                      <option key={t.value} value={t.value}>{t.label}</option>
                    ))}
                  </select>
                </label>
              </div>

              {form.type !== 'push' && form.type !== 'docker' && (
                <div className="form-row">
                  <label>
                    Target {form.type === 'tcp' ? '(host)' : form.type === 'dns' ? '(hostname)' : '(URL)'}
                    <input
                      value={form.target}
                      onChange={(e) => setForm({ ...form, target: e.target.value })}
                      placeholder={form.type === 'tcp' || form.type === 'dns' ? 'example.com' : 'https://example.com'}
                      required
                    />
                  </label>
                  {form.type === 'tcp' && (
                    <label>
                      Port
                      <input type="number" value={form.port} onChange={(e) => setForm({ ...form, port: e.target.value })} required />
                    </label>
                  )}
                </div>
              )}

              {form.type === 'docker' && (
                <div className="form-row">
                  <label>
                    Container name or ID
                    <input value={form.docker_container} onChange={(e) => setForm({ ...form, docker_container: e.target.value })} required />
                  </label>
                </div>
              )}

              {form.type === 'keyword' && (
                <div className="form-row">
                  <label>
                    Keyword to find in response
                    <input value={form.keyword} onChange={(e) => setForm({ ...form, keyword: e.target.value })} required />
                  </label>
                </div>
              )}

              {form.type === 'json_query' && (
                <div className="form-row">
                  <label>
                    JSON path
                    <input value={form.json_path} onChange={(e) => setForm({ ...form, json_path: e.target.value })} placeholder="data.status" required />
                  </label>
                  <label>
                    Expected value
                    <input value={form.json_expected} onChange={(e) => setForm({ ...form, json_expected: e.target.value })} placeholder="ok" required />
                  </label>
                </div>
              )}

              {form.type === 'push' && (
                <div className="form-row">
                  <label>
                    Expected heartbeat interval (seconds)
                    <input type="number" value={form.push_interval_s} onChange={(e) => setForm({ ...form, push_interval_s: e.target.value })} />
                  </label>
                </div>
              )}

              {!['push'].includes(form.type) && (
                <div className="form-row">
                  <label>
                    Check interval (s)
                    <input type="number" min="10" value={form.interval_s} onChange={(e) => setForm({ ...form, interval_s: e.target.value })} />
                  </label>
                  <label>
                    Timeout (s)
                    <input type="number" min="1" value={form.timeout_s} onChange={(e) => setForm({ ...form, timeout_s: e.target.value })} />
                  </label>
                  {['http', 'https', 'keyword', 'json_query'].includes(form.type) && (
                    <label>
                      Expected status code
                      <input type="number" value={form.expected_status} onChange={(e) => setForm({ ...form, expected_status: e.target.value })} />
                    </label>
                  )}
                </div>
              )}

              <div className="form-row">
                <button type="submit">Save</button>
                <button type="button" onClick={() => setForm(null)}>Cancel</button>
              </div>
            </form>
          )}
        </section>
      )}

      {viewMode === 'table' ? (
        <table className="table">
        <thead>
          <tr>
            <th>Label</th>
            <th>Type</th>
            <th>Status</th>
            <th>Latency</th>
            <th>Last checked</th>
            <th>SSL</th>
            <th></th>
          </tr>
        </thead>
        <tbody>
          {monitors.map((m) => (
            <tr key={m.id} className={!m.enabled ? 'row-dimmed' : ''}>
              <td>{m.label}</td>
              <td>{TYPES.find((t) => t.value === m.type)?.label || m.type}</td>
              <td>
                <span className={`status-badge status-${m.last_status}`}>{STATUS_LABEL[m.last_status] || m.last_status}</span>
              </td>
              <td>{m.last_latency_ms != null ? `${m.last_latency_ms}ms` : '—'}</td>
              <td className="mono">{m.last_checked_at || '—'}</td>
              <td>
                {m.ssl_days != null ? (
                  <span className={m.ssl_days < 0 ? 'error' : m.ssl_days <= 30 ? 'warning' : ''}>{m.ssl_days}d</span>
                ) : m.ssl_error ? (
                  <span className="muted">{m.ssl_error}</span>
                ) : (
                  '—'
                )}
              </td>
              <td className="actions">
                {canEdit && (
                  <>
                    <button className="btn-link" onClick={() => openEdit(m)}>Edit</button>
                    <button className="btn-link" onClick={() => toggleEnabled(m)}>{m.enabled ? 'Disable' : 'Enable'}</button>
                  </>
                )}
                {canDelete && <button className="btn-link danger" onClick={() => remove(m)}>Delete</button>}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      ) : (
        <div className="monitor-grid">
          {monitors.map((m) => (
            <MonitorCard
              key={m.id}
              monitor={m}
              canEdit={canEdit}
              canDelete={canDelete}
              onEdit={() => openEdit(m)}
              onDelete={() => remove(m)}
            />
          ))}
        </div>
      )}
    </div>
  );
}

function Sparkline({ points, status }) {
  if (!points || points.length < 2) {
    return <div className="sparkline-empty" />;
  }
  const width = 260;
  const height = 40;
  const max = Math.max(...points, 1);
  const min = Math.min(...points, 0);
  const range = max - min || 1;
  const stepX = width / (points.length - 1);
  const coords = points.map((v, i) => `${(i * stepX).toFixed(1)},${(height - ((v - min) / range) * height).toFixed(1)}`);
  const color = status === 'down' ? '#ff6b6b' : status === 'degraded' ? '#facc15' : '#4ade80';

  return (
    <svg viewBox={`0 0 ${width} ${height}`} className="sparkline" preserveAspectRatio="none">
      <polyline points={coords.join(' ')} fill="none" stroke={color} strokeWidth="1.5" />
    </svg>
  );
}

function MonitorCard({ monitor: m, canEdit, canDelete, onEdit, onDelete }) {
  const [points, setPoints] = useState(null);

  useEffect(() => {
    api
      .get(`/monitors/${m.id}/checks?hours=3`)
      .then((data) => setPoints(data.checks.map((c) => c.latency_ms ?? 0)))
      .catch(() => setPoints([]));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [m.id, m.last_checked_at]);

  return (
    <div className={`monitor-card${!m.enabled ? ' row-dimmed' : ''}`}>
      <div className="monitor-card-header">
        <span className={`status-dot status-dot-${m.last_status}`} />
        <div className="monitor-card-title">
          <strong>{m.label}</strong>
          <span className="muted mono monitor-card-target">{m.target}</span>
        </div>
        <span className={`status-badge status-${m.last_status}`}>{STATUS_LABEL[m.last_status] || m.last_status}</span>
        {canEdit && <button className="icon-btn" onClick={onEdit} title="Edit">✎</button>}
        {canDelete && <button className="icon-btn" onClick={onDelete} title="Delete">🗑</button>}
      </div>

      <Sparkline points={points} status={m.last_status} />

      <div className="monitor-card-footer">
        <span>{m.last_latency_ms != null ? `${m.last_latency_ms}ms` : '—'}</span>
        <span className="status-badge status-type">{TYPES.find((t) => t.value === m.type)?.label || m.type}</span>
        <span className="muted">{timeAgo(m.last_checked_at)}</span>
      </div>
    </div>
  );
}
