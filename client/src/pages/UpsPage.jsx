import { useCallback, useEffect, useState } from 'react';
import { api } from '../api';
import { useAuth } from '../context/AuthContext';
import { useSocket } from '../hooks/useSocket';
import { formatDbDate } from '../utils/formatDate';
import MaintenanceBadge, { MaintenanceLink } from '../components/MaintenanceBadge';

export const UPS_STATUS = {
  online: { label: 'On mains', cls: 'status-up' },
  on_battery: { label: 'ON BATTERY', cls: 'status-down' },
  low_battery: { label: 'LOW BATTERY', cls: 'status-down' },
  bypass: { label: 'Bypass', cls: 'status-degraded' },
  off: { label: 'Output off', cls: 'status-down' },
  offline: { label: 'Not responding', cls: 'status-down' },
  unknown: { label: 'Waiting for first poll', cls: 'status-unknown' },
};

/** Status badge info for a device. "unknown" with an error means it was polled but gave no usable data. */
export function upsStatus(d) {
  if (!d.last_status || d.last_status === 'unknown') return d.last_error ? { label: 'No data', cls: 'status-unknown' } : UPS_STATUS.unknown;
  return UPS_STATUS[d.last_status] || UPS_STATUS.unknown;
}

const AUTH_PROTOCOLS = ['MD5', 'SHA', 'SHA224', 'SHA256', 'SHA384', 'SHA512'];
const PRIV_PROTOCOLS = [
  ['DES', 'DES'], ['AES', 'AES-128'], ['AES256B', 'AES-256 (Blumenthal)'], ['AES256R', 'AES-256 (Reeder / Cisco)'],
];

const emptyForm = {
  name: '', ip_address: '', location: '', notes: '', enabled: true,
  snmp_version: '2c', snmp_port: 161, snmp_community: 'public',
  snmp_username: '', snmp_security_level: 'authPriv',
  snmp_auth_protocol: 'SHA', snmp_auth_password: '', snmp_priv_protocol: 'AES', snmp_priv_password: '',
};

const dash = (v, unit = '') => (v === null || v === undefined ? '—' : `${v}${unit}`);

function runtimeText(min) {
  if (min === null || min === undefined) return '—';
  return min >= 120 ? `${Math.floor(min / 60)}h ${min % 60}m` : `${min} min`;
}

function durationText(s) {
  if (s === null || s === undefined) return '—';
  const m = Math.floor(s / 60);
  const h = Math.floor(m / 60);
  return h ? `${h}h ${m % 60}m` : m ? `${m}m ${s % 60}s` : `${s}s`;
}

function lineValues(lines, key, fallback, unit) {
  if (lines && lines.length > 1) return `${lines.map((l) => dash(l[key])).join(' / ')} ${unit}`;
  return dash(fallback, ` ${unit}`);
}

function Bar({ value, tone }) {
  const v = value === null || value === undefined ? 0 : Math.max(0, Math.min(100, value));
  return (
    <div className="ups-bar" title={value === null || value === undefined ? 'n/a' : `${value}%`}>
      <div className={`ups-bar-fill ups-bar-${tone}`} style={{ width: `${v}%` }} />
    </div>
  );
}

const chargeTone = (c) => (c === null || c === undefined ? 'ok' : c < 20 ? 'bad' : c < 50 ? 'warn' : 'ok');
const loadTone = (l) => (l === null || l === undefined ? 'ok' : l > 90 ? 'bad' : l > 75 ? 'warn' : 'ok');

function Metric({ label, children }) {
  return (
    <div className="ups-metric">
      <div className="ups-metric-label">{label}</div>
      <div className="ups-metric-value">{children}</div>
    </div>
  );
}

/** Small dependency-free SVG line chart. Red bands mark the time the UPS was running on battery. */
function Chart({ points, series, yMin, yMax, unit }) {
  if (points.length < 2) return <p className="muted">Not enough data yet — readings are collected once a minute.</p>;
  const W = 640, H = 130, pad = { l: 38, r: 8, t: 8, b: 20 };
  const times = points.map((p) => new Date(p.at).getTime());
  const t0 = times[0];
  const t1 = times[times.length - 1];
  let lo = yMin;
  let hi = yMax;
  if (lo === undefined || hi === undefined) {
    const vals = points.flatMap((p) => series.map((s) => p[s.key])).filter((v) => v !== null && v !== undefined);
    if (!vals.length) return <p className="muted">No data for this metric.</p>;
    lo = Math.floor(Math.min(...vals) - 5);
    hi = Math.ceil(Math.max(...vals) + 5);
    if (hi - lo < 20) { const mid = (hi + lo) / 2; lo = Math.floor(mid - 10); hi = Math.ceil(mid + 10); }
  }
  const x = (t) => pad.l + ((t - t0) / (t1 - t0 || 1)) * (W - pad.l - pad.r);
  const y = (v) => pad.t + (1 - (v - lo) / (hi - lo || 1)) * (H - pad.t - pad.b);

  const bands = [];
  points.forEach((p, i) => {
    if (p.status === 'on_battery' || p.status === 'low_battery') {
      const end = times[i + 1] ?? times[i];
      const last = bands[bands.length - 1];
      if (last && last.end === times[i]) last.end = end;
      else bands.push({ start: times[i], end });
    }
  });

  const path = (key) => {
    let d = '';
    let pen = false;
    points.forEach((p, i) => {
      const v = p[key];
      if (v === null || v === undefined) { pen = false; return; }
      d += `${pen ? 'L' : 'M'}${x(times[i]).toFixed(1)} ${y(v).toFixed(1)} `;
      pen = true;
    });
    return d;
  };
  const clock = (t) => new Date(t).toLocaleString([], { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });

  return (
    <div>
      <svg viewBox={`0 0 ${W} ${H}`} width="100%" role="img" style={{ display: 'block' }}>
        {[lo, (lo + hi) / 2, hi].map((v, i) => (
          <g key={i}>
            <line x1={pad.l} x2={W - pad.r} y1={y(v)} y2={y(v)} stroke="#2a2e38" strokeWidth="1" />
            <text x={pad.l - 4} y={y(v) + 3} textAnchor="end" fontSize="10" fill="#8b8f99">{Math.round(v)}</text>
          </g>
        ))}
        {bands.map((b, i) => (
          <rect key={i} x={x(b.start)} y={pad.t} width={Math.max(2, x(b.end) - x(b.start))} height={H - pad.t - pad.b} fill="rgba(255,107,107,0.18)" />
        ))}
        {series.map((s) => <path key={s.key} d={path(s.key)} fill="none" stroke={s.color} strokeWidth="1.6" />)}
        <text x={pad.l} y={H - 5} fontSize="10" fill="#8b8f99">{clock(t0)}</text>
        <text x={W - pad.r} y={H - 5} textAnchor="end" fontSize="10" fill="#8b8f99">{clock(t1)}</text>
      </svg>
      <div className="muted" style={{ fontSize: 12 }}>
        {series.map((s) => <span key={s.key} style={{ marginRight: 14 }}><span style={{ color: s.color }}>●</span> {s.label}</span>)}
        {unit && <span>({unit})</span>}
        {bands.length > 0 && <span style={{ color: '#ff6b6b' }}> ▌ on battery</span>}
      </div>
    </div>
  );
}

function History({ id }) {
  const [hours, setHours] = useState(24);
  const [points, setPoints] = useState(null);

  useEffect(() => {
    setPoints(null);
    api.get(`/ups/${id}/history?hours=${hours}`).then((d) => setPoints(d.points)).catch(() => setPoints([]));
  }, [id, hours]);

  return (
    <div className="ups-panel">
      <div className="form-row">
        <strong>History</strong>
        {[[6, '6 h'], [24, '24 h'], [72, '3 d'], [168, '7 d']].map(([h, label]) => (
          <button key={h} type="button" className={`btn-link${hours === h ? ' active' : ''}`} onClick={() => setHours(h)}>{label}</button>
        ))}
      </div>
      {points === null ? <p className="muted">Loading...</p> : (
        <>
          <Chart points={points} yMin={0} yMax={100} unit="%" series={[{ key: 'charge_pct', label: 'Battery charge', color: '#4ade80' }, { key: 'load_pct', label: 'Load', color: '#60a5fa' }]} />
          <Chart points={points} unit="V" series={[{ key: 'input_v', label: 'Input voltage', color: '#facc15' }, { key: 'output_v', label: 'Output voltage', color: '#c084fc' }]} />
        </>
      )}
    </div>
  );
}

function Walk({ id }) {
  const [oid, setOid] = useState('1.3.6.1.2.1.33.1');
  const [result, setResult] = useState(null);
  const [busy, setBusy] = useState(false);

  async function run(e) {
    e.preventDefault();
    setBusy(true);
    try {
      setResult(await api.post(`/ups/${id}/walk`, { oid }));
    } catch (err) {
      setResult({ error: err.message });
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="ups-panel">
      <form onSubmit={run} className="form-row">
        <label style={{ flex: 1 }}>
          SNMP walk (start OID)
          <input value={oid} onChange={(e) => setOid(e.target.value)} className="mono" />
        </label>
        <button type="submit" disabled={busy}>{busy ? 'Walking...' : 'Walk'}</button>
      </form>
      <p className="muted" style={{ fontSize: 12 }}>
        Standard UPS-MIB is 1.3.6.1.2.1.33.1, APC PowerNet is 1.3.6.1.4.1.318.1.1.1. If a UPS shows no data, walk 1.3.6.1.4.1 to see which vendor MIB it uses.
      </p>
      {result?.error && <p className="error">{result.error}</p>}
      {result?.rows && (
        <pre className="mono" style={{ whiteSpace: 'pre-wrap', maxHeight: 280, overflow: 'auto', fontSize: 12 }}>
          {result.total} value(s){result.total > result.rows.length ? ` (first ${result.rows.length})` : ''}{'\n'}
          {result.rows.map((r) => `${r.oid} = ${r.value}`).join('\n')}
        </pre>
      )}
    </div>
  );
}

function UpsCard({ d, canEdit, canAdmin, onPoll, onEdit, onDelete }) {
  const [panel, setPanel] = useState(null); // 'history' | 'walk'
  const r = d.last_reading;
  const st = upsStatus(d);
  const stale = d.last_status === 'offline' || d.last_status === 'unknown';
  const onBattery = d.last_status === 'on_battery' || d.last_status === 'low_battery';
  const flags = [];
  if (r?.battery_status === 'low' || r?.battery_status === 'depleted') flags.push('Battery low');
  if (r?.replace_battery) flags.push('Replace battery');
  if (r?.alarms > 0) flags.push(`${r.alarms} active alarm${r.alarms > 1 ? 's' : ''}`);

  return (
    <div className={`ups-card${onBattery ? ' ups-card-alert' : ''}${d.enabled ? '' : ' row-dimmed'}`}>
      <div className="ups-card-head">
        <div>
          <h2>{d.name}<MaintenanceBadge w={d.in_maintenance} /></h2>
          <div className="muted" style={{ fontSize: 12 }}>
            {[d.location, [d.manufacturer, d.model].filter(Boolean).join(' ')].filter(Boolean).join(' · ') || '—'}
          </div>
          <div className="muted mono" style={{ fontSize: 12 }}>{d.ip_address}:{d.snmp_port} · SNMP v{d.snmp_version}</div>
        </div>
        <span className={`status-badge ${st.cls}`}>{d.enabled ? st.label : 'Disabled'}</span>
      </div>

      {d.last_error && <p className="error" style={{ fontSize: 13 }}>{d.last_error}</p>}
      {flags.length > 0 && <p className="warning" style={{ fontSize: 13 }}>⚠ {flags.join(' · ')}</p>}

      {r ? (
        <div className={`ups-metrics${stale ? ' ups-stale' : ''}`}>
          <Metric label="Battery">
            <strong>{dash(r.charge_pct, '%')}</strong> · {runtimeText(r.runtime_min)}
            <Bar value={r.charge_pct} tone={chargeTone(r.charge_pct)} />
            <span className="muted">{[r.battery_voltage_v != null && `${r.battery_voltage_v} V`, r.battery_temp_c != null && `${r.battery_temp_c} °C`].filter(Boolean).join(' · ')}</span>
          </Metric>
          <Metric label="Load">
            <strong>{dash(r.output_load_pct, '%')}</strong>{r.output_power_w != null && ` · ${r.output_power_w} W`}
            <Bar value={r.output_load_pct} tone={loadTone(r.output_load_pct)} />
            <span className="muted">{r.output_current_a != null ? `${r.output_current_a} A` : ''}</span>
          </Metric>
          <Metric label="Input">{lineValues(r.input_lines, 'voltage_v', r.input_voltage_v, 'V')}<br /><span className="muted">{dash(r.input_frequency_hz, ' Hz')}</span></Metric>
          <Metric label="Output">{lineValues(r.output_lines, 'voltage_v', r.output_voltage_v, 'V')}<br /><span className="muted">{dash(r.output_frequency_hz, ' Hz')}</span></Metric>
          {onBattery && r.on_battery_seconds > 0 && <Metric label="On battery for">{durationText(r.on_battery_seconds)}</Metric>}
        </div>
      ) : (
        !d.last_error && <p className="muted">No reading yet.</p>
      )}

      <div className="muted" style={{ fontSize: 12, marginTop: 8 }}>
        {d.last_polled_at ? `Polled ${formatDbDate(d.last_polled_at)}` : 'Not polled yet'}
        {stale && d.last_ok_at && ` · last data ${formatDbDate(d.last_ok_at)}`}
      </div>

      <div className="form-row" style={{ marginTop: 10 }}>
        {canEdit && <button className="btn-link" onClick={() => onPoll(d)}>Poll now</button>}
        <button className="btn-link" onClick={() => setPanel(panel === 'history' ? null : 'history')}>History</button>
        {canEdit && <MaintenanceLink type="ups" id={d.id} />}
        {canEdit && <button className="btn-link" onClick={() => onEdit(d)}>Edit</button>}
        {canAdmin && <button className="btn-link" onClick={() => setPanel(panel === 'walk' ? null : 'walk')}>SNMP walk</button>}
        {canAdmin && <button className="btn-link danger" onClick={() => onDelete(d)}>Delete</button>}
      </div>
      {panel === 'history' && <History id={d.id} />}
      {panel === 'walk' && <Walk id={d.id} />}
    </div>
  );
}

export default function UpsPage() {
  const { user } = useAuth();
  const canEdit = ['superadmin', 'admin', 'operator'].includes(user?.role);
  const canAdmin = ['superadmin', 'admin'].includes(user?.role);

  const [devices, setDevices] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [message, setMessage] = useState(null);
  const [form, setForm] = useState(null);
  const [testing, setTesting] = useState(false);
  const [testResult, setTestResult] = useState(null);

  const load = useCallback(() => {
    api.get('/ups').then((d) => { setDevices(d.devices); setError(null); }).catch((err) => setError(err.message)).finally(() => setLoading(false));
  }, []);
  useEffect(load, [load]);
  useSocket({ 'ups:update': load });

  function flash(msg) {
    setMessage(msg);
    setTimeout(() => setMessage(null), 4000);
  }

  function openCreate() {
    setTestResult(null);
    setForm({ ...emptyForm });
  }

  function openEdit(d) {
    setTestResult(null);
    setForm({
      id: d.id, name: d.name, ip_address: d.ip_address, location: d.location || '', notes: d.notes || '', enabled: !!d.enabled,
      snmp_version: d.snmp_version, snmp_port: d.snmp_port, snmp_community: '', snmp_username: d.snmp_username || '',
      snmp_security_level: d.snmp_security_level || 'authPriv', snmp_auth_protocol: d.snmp_auth_protocol || 'SHA',
      snmp_auth_password: '', snmp_priv_protocol: d.snmp_priv_protocol || 'AES', snmp_priv_password: '',
      _has: { community: !!d.snmp_community, auth: !!d.snmp_auth_password, priv: !!d.snmp_priv_password },
    });
  }

  const payload = () => {
    const { _has, ...rest } = form;
    return rest;
  };

  async function save(e) {
    e.preventDefault();
    setError(null);
    try {
      if (form.id) await api.put(`/ups/${form.id}`, payload());
      else await api.post('/ups', payload());
      setForm(null);
      flash('Saved.');
      load();
    } catch (err) {
      setError(err.message);
    }
  }

  async function test() {
    setTesting(true);
    setTestResult(null);
    try {
      setTestResult(await api.post('/ups/test', payload()));
    } catch (err) {
      setTestResult({ ok: false, error: err.message });
    } finally {
      setTesting(false);
    }
  }

  async function poll(d) {
    try {
      await api.post(`/ups/${d.id}/poll`);
      load();
    } catch (err) {
      setError(err.message);
    }
  }

  async function remove(d) {
    if (!confirm(`Delete UPS "${d.name}" and its history?`)) return;
    try {
      await api.del(`/ups/${d.id}`);
      flash('Deleted.');
      load();
    } catch (err) {
      setError(err.message);
    }
  }

  const set = (patch) => setForm((f) => ({ ...f, ...patch }));
  const v3 = form?.snmp_version === '3';
  const level = form?.snmp_security_level;

  return (
    <div className="page">
      <div className="page-header-row">
        <h1>UPS</h1>
        {canEdit && !form && <button onClick={openCreate}>+ Add UPS</button>}
      </div>
      <p className="muted">
        Monitors UPS units over SNMP (v1, v2c or v3) using the standard UPS-MIB, with an APC PowerNet fallback. Polled every minute;
        you are notified when mains power is lost, when the battery runs low, when power returns, and if a UPS stops responding.
      </p>

      {message && <p className="success">{message}</p>}
      {error && <p className="error">{error}</p>}

      {form && (
        <section className="card">
          <h2>{form.id ? 'Edit UPS' : 'Add UPS'}</h2>
          <form onSubmit={save} autoComplete="off">
            <div className="form-row">
              <label>Name<input value={form.name} onChange={(e) => set({ name: e.target.value })} placeholder="Server room UPS" required /></label>
              <label>IP address / hostname<input value={form.ip_address} onChange={(e) => set({ ip_address: e.target.value })} placeholder="10.1.0.30" required /></label>
              <label>Location<input value={form.location} onChange={(e) => set({ location: e.target.value })} placeholder="Rack 1" /></label>
            </div>
            <div className="form-row">
              <label>
                SNMP version
                <select value={form.snmp_version} onChange={(e) => set({ snmp_version: e.target.value })}>
                  <option value="1">v1</option>
                  <option value="2c">v2c</option>
                  <option value="3">v3</option>
                </select>
              </label>
              <label>Port<input type="number" min="1" max="65535" value={form.snmp_port} onChange={(e) => set({ snmp_port: e.target.value })} /></label>
              {!v3 && (
                <label>
                  Community
                  <input type="password" value={form.snmp_community} onChange={(e) => set({ snmp_community: e.target.value })}
                    placeholder={form._has?.community ? 'unchanged' : 'public'} autoComplete="new-password" />
                </label>
              )}
            </div>

            {v3 && (
              <>
                <div className="form-row">
                  <label>User name<input value={form.snmp_username} onChange={(e) => set({ snmp_username: e.target.value })} /></label>
                  <label>
                    Security level
                    <select value={level} onChange={(e) => set({ snmp_security_level: e.target.value })}>
                      <option value="noAuthNoPriv">No authentication, no privacy</option>
                      <option value="authNoPriv">Authentication only</option>
                      <option value="authPriv">Authentication + privacy</option>
                    </select>
                  </label>
                </div>
                {level !== 'noAuthNoPriv' && (
                  <div className="form-row">
                    <label>
                      Auth protocol
                      <select value={form.snmp_auth_protocol} onChange={(e) => set({ snmp_auth_protocol: e.target.value })}>
                        {AUTH_PROTOCOLS.map((p) => <option key={p} value={p}>{p}</option>)}
                      </select>
                    </label>
                    <label>
                      Auth password (min 8)
                      <input type="password" value={form.snmp_auth_password} onChange={(e) => set({ snmp_auth_password: e.target.value })}
                        placeholder={form._has?.auth ? 'unchanged' : ''} autoComplete="new-password" />
                    </label>
                  </div>
                )}
                {level === 'authPriv' && (
                  <div className="form-row">
                    <label>
                      Privacy protocol
                      <select value={form.snmp_priv_protocol} onChange={(e) => set({ snmp_priv_protocol: e.target.value })}>
                        {PRIV_PROTOCOLS.map(([v, label]) => <option key={v} value={v}>{label}</option>)}
                      </select>
                    </label>
                    <label>
                      Privacy password (min 8)
                      <input type="password" value={form.snmp_priv_password} onChange={(e) => set({ snmp_priv_password: e.target.value })}
                        placeholder={form._has?.priv ? 'unchanged' : ''} autoComplete="new-password" />
                    </label>
                  </div>
                )}
              </>
            )}

            <label>Notes<textarea rows={2} value={form.notes} onChange={(e) => set({ notes: e.target.value })} /></label>
            <label className="checkbox-label" style={{ display: 'block', margin: '12px 0' }}>
              <input type="checkbox" checked={form.enabled} onChange={(e) => set({ enabled: e.target.checked })} /> Poll this UPS
            </label>

            {testResult && (
              <p className={testResult.ok ? 'success' : 'error'}>
                {testResult.ok
                  ? `Connected — ${[testResult.reading.manufacturer, testResult.reading.model].filter(Boolean).join(' ') || 'UPS'} · ${dash(testResult.reading.charge_pct, '%')} battery · ${runtimeText(testResult.reading.runtime_min)} · ${(UPS_STATUS[testResult.reading.status] || UPS_STATUS.unknown).label} (${testResult.reading.source})`
                  : testResult.error}
              </p>
            )}

            <div className="form-row">
              <button type="submit">Save</button>
              <button type="button" onClick={test} disabled={testing}>{testing ? 'Testing...' : 'Test connection'}</button>
              <button type="button" onClick={() => setForm(null)}>Cancel</button>
            </div>
          </form>
        </section>
      )}

      {loading ? (
        <p className="muted">Loading...</p>
      ) : devices.length === 0 ? (
        !form && <p className="muted">No UPS added yet.{canEdit ? ' Click "+ Add UPS" to connect one.' : ''}</p>
      ) : (
        <div className="ups-grid">
          {devices.map((d) => (
            <UpsCard key={d.id} d={d} canEdit={canEdit} canAdmin={canAdmin} onPoll={poll} onEdit={openEdit} onDelete={remove} />
          ))}
        </div>
      )}
    </div>
  );
}
