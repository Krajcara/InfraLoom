import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { api } from '../api';
import { useAuth } from '../context/AuthContext';
import './traffic.css';

const RANGES = [['1h', '1 hour'], ['6h', '6 hours'], ['24h', '24 hours'], ['7d', '7 days'], ['30d', '30 days'], ['1y', '1 year']];

export function fmtBps(v) {
  if (v == null || !Number.isFinite(v)) return '—';
  for (const [d, n] of [[1e9, 'Gbps'], [1e6, 'Mbps'], [1e3, 'kbps']]) if (v >= d) return `${(v / d).toFixed(v / d >= 100 ? 0 : 1).replace(/\.0$/, '')} ${n}`;
  return `${Math.round(v)} bps`;
}
export function fmtBytes(v) {
  if (v == null || !Number.isFinite(v)) return '—';
  for (const [d, n] of [[1e12, 'TB'], [1e9, 'GB'], [1e6, 'MB'], [1e3, 'kB']]) if (v >= d) return `${(v / d).toFixed(v / d >= 100 ? 0 : 1).replace(/\.0$/, '')} ${n}`;
  return `${Math.round(v)} B`;
}
const niceMax = (m) => { if (!(m > 0)) return 1; const p = 10 ** Math.floor(Math.log10(m)); const n = m / p; return (n <= 1 ? 1 : n <= 2 ? 2 : n <= 5 ? 5 : 10) * p; };
const STATE = { ok: ['ok', 'status-up'], warning: ['high', 'is-warn'], critical: ['very high', 'is-bad'] };

export default function TrafficPage() {
  const { user } = useAuth();
  const canEdit = ['superadmin', 'admin', 'operator'].includes(user?.role);
  const canAdmin = ['superadmin', 'admin'].includes(user?.role);
  const [data, setData] = useState(null);
  const [sel, setSel] = useState(null);
  const [error, setError] = useState(null);
  const [notice, setNotice] = useState(null);
  const [busy, setBusy] = useState(false);
  const [adding, setAdding] = useState(false);

  const load = useCallback(() => api.get('/traffic/interfaces').then((d) => { setData(d); setError(null); }).catch((e) => setError(e.message)), []);
  useEffect(() => { load(); const t = setInterval(load, 30000); return () => clearInterval(t); }, [load]);
  useEffect(() => { if (data && sel == null && data.interfaces.length) setSel(data.interfaces[0].id); }, [data, sel]);

  async function pollNow() {
    setBusy(true); setNotice(null);
    try { const r = await api.post('/traffic/poll', {}); setNotice({ type: 'ok', text: `Read ${r.devices} device${r.devices === 1 ? '' : 's'}: ${r.sampled} new sample${r.sampled === 1 ? '' : 's'}${r.errors ? `, ${r.errors} could not be read` : ''}.` }); await load(); } catch (e) { setNotice({ type: 'error', text: e.message }); }
    setBusy(false);
  }

  const current = data?.interfaces.find((i) => i.id === sel) || null;
  return (
    <div className="page traffic">
      <div className="traffic-head">
        <h1>Traffic</h1>
        <div className="traffic-actions">
          {canEdit && <button type="button" className="cab-btn-ghost" onClick={() => setAdding(!adding)}>{adding ? 'Close' : 'Add interfaces'}</button>}
          {canEdit && data?.interfaces.length > 0 && <button type="button" onClick={pollNow} disabled={busy}>{busy ? 'Reading…' : 'Read now'}</button>}
        </div>
      </div>
      <p className="muted">The load of the interfaces you choose, from the counters of the devices: a FortiGate through its API, switches and routers through SNMP. {data?.last_poll ? `Last read ${new Date(data.last_poll).toLocaleTimeString()}, every ${data.config.poll_minutes} min.` : ''}</p>
      {error && <p className="error">{error}</p>}
      {notice && <p className={notice.type === 'error' ? 'error' : 'success'} role="status">{notice.text}</p>}
      {adding && canEdit && <AddInterfaces canAdmin={canAdmin} onDone={() => { setAdding(false); load(); }} />}
      {data && data.interfaces.length === 0 && !adding && (
        <div className="card"><p className="muted">No interface is watched yet.{canEdit ? ' Use “Add interfaces” to pick the ones that matter: the WAN, the uplinks, the trunk ports.' : ''}</p></div>
      )}
      {data && data.interfaces.length > 0 && <InterfaceTable rows={data.interfaces} selected={sel} onSelect={setSel} />}
      {current && <Detail key={current.id} row={current} config={data.config} canEdit={canEdit} onChanged={load} onRemoved={() => { setSel(null); load(); }} />}
      {canAdmin && <Defaults config={data?.config} onSaved={load} />}
    </div>
  );
}

function Spark({ values }) {
  if (!values || values.length < 2) return <span className="muted">—</span>;
  const max = Math.max(...values, 1); const w = 90; const h = 22;
  const pts = values.map((v, i) => `${((i / (values.length - 1)) * w).toFixed(1)},${(h - (v / max) * (h - 2) - 1).toFixed(1)}`).join(' ');
  return <svg className="traffic-spark" viewBox={`0 0 ${w} ${h}`} width={w} height={h} aria-hidden="true"><polyline points={pts} fill="none" strokeWidth="1.5" /></svg>;
}

function InterfaceTable({ rows, selected, onSelect }) {
  return (
    <div className="card traffic-table-wrap">
      <table className="table traffic-table">
        <thead><tr><th>Interface</th><th>Link</th><th className="num">In</th><th className="num">Out</th><th>Load</th><th>Last hour</th><th>State</th></tr></thead>
        <tbody>
          {rows.map((r) => {
            const [label, cls] = STATE[r.state] || STATE.ok;
            return (
              <tr key={r.id} className={`traffic-row ${selected === r.id ? 'is-selected' : ''} ${r.enabled ? '' : 'is-off'}`} onClick={() => onSelect(r.id)} tabIndex={0} onKeyDown={(e) => e.key === 'Enter' && onSelect(r.id)} aria-selected={selected === r.id}>
                <td><strong>{r.device_name}</strong> · {r.label || r.if_name}{r.label && <span className="muted"> ({r.if_name})</span>}{!r.enabled && <span className="traffic-tag">paused</span>}{r.last_error && <div className="txt-bad traffic-err" title={r.last_error}>{r.last_error}</div>}</td>
                <td><span className={`status-badge ${r.oper_status === 'up' ? 'status-up' : ''}`}>{r.oper_status || '—'}</span> <span className="muted">{r.speed_mbps ? fmtBps(r.speed_mbps * 1e6) : 'speed unknown'}</span></td>
                <td className="num mono">{fmtBps(r.in_bps)}</td><td className="num mono">{fmtBps(r.out_bps)}</td>
                <td><div className="traffic-load" title={r.util_pct == null ? 'no percentage: the speed is not known' : `${r.util_pct.toFixed(1)}% of the link`}><i className={`is-${r.state}`} style={{ width: `${Math.min(100, r.util_pct ?? 0)}%` }} /></div><span className="traffic-pct">{r.util_pct == null ? '—' : `${r.util_pct < 10 ? r.util_pct.toFixed(1) : Math.round(r.util_pct)}%`}</span></td>
                <td><Spark values={r.spark} /></td>
                <td><span className={`status-badge ${cls}`}>{label}</span></td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

function Chart({ s, speedBps, warn, crit }) {
  const [hover, setHover] = useState(null);
  const ref = useRef(null);
  const W = 900; const H = 290; const L = 64; const R = 14; const T = 12; const B = 34;
  const pts = s.points;
  const peak = Math.max(1, ...pts.map((p) => Math.max(p.max_in, p.max_out)));
  const [full, setFull] = useState(false);
  const top = niceMax(full && speedBps ? speedBps : peak * 1.05);
  const x0 = s.from; const x1 = s.to;
  const x = (t) => L + ((t - x0) / (x1 - x0)) * (W - L - R);
  const y = (v) => T + (H - T - B) * (1 - Math.min(v, top) / top);
  const line = (k) => pts.map((p, i) => `${i ? 'L' : 'M'}${x(p.ts + s.bucket / 2).toFixed(1)},${y(p[k]).toFixed(1)}`).join(' ');
  const area = (k) => (pts.length ? `${line(k)} L${x(pts[pts.length - 1].ts + s.bucket / 2).toFixed(1)},${y(0)} L${x(pts[0].ts + s.bucket / 2).toFixed(1)},${y(0)} Z` : '');
  const yTicks = [0, 0.25, 0.5, 0.75, 1].map((f) => top * f);
  const xTicks = Array.from({ length: 6 }, (_, i) => x0 + ((x1 - x0) * i) / 5);
  const fmtT = (t) => { const d = new Date(t * 1000); return x1 - x0 <= 86400 * 1.1 ? d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }) : x1 - x0 <= 8 * 86400 ? `${d.toLocaleDateString([], { weekday: 'short' })} ${d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}` : d.toLocaleDateString(); };

  function move(e) {
    const box = ref.current.getBoundingClientRect(); const px = ((e.clientX - box.left) / box.width) * W;
    let best = null; let d = Infinity;
    for (const p of pts) { const dx = Math.abs(x(p.ts + s.bucket / 2) - px); if (dx < d) { d = dx; best = p; } }
    setHover(d < 40 ? best : null);
  }
  return (
    <div className="traffic-chart">
      <div className="traffic-chart-tools">
        <span className="traffic-legend"><i className="is-in" /> In <i className="is-out" /> Out {speedBps && (warn || crit) ? <><i className="is-warnline" /> warning / critical level</> : null}</span>
        {speedBps && <label className="checkbox-row"><input type="checkbox" checked={full} onChange={(e) => setFull(e.target.checked)} /><span>Scale to the link speed</span></label>}
      </div>
      {pts.length === 0 ? <p className="muted traffic-empty">No data in this range yet: the first rate appears after the second reading.</p> : (
        <svg ref={ref} viewBox={`0 0 ${W} ${H}`} className="traffic-svg" role="img" aria-label="Traffic over time" onMouseMove={move} onMouseLeave={() => setHover(null)}>
          {yTicks.map((v) => (<g key={v}><line x1={L} x2={W - R} y1={y(v)} y2={y(v)} className="traffic-grid" /><text x={L - 8} y={y(v) + 4} textAnchor="end" className="traffic-axis">{fmtBps(v)}</text></g>))}
          {xTicks.map((t, i) => <text key={t} x={x(t)} y={H - 10} textAnchor={i === 0 ? 'start' : i === xTicks.length - 1 ? 'end' : 'middle'} className="traffic-axis">{fmtT(t)}</text>)}
          {speedBps && warn != null && warn * speedBps / 100 <= top && <line x1={L} x2={W - R} y1={y((warn * speedBps) / 100)} y2={y((warn * speedBps) / 100)} className="traffic-limit is-warn" />}
          {speedBps && crit != null && crit * speedBps / 100 <= top && <line x1={L} x2={W - R} y1={y((crit * speedBps) / 100)} y2={y((crit * speedBps) / 100)} className="traffic-limit is-crit" />}
          <path d={area('in')} className="traffic-area is-in" /><path d={line('in')} className="traffic-line is-in" />
          <path d={line('out')} className="traffic-line is-out" />
          {hover && <g><line x1={x(hover.ts + s.bucket / 2)} x2={x(hover.ts + s.bucket / 2)} y1={T} y2={H - B} className="traffic-cursor" /><circle cx={x(hover.ts + s.bucket / 2)} cy={y(hover.in)} r="3.5" className="traffic-dot is-in" /><circle cx={x(hover.ts + s.bucket / 2)} cy={y(hover.out)} r="3.5" className="traffic-dot is-out" /></g>}
        </svg>
      )}
      <div className="traffic-hover" aria-live="polite">{hover ? <><strong>{fmtT(hover.ts)}</strong> — in {fmtBps(hover.in)} (peak {fmtBps(hover.max_in)}), out {fmtBps(hover.out)} (peak {fmtBps(hover.max_out)})</> : <span className="muted">Move over the chart for the numbers.</span>}</div>
    </div>
  );
}

function Detail({ row, config, canEdit, onChanged, onRemoved }) {
  const [range, setRange] = useState('24h');
  const [s, setS] = useState(null);
  const [err, setErr] = useState(null);
  useEffect(() => { setS(null); api.get(`/traffic/interfaces/${row.id}/series?range=${range}`).then((d) => { setS(d); setErr(null); }).catch((e) => setErr(e.message)); }, [row.id, range, row.last_ts]);
  const sb = row.speed_mbps ? row.speed_mbps * 1e6 : null;
  const sum = s?.summary;
  return (
    <section className="card traffic-detail" aria-label="Interface details">
      <div className="traffic-detail-head">
        <h2>{row.device_name} · {row.label || row.if_name}</h2>
        <div className="diag-tabs traffic-ranges" role="tablist">{RANGES.map(([k, l]) => <button key={k} type="button" role="tab" aria-selected={range === k} className={range === k ? 'is-active' : ''} onClick={() => setRange(k)}>{l}</button>)}</div>
      </div>
      {err && <p className="error">{err}</p>}
      {s && <Chart s={s} speedBps={sb} warn={row.warn_pct ?? config.warn_pct} crit={row.crit_pct ?? config.crit_pct} />}
      {sum && sum.samples > 0 && (
        <>
          <div className="traffic-stats">
            {[['Average', sum.avg_in, sum.avg_out], ['Peak', sum.max_in, sum.max_out], ['95th percentile', sum.p95_in, sum.p95_out]].map(([l, a, b]) => (
              <div key={l} className="traffic-stat"><span className="muted">{l}</span><span>in <strong>{fmtBps(a)}</strong></span><span>out <strong>{fmtBps(b)}</strong></span></div>
            ))}
            <div className="traffic-stat"><span className="muted">Transferred</span><span>in <strong>{fmtBytes(sum.bytes_in)}</strong></span><span>out <strong>{fmtBytes(sum.bytes_out)}</strong></span></div>
          </div>
          <p className="muted traffic-basis">Average and 95th percentile are from {sum.basis}; the peak is the highest rate seen.</p>
        </>
      )}
      {row.counter_bits === 32 && row.speed_mbps >= 100 && <p className="diag-hint">This device only has 32-bit counters. At {fmtBps(sb)} they can wrap between two readings, and then the rate is wrong; look for 64-bit counters (ifHCInOctets) on it.</p>}
      {canEdit && <Edit row={row} config={config} onChanged={onChanged} onRemoved={onRemoved} />}
    </section>
  );
}

function Edit({ row, config, onChanged, onRemoved }) {
  const [f, setF] = useState({ label: row.label || '', speed: row.speed_override ? String(row.speed_mbps) : '', warn: row.warn_pct ?? '', crit: row.crit_pct ?? '', sustain: row.sustain_minutes ?? '', enabled: row.enabled });
  const [msg, setMsg] = useState(null);
  const set = (k, v) => { setF({ ...f, [k]: v }); setMsg(null); };
  const num = (v) => (v === '' ? null : Number(v));
  async function save(e) {
    e.preventDefault();
    try {
      await api.patch(`/traffic/interfaces/${row.id}`, { label: f.label.trim() || null, speed_mbps: f.speed === '' ? null : Number(f.speed), warn_pct: num(f.warn), crit_pct: num(f.crit), sustain_minutes: num(f.sustain), enabled: f.enabled });
      setMsg({ type: 'success', text: 'Saved.' }); onChanged();
    } catch (err) { setMsg({ type: 'error', text: err.message }); }
  }
  async function remove() {
    if (!window.confirm(`Stop watching ${row.label || row.if_name} on ${row.device_name}? Its history is deleted.`)) return;
    try { await api.del(`/traffic/interfaces/${row.id}`); onRemoved(); } catch (err) { setMsg({ type: 'error', text: err.message }); }
  }
  return (
    <form className="traffic-edit" onSubmit={save}>
      <h3 className="cab-h3">This interface</h3>
      <div className="form-row">
        <label>Name<input value={f.label} onChange={(e) => set('label', e.target.value)} placeholder={row.if_name} aria-label="Name" autoComplete="off" /></label>
        <label>Speed (Mbps)<input type="number" min="1" value={f.speed} onChange={(e) => set('speed', e.target.value)} placeholder={row.speed_override ? '' : row.speed_mbps ? `${row.speed_mbps} (from the device)` : 'not known'} className="cab-in-num" aria-label="Speed" /></label>
        <label>Warning at (%)<input type="number" min="10" max="99" value={f.warn} onChange={(e) => set('warn', e.target.value)} placeholder={String(config.warn_pct)} className="cab-in-num" aria-label="Warning level" /></label>
        <label>Critical at (%)<input type="number" min="11" max="100" value={f.crit} onChange={(e) => set('crit', e.target.value)} placeholder={String(config.crit_pct)} className="cab-in-num" aria-label="Critical level" /></label>
        <label>For (minutes)<input type="number" min="1" max="120" value={f.sustain} onChange={(e) => set('sustain', e.target.value)} placeholder={String(config.sustain_minutes)} className="cab-in-num" aria-label="For minutes" /></label>
        <label className="checkbox-row"><input type="checkbox" checked={f.enabled} onChange={(e) => set('enabled', e.target.checked)} /><span>Read this interface</span></label>
      </div>
      <p className="muted">An alert is sent when the larger of in and out stays at or above the level for that many minutes, and another when it is back below it. Empty fields use the defaults.</p>
      <div className="form-row"><button type="submit">Save</button><button type="button" className="cab-btn-ghost" onClick={remove}>Remove</button></div>
      {msg && <p className={msg.type === 'error' ? 'error' : 'success'}>{msg.text}</p>}
    </form>
  );
}

/** What the device last answered, for an administrator: the way to see which field a value comes from when something is off. */
function RawAnswer({ table, id, again }) {
  const [r, setR] = useState(null);
  const [err, setErr] = useState(null);
  const load = (open) => { if (open) api.get(`/traffic/raw/${table}/${id}`).then((d) => { setR(d); setErr(null); }).catch((e) => setErr(e.message)); };
  return (
    <details className="traffic-raw" onToggle={(e) => load(e.currentTarget.open)} key={again}>
      <summary>What the device answered</summary>
      {err && <p className="error">{err}</p>}
      {r && <><p className="muted">{r.method === 'fortigate' ? `GET ${r.endpoint}` : 'SNMP, IF-MIB'} · {r.interfaces} interfaces · {new Date(r.at).toLocaleTimeString()}</p><pre className="diag-raw">{r.raw}</pre></>}
    </details>
  );
}

function AddInterfaces({ onDone, canAdmin }) {
  const [devices, setDevices] = useState([]);
  const [dev, setDev] = useState('');
  const [found, setFound] = useState(null);
  const [pick, setPick] = useState(new Set());
  const [q, setQ] = useState('');
  const [hideDown, setHideDown] = useState(true);
  const [state, setState] = useState({ busy: false, error: null });
  useEffect(() => { api.get('/traffic/devices').then((d) => setDevices(d.filter((x) => x.method))).catch(() => {}); }, []);
  const [table, id] = dev.split(':');

  async function read() {
    setState({ busy: true, error: null }); setFound(null); setPick(new Set());
    try { setFound((await api.get(`/traffic/discover?table=${table}&id=${id}`)).interfaces); setState({ busy: false, error: null }); } catch (e) { setState({ busy: false, error: e.message }); }
  }
  async function add() {
    setState({ busy: true, error: null });
    try { await api.post('/traffic/interfaces', { table, id: Number(id), interfaces: [...pick] }); onDone(); } catch (e) { setState({ busy: false, error: e.message }); }
  }
  const shown = (found || []).filter((i) => (!hideDown || i.status !== 'down') && `${i.name} ${i.alias || ''}`.toLowerCase().includes(q.trim().toLowerCase()));
  const toggle = (n) => setPick((p) => { const x = new Set(p); if (x.has(n)) x.delete(n); else x.add(n); return x; });
  return (
    <section className="card traffic-add" aria-label="Add interfaces">
      <h2>Add interfaces</h2>
      <div className="form-row">
        <label className="cab-grow">Device
          <select value={dev} onChange={(e) => { setDev(e.target.value); setFound(null); }} aria-label="Device"><option value="">Choose a device…</option>{devices.map((d) => <option key={`${d.table}:${d.id}`} value={`${d.table}:${d.id}`}>{d.name} ({d.method === 'fortigate' ? 'FortiGate API' : 'SNMP'})</option>)}</select>
        </label>
        <button type="button" onClick={read} disabled={!dev || state.busy}>{state.busy && !found ? 'Reading…' : 'Read its interfaces'}</button>
      </div>
      {devices.length === 0 && <p className="muted">No device can be read yet: a FortiGate needs its API token, any other device needs SNMP settings (Routers, Switches or Access Points).</p>}
      {state.error && <p className="error" role="alert">{state.error}</p>}
      {found && (
        <>
          <div className="form-row">
            <label className="cab-grow">Filter<input value={q} onChange={(e) => setQ(e.target.value)} placeholder="name or description" aria-label="Filter interfaces" autoComplete="off" /></label>
            <label className="checkbox-row"><input type="checkbox" checked={hideDown} onChange={(e) => setHideDown(e.target.checked)} /><span>Hide the ones that are down</span></label>
          </div>
          <div className="traffic-find">
            <table className="table"><thead><tr><th /><th>Interface</th><th>Description</th><th>State</th><th>Speed</th></tr></thead>
              <tbody>{shown.map((i) => (
                <tr key={i.name}>
                  <td><input type="checkbox" checked={pick.has(i.name) || i.monitored} disabled={i.monitored} onChange={() => toggle(i.name)} aria-label={`Watch ${i.name}`} /></td>
                  <td className="mono">{i.name}{i.monitored && <span className="traffic-tag">watched</span>}</td><td>{i.alias || <span className="muted">—</span>}</td>
                  <td><span className={`status-badge ${i.status === 'up' ? 'status-up' : ''}`}>{i.status}</span></td><td>{i.speed_mbps ? fmtBps(i.speed_mbps * 1e6) : '—'}{i.bits === 32 && i.speed_mbps >= 100 ? <span className="traffic-tag" title="32-bit counters can wrap between two readings at this speed">32-bit</span> : null}</td>
                </tr>))}
                {!shown.length && <tr><td colSpan={5} className="muted">No interface matches.</td></tr>}
              </tbody></table>
          </div>
          <div className="form-row"><button type="button" onClick={add} disabled={!pick.size || state.busy}>{`Watch ${pick.size || ''} selected`.trim()}</button></div>
          {canAdmin && <RawAnswer table={table} id={id} again={found.length} />}
        </>
      )}
    </section>
  );
}

function Defaults({ config, onSaved }) {
  const [f, setF] = useState(null);
  const [msg, setMsg] = useState(null);
  useEffect(() => { if (config) setF(config); }, [config]);
  if (!f) return null;
  const rows = [['poll_minutes', 'Read every (minutes)', 1, 10], ['warn_pct', 'Warning at (%)', 10, 99], ['crit_pct', 'Critical at (%)', 11, 100], ['sustain_minutes', 'For (minutes)', 1, 120], ['raw_days', 'Keep every reading (days)', 1, 31], ['hourly_days', 'Keep the hourly summaries (days)', 30, 1100]];
  async function save(e) {
    e.preventDefault();
    try { await api.put('/traffic/settings', Object.fromEntries(rows.map(([k]) => [k, Number(f[k])]))); setMsg({ type: 'success', text: 'Saved.' }); onSaved(); } catch (err) { setMsg({ type: 'error', text: err.message }); }
  }
  return (
    <details className="card traffic-defaults">
      <summary>Defaults for all interfaces</summary>
      <form onSubmit={save}>
        <div className="form-row">{rows.map(([k, l, lo, hi]) => <label key={k}>{l}<input type="number" min={lo} max={hi} value={f[k]} onChange={(e) => { setF({ ...f, [k]: e.target.value }); setMsg(null); }} className="cab-in-num" aria-label={l} /></label>)}<button type="submit">Save</button></div>
      </form>
      {msg && <p className={msg.type === 'error' ? 'error' : 'success'}>{msg.text}</p>}
    </details>
  );
}
