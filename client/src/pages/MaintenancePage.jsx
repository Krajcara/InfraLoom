import { useCallback, useEffect, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { api } from '../api';
import { useAuth } from '../context/AuthContext';
import { useSocket } from '../hooks/useSocket';

const KINDS = [
  ['all', 'Everything (all alerts)'],
  ['monitor', 'Uptime monitor'],
  ['device', 'Network device (router / switch / access point)'],
  ['hypervisor', 'Hypervisor connection'],
  ['ups', 'UPS'],
];
const DURATIONS = [[30, '30 minutes'], [60, '1 hour'], [120, '2 hours'], [240, '4 hours'], [480, '8 hours'], [1440, '24 hours'], [4320, '3 days'], [0, 'Until a set time…']];
const TYPE_LABEL = { all: 'Everything', monitor: 'Monitor', hypervisor: 'Hypervisor', ups: 'UPS', switch: 'Switch (FortiGate)', access_point: 'Access point (FortiGate)' };

const fmt = (iso) => new Date(iso).toLocaleString([], { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });
const localInput = (d) => new Date(d.getTime() - d.getTimezoneOffset() * 60000).toISOString().slice(0, 16); // value for <input type="datetime-local">

const emptyForm = () => ({ kind: 'monitor', target: '', duration: 60, startMode: 'now', startsAt: localInput(new Date()), endsAt: localInput(new Date(Date.now() + 3600000)), reason: '' });

export default function MaintenancePage() {
  const { user } = useAuth();
  const canEdit = ['superadmin', 'admin', 'operator'].includes(user?.role);
  const canAdmin = ['superadmin', 'admin'].includes(user?.role);
  const [params, setParams] = useSearchParams();

  const [windows, setWindows] = useState([]);
  const [targets, setTargets] = useState({ monitors: [], devices: [], hypervisors: [], ups: [] });
  const [form, setForm] = useState(null);
  const [error, setError] = useState(null);
  const [message, setMessage] = useState(null);
  const [loading, setLoading] = useState(true);

  const load = useCallback(() => {
    api.get('/maintenance').then((d) => setWindows(d.windows)).catch((e) => setError(e.message)).finally(() => setLoading(false));
  }, []);
  useEffect(load, [load]);
  useSocket({ 'maintenance:update': load });
  useEffect(() => { api.get('/maintenance/targets').then(setTargets).catch(() => {}); }, []);

  // Arriving from a "Maintenance" link on another page: open the form already pointing at that target.
  useEffect(() => {
    const type = params.get('type');
    const id = params.get('id');
    if (!type || !id) return;
    const target = type === 'device' ? `${params.get('table')}:${id}` : id;
    setForm({ ...emptyForm(), kind: type, target });
    setParams({}, { replace: true });
  }, [params, setParams]);

  function flash(msg) {
    setMessage(msg);
    setTimeout(() => setMessage(null), 5000);
  }

  const options = () => {
    if (!form) return [];
    if (form.kind === 'monitor') return targets.monitors.map((m) => [String(m.id), `${m.label} — ${m.target}`]);
    if (form.kind === 'device') return targets.devices.map((d) => [`${d.table}:${d.id}`, `${d.kind}: ${d.name}`]);
    if (form.kind === 'hypervisor') return targets.hypervisors.map((h) => [String(h.id), h.name]);
    if (form.kind === 'ups') return targets.ups.map((u) => [String(u.id), u.name]);
    return [];
  };

  async function create(e) {
    e.preventDefault();
    setError(null);
    const body = { target_type: form.kind, reason: form.reason };
    if (form.kind === 'device') {
      const [table, id] = form.target.split(':');
      body.device_table = table;
      body.target_id = id;
    } else if (form.kind !== 'all') {
      body.target_id = form.target;
    }
    const start = form.startMode === 'later' ? new Date(form.startsAt) : new Date();
    if (form.startMode === 'later') body.starts_at = start.toISOString();
    if (Number(form.duration) === 0) body.ends_at = new Date(form.endsAt).toISOString();
    else body.duration_minutes = Number(form.duration);
    try {
      await api.post('/maintenance', body);
      setForm(null);
      flash('Maintenance window created.');
      load();
    } catch (err) {
      setError(err.message);
    }
  }

  async function end(w) {
    const msg = w.status === 'scheduled'
      ? 'Cancel this scheduled window?'
      : 'End maintenance now? Anything that is still down will be reported straight away.';
    if (!confirm(msg)) return;
    try {
      await api.post(`/maintenance/${w.id}/end`);
      load();
    } catch (err) {
      setError(err.message);
    }
  }

  async function remove(w) {
    if (!confirm('Remove this window from the history?')) return;
    try {
      await api.del(`/maintenance/${w.id}`);
      load();
    } catch (err) {
      setError(err.message);
    }
  }

  const section = (title, status, hint) => {
    const rows = windows.filter((w) => w.status === status);
    if (!rows.length && status !== 'active') return null;
    return (
      <section className="card" style={{ maxWidth: 'none' }}>
        <h2>{title}</h2>
        {hint && <p className="muted">{hint}</p>}
        {rows.length === 0 ? <p className="muted">None.</p> : (
          <table className="table">
            <thead><tr><th>What</th><th>From</th><th>Until</th><th>Why</th><th>Alerts muted</th><th></th></tr></thead>
            <tbody>
              {rows.map((w) => (
                <tr key={w.id}>
                  <td>
                    <strong>{w.target_label || '—'}</strong>
                    <div className="muted" style={{ fontSize: 12 }}>{TYPE_LABEL[w.target_type] || w.target_type}</div>
                  </td>
                  <td>{fmt(w.starts_at)}</td>
                  <td>{fmt(w.ended_at && w.ended_at < w.ends_at ? w.ended_at : w.ends_at)}</td>
                  <td>
                    {w.reason || <span className="muted">—</span>}
                    {w.source === 'patch' && <span className="status-badge" style={{ marginLeft: 6 }} title="Opened automatically by a Patch Management run">patch run</span>}
                    <div className="muted" style={{ fontSize: 12 }}>{w.created_by ? `by ${w.created_by}` : ''}</div>
                  </td>
                  <td>{w.suppressed_count}</td>
                  <td className="actions">
                    {canEdit && status !== 'ended' && <button className="btn-link" onClick={() => end(w)}>{status === 'scheduled' ? 'Cancel' : 'End now'}</button>}
                    {canAdmin && <button className="btn-link danger" onClick={() => remove(w)}>Delete</button>}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </section>
    );
  };

  return (
    <div className="page">
      <div className="page-header-row">
        <h1>Maintenance</h1>
        {canEdit && !form && <button onClick={() => setForm(emptyForm())}>+ New maintenance window</button>}
      </div>
      <p className="muted">
        While a window is open, InfraLoom keeps checking and the statuses stay accurate — but the <strong>down, recovered, offline and
        power-loss notifications</strong> for that target are held back, so planned work does not page you. When the window ends, anything that
        is still broken is reported once. Licence, SSL and Entra expiry reminders are never muted. A Patch Management run opens a window
        by itself for the monitors that point at the machine being patched.
      </p>

      {message && <p className="success">{message}</p>}
      {error && <p className="error">{error}</p>}

      {form && (
        <section className="card">
          <h2>New maintenance window</h2>
          <form onSubmit={create} autoComplete="off">
            <div className="form-row">
              <label>
                Mute alerts for
                <select value={form.kind} onChange={(e) => setForm({ ...form, kind: e.target.value, target: '' })}>
                  {KINDS.map(([v, l]) => <option key={v} value={v}>{l}</option>)}
                </select>
              </label>
              {form.kind !== 'all' && (
                <label style={{ flex: 1 }}>
                  Which one
                  <select value={form.target} onChange={(e) => setForm({ ...form, target: e.target.value })} required>
                    <option value="">Select…</option>
                    {options().map(([v, l]) => <option key={v} value={v}>{l}</option>)}
                  </select>
                </label>
              )}
            </div>
            <div className="form-row">
              <label>
                Starts
                <select value={form.startMode} onChange={(e) => setForm({ ...form, startMode: e.target.value })}>
                  <option value="now">Now</option>
                  <option value="later">At a set time…</option>
                </select>
              </label>
              {form.startMode === 'later' && (
                <label>
                  Start time
                  <input type="datetime-local" value={form.startsAt} onChange={(e) => setForm({ ...form, startsAt: e.target.value })} required />
                </label>
              )}
              <label>
                Lasts
                <select value={form.duration} onChange={(e) => setForm({ ...form, duration: Number(e.target.value) })}>
                  {DURATIONS.map(([v, l]) => <option key={v} value={v}>{l}</option>)}
                </select>
              </label>
              {Number(form.duration) === 0 && (
                <label>
                  Until
                  <input type="datetime-local" value={form.endsAt} onChange={(e) => setForm({ ...form, endsAt: e.target.value })} required />
                </label>
              )}
            </div>
            <label>
              Reason (optional)
              <input value={form.reason} maxLength={200} onChange={(e) => setForm({ ...form, reason: e.target.value })} placeholder="Firmware upgrade on core switch" />
            </label>
            {form.kind === 'all' && <p className="warning">This mutes every down / recovered / offline / power-loss alert, for everything, until the window ends.</p>}
            <div className="form-row">
              <button type="submit">Start</button>
              <button type="button" onClick={() => setForm(null)}>Cancel</button>
            </div>
          </form>
        </section>
      )}

      {loading ? <p className="muted">Loading...</p> : (
        <>
          {section('Active now', 'active', 'Alerts for these are muted at the moment.')}
          {section('Scheduled', 'scheduled')}
          {section('Finished (last 30 days)', 'ended')}
        </>
      )}
    </div>
  );
}
