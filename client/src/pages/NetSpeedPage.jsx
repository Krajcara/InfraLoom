import { useEffect, useState } from 'react';
import { Gauge, ArrowDown, ArrowUp, Activity, Trash2, Play } from 'lucide-react';
import { api } from '../api';
import { useAuth } from '../context/AuthContext';
import { useSocket } from '../hooks/useSocket';

const PROVIDERS = [
  ['cloudflare', 'Cloudflare'],
  ['ookla', 'Ookla (Speedtest.net)'],
  ['librespeed', 'LibreSpeed'],
];

const CRON_PRESETS = [
  ['0 * * * *', 'Every hour'],
  ['0 */6 * * *', 'Every 6 hours'],
  ['0 0 * * *', 'Daily at midnight'],
  ['0 */30 * * * *', 'Every 30 min'],
  ['custom', 'Custom...'],
];

export default function NetSpeedPage() {
  const { user } = useAuth();
  const canEdit = ['superadmin', 'admin', 'operator'].includes(user?.role);
  const canConfig = ['superadmin', 'admin'].includes(user?.role);
  const canDelete = ['superadmin', 'admin'].includes(user?.role);

  const [tests, setTests] = useState([]);
  const [stats, setStats] = useState(null);
  const [running, setRunning] = useState(false);
  const [liveProvider, setLiveProvider] = useState(null);
  const [error, setError] = useState(null);
  const [message, setMessage] = useState(null);

  async function load() {
    try {
      const [t, s, status] = await Promise.all([
        api.get('/netspeed/tests?limit=30'),
        api.get('/netspeed/stats?days=30'),
        api.get('/netspeed/status'),
      ]);
      setTests(t);
      setStats(s);
      setRunning(status.running);
    } catch (err) {
      setError(err.message);
    }
  }

  useEffect(() => {
    load();
  }, []);

  useSocket({
    'netspeed:started': ({ provider }) => {
      setRunning(true);
      setLiveProvider(provider);
    },
    'netspeed:done': () => {
      setRunning(false);
      setLiveProvider(null);
      setMessage('Test complete.');
      setTimeout(() => setMessage(null), 4000);
      load();
    },
    'netspeed:error': () => {
      setRunning(false);
      setLiveProvider(null);
      load();
    },
  });

  async function runTest() {
    setError(null);
    try {
      await api.post('/netspeed/run');
      setRunning(true);
    } catch (err) {
      setError(err.message);
    }
  }

  async function removeTest(id) {
    try {
      await api.del(`/netspeed/tests/${id}`);
      load();
    } catch (err) {
      setError(err.message);
    }
  }

  const latest = tests[0];

  return (
    <div className="page">
      <h1>Net Speed</h1>
      {message && <p className="success">{message}</p>}
      {error && <p className="error">{error}</p>}

      <div className="filters">
        {canEdit && (
          <button onClick={runTest} disabled={running}>
            <Play size={14} /> {running ? `Running${liveProvider ? ` (${liveProvider})` : ''}...` : 'Run test now'}
          </button>
        )}
      </div>

      {latest && (
        <div className="netspeed-summary-grid">
          <div className="widget-card netspeed-result-card">
            <div className="netspeed-result-icon blue"><ArrowDown size={20} /></div>
            <div>
              <p className="muted">Download</p>
              <p className="stat-number">{latest.download != null ? `${latest.download} Mbps` : '—'}</p>
            </div>
          </div>
          <div className="widget-card netspeed-result-card">
            <div className="netspeed-result-icon purple"><ArrowUp size={20} /></div>
            <div>
              <p className="muted">Upload</p>
              <p className="stat-number">{latest.upload != null ? `${latest.upload} Mbps` : '—'}</p>
            </div>
          </div>
          <div className="widget-card netspeed-result-card">
            <div className="netspeed-result-icon green"><Activity size={20} /></div>
            <div>
              <p className="muted">Ping</p>
              <p className="stat-number">{latest.ping != null ? `${latest.ping} ms` : '—'}</p>
            </div>
          </div>
          <div className="widget-card netspeed-result-card">
            <div className="netspeed-result-icon amber"><Gauge size={20} /></div>
            <div>
              <p className="muted">Provider</p>
              <p className="stat-number-sm">{PROVIDERS.find((p) => p[0] === latest.provider)?.[1] || latest.provider}</p>
            </div>
          </div>
        </div>
      )}

      {stats && stats.count > 0 && (
        <section className="card">
          <h2>Last {stats.days} days ({stats.count} tests)</h2>
          <table className="table">
            <thead><tr><th></th><th>Min</th><th>Avg</th><th>Max</th></tr></thead>
            <tbody>
              <tr><td>Download (Mbps)</td><td>{stats.download.min ?? '—'}</td><td>{stats.download.avg ?? '—'}</td><td>{stats.download.max ?? '—'}</td></tr>
              <tr><td>Upload (Mbps)</td><td>{stats.upload.min ?? '—'}</td><td>{stats.upload.avg ?? '—'}</td><td>{stats.upload.max ?? '—'}</td></tr>
              <tr><td>Ping (ms)</td><td>{stats.ping.min ?? '—'}</td><td>{stats.ping.avg ?? '—'}</td><td>{stats.ping.max ?? '—'}</td></tr>
            </tbody>
          </table>
        </section>
      )}

      {canConfig && <ConfigSection />}

      <section className="card">
        <h2>History</h2>
        <table className="table">
          <thead>
            <tr><th>Time</th><th>Provider</th><th>Download</th><th>Upload</th><th>Ping</th><th>Server</th><th>Triggered by</th><th>Status</th><th></th></tr>
          </thead>
          <tbody>
            {tests.map((t) => (
              <tr key={t.id}>
                <td className="mono">{t.created_at}</td>
                <td className="muted">{PROVIDERS.find((p) => p[0] === t.provider)?.[1] || t.provider}</td>
                <td>{t.download != null ? `${t.download} Mbps` : '—'}</td>
                <td>{t.upload != null ? `${t.upload} Mbps` : '—'}</td>
                <td>{t.ping != null ? `${t.ping} ms` : '—'}</td>
                <td className="muted">{t.server || '—'}</td>
                <td className="muted">{t.triggered_by}</td>
                <td>
                  {t.status === 'done' && <span className="status-badge status-up">done</span>}
                  {t.status === 'running' && <span className="status-badge status-degraded">running</span>}
                  {t.status === 'error' && <span className="status-badge status-down" title={t.error}>error</span>}
                </td>
                <td className="actions">
                  {canDelete && <button className="icon-btn" onClick={() => removeTest(t.id)}><Trash2 size={14} /></button>}
                </td>
              </tr>
            ))}
            {tests.length === 0 && (
              <tr><td colSpan={9} className="muted">No tests yet — run one above.</td></tr>
            )}
          </tbody>
        </table>
      </section>
    </div>
  );
}

function ConfigSection() {
  const [config, setConfig] = useState(null);
  const [customMinutes, setCustomMinutes] = useState(60);
  const [isCustom, setIsCustom] = useState(false);
  const [saving, setSaving] = useState(false);
  const [message, setMessage] = useState(null);
  const [error, setError] = useState(null);

  useEffect(() => {
    api.get('/netspeed/config').then((data) => {
      setConfig(data);
      const known = CRON_PRESETS.some(([v]) => v === data.cron);
      setIsCustom(!known);
      if (!known) {
        const m = data.cron.match(/^\*\/(\d+) \* \* \* \*$/);
        setCustomMinutes(m ? parseInt(m[1], 10) : 60);
      }
    });
  }, []);

  async function save(e) {
    e.preventDefault();
    setSaving(true);
    setMessage(null);
    setError(null);
    try {
      const cron = isCustom ? `*/${Math.max(parseInt(customMinutes, 10) || 60, 1)} * * * *` : config.cron;
      await api.post('/netspeed/config', { provider: config.provider, cron, retention_days: config.retention_days });
      setMessage('Saved.');
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
        <div className="form-row">
          <label>
            Provider
            <select value={config.provider} onChange={(e) => setConfig({ ...config, provider: e.target.value })}>
              {PROVIDERS.map(([v, l]) => (
                <option key={v} value={v}>{l}</option>
              ))}
            </select>
          </label>
          <label>
            Schedule
            <select
              value={isCustom ? 'custom' : config.cron}
              onChange={(e) => {
                if (e.target.value === 'custom') {
                  setIsCustom(true);
                } else {
                  setIsCustom(false);
                  setConfig({ ...config, cron: e.target.value });
                }
              }}
            >
              {CRON_PRESETS.map(([v, l]) => (
                <option key={v} value={v}>{l}</option>
              ))}
            </select>
          </label>
          {isCustom && (
            <label>
              Every (minutes)
              <input type="number" min="1" value={customMinutes} onChange={(e) => setCustomMinutes(e.target.value)} placeholder="60" autoComplete="off" name="netspeed_minutes_field" />
            </label>
          )}
          <label>
            Retention (days)
            <input type="number" min="1" value={config.retention_days} onChange={(e) => setConfig({ ...config, retention_days: e.target.value })} />
          </label>
        </div>
        <button type="submit" disabled={saving}>{saving ? 'Saving...' : 'Save'}</button>
        {message && <p className="success">{message}</p>}
        {error && <p className="error">{error}</p>}
      </form>
      {config.provider !== 'cloudflare' && (
        <p className="muted netspeed-cli-note">
          The {PROVIDERS.find((p) => p[0] === config.provider)?.[1]} CLI is downloaded automatically on first use.
        </p>
      )}
    </section>
  );
}
