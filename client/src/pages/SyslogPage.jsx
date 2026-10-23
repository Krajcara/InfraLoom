import { Fragment, useCallback, useEffect, useState } from 'react';
import { api } from '../api';
import { useAuth } from '../context/AuthContext';
import { fmtBytes } from './TrafficPage';
import './diagnostics.css';
import './syslog.css';

const RANGES = [['1h', '1 hour'], ['24h', '24 hours'], ['7d', '7 days'], ['30d', '30 days'], ['1y', '1 year']];
const KIND = {
  admin_login_failed: 'Admin login failed', admin_login: 'Admin login', config_change: 'Configuration change', vpn_login_failed: 'VPN login failed', vpn_login: 'VPN up', vpn_logout: 'VPN down',
  ips: 'IPS / anomaly', malware: 'Malware', web_blocked: 'Web blocked', system_event: 'System event',
};
const LEVEL = { info: 'status-up', warning: 'is-warn', critical: 'is-bad' };
const DIM_TITLES = [['src', 'Who uses the most', 'Source'], ['dst', 'Where it goes', 'Destination'], ['app', 'Applications', 'Application'], ['country', 'Countries', 'Country'], ['service', 'Services', 'Service'], ['policy', 'Policies', 'Policy'], ['user', 'Users', 'User'], ['blocked_src', 'Most blocked', 'Source']];
const num = (n) => Number(n).toLocaleString();

export default function SyslogPage() {
  const { user } = useAuth();
  const canAdmin = ['superadmin', 'admin'].includes(user?.role);
  const [tab, setTab] = useState('summary');
  const [status, setStatus] = useState(null);
  const [error, setError] = useState(null);
  const loadStatus = useCallback(() => api.get('/syslog/status').then((s) => { setStatus(s); setError(null); }).catch((e) => setError(e.message)), []);
  useEffect(() => { loadStatus(); const t = setInterval(loadStatus, 15000); return () => clearInterval(t); }, [loadStatus]);

  return (
    <div className="page syslog">
      <h1>Firewall logs</h1>
      <p className="muted">What a FortiGate says about its traffic and about itself, received as syslog: the traffic summed up by the hour (the logs themselves are not kept), and the security events — failed logins, changes of the configuration, attacks that were stopped, VPN and system events.</p>
      {error && <p className="error">{error}</p>}
      {status && <StatusLine s={status} canAdmin={canAdmin} onChanged={loadStatus} goSetup={() => setTab('setup')} />}
      <nav className="diag-tabs" role="tablist">
        {[['summary', 'Summary'], ['events', 'Events'], ['setup', canAdmin ? 'Setup' : 'How to connect']].map(([k, l]) => <button key={k} type="button" role="tab" aria-selected={tab === k} className={tab === k ? 'is-active' : ''} onClick={() => setTab(k)}>{l}</button>)}
      </nav>
      {tab === 'summary' && <Summary status={status} />}
      {tab === 'events' && <Events />}
      {tab === 'setup' && <Setup canAdmin={canAdmin} status={status} onSaved={loadStatus} />}
    </div>
  );
}

function StatusLine({ s, canAdmin, onChanged, goSetup }) {
  async function allow(ip) {
    const cur = await api.get('/syslog/settings'); const list = cur.allowed_sources ? `${cur.allowed_sources}, ${ip}` : ip;
    await api.put('/syslog/settings', { allowed_sources: list }); onChanged();
  }
  if (!s.enabled) return <div className="card syslog-status is-off"><strong>Not receiving.</strong> <span className="muted">Reception is switched off.</span> <button type="button" className="btn-link" onClick={goSetup}>{canAdmin ? 'Set it up' : 'How it is connected'}</button></div>;
  const errs = [s.udp.error, s.tcp.error].filter(Boolean);
  return (
    <div className="card syslog-status">
      <div>
        <strong>Listening</strong> on {[s.udp.port && `UDP ${s.udp.port}${s.udp.listening ? '' : ' (not yet)'}`, s.tcp.port && `TCP ${s.tcp.port}${s.tcp.listening ? '' : ' (not yet)'}`].filter(Boolean).join(' and ')}
        <span className="muted"> · {num(s.per_minute)} logs per minute · {num(s.counters.parsed)} read{s.counters.unparsed ? `, ${num(s.counters.unparsed)} not understood` : ''}</span>
      </div>
      {errs.map((e) => <p key={e} className="error" role="alert">{e}</p>)}
      <ul className="syslog-devices">
        {s.devices.map((d) => <li key={d.device}><span className={`status-badge ${d.silent ? 'is-bad' : 'status-up'}`}>{d.silent ? 'silent' : 'sending'}</span> <strong>{d.device}</strong> <span className="muted">from {d.ip}, last log {d.seconds_ago < 90 ? `${d.seconds_ago} s` : `${Math.round(d.seconds_ago / 60)} min`} ago</span></li>)}
        {!s.devices.length && !errs.length && <li className="muted">Nothing has arrived yet. {s.allowed.length ? `Accepted from: ${s.allowed.join(', ')}.` : 'No sender is allowed yet: a FortiGate of the router list is accepted, or give an address in the setup.'}</li>}
      </ul>
      {s.rejected.length > 0 && (
        <p className="syslog-rejected">Turned away (not on the list of senders): {s.rejected.map((r) => <span key={r.ip} className="syslog-rej"><span className="mono">{r.ip}</span> ({num(r.n)}){canAdmin && <button type="button" className="btn-link" onClick={() => allow(r.ip)} aria-label={`Allow ${r.ip}`}>Allow</button>}</span>)}</p>
      )}
    </div>
  );
}

function Bars({ s }) {
  const [hover, setHover] = useState(null);
  const W = 900; const H = 150; const L = 56; const R = 8; const T = 8; const B = 24;
  const pts = s.timeline; if (!pts.length) return <p className="muted syslog-empty">No traffic in this range yet.</p>;
  const max = Math.max(1, ...pts.map((p) => p.bytes)); const n = Math.max(pts.length, Math.round((s.to - s.from) / s.bucket));
  const bw = (W - L - R) / n; const x = (t) => L + ((t - Math.floor(s.from / s.bucket) * s.bucket) / s.bucket) * bw;
  const fmt = (t) => { const d = new Date(t * 1000); return s.bucket < 86400 ? d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }) : d.toLocaleDateString(); };
  return (
    <div>
      <svg viewBox={`0 0 ${W} ${H}`} className="traffic-svg" role="img" aria-label="Traffic over time" onMouseLeave={() => setHover(null)}>
        {[0, 0.5, 1].map((f) => (<g key={f}><line x1={L} x2={W - R} y1={T + (H - T - B) * (1 - f)} y2={T + (H - T - B) * (1 - f)} className="traffic-grid" /><text x={L - 6} y={T + (H - T - B) * (1 - f) + 4} textAnchor="end" className="traffic-axis">{fmtBytes(max * f)}</text></g>))}
        {pts.map((p) => (<g key={p.ts} onMouseEnter={() => setHover(p)}><rect x={x(p.ts) + 1} y={T + (H - T - B) * (1 - p.bytes / max)} width={Math.max(1, bw - 2)} height={(H - T - B) * (p.bytes / max)} className="syslog-bar" />{p.blocked > 0 && <rect x={x(p.ts) + 1} y={H - B - 4} width={Math.max(1, bw - 2)} height={4} className="syslog-bar-blocked" />}</g>))}
        <text x={L} y={H - 6} className="traffic-axis">{fmt(s.from)}</text><text x={W - R} y={H - 6} textAnchor="end" className="traffic-axis">{fmt(s.to)}</text>
      </svg>
      <div className="traffic-hover" aria-live="polite">{hover ? <><strong>{fmt(hover.ts)}</strong> — {fmtBytes(hover.bytes)} in {num(hover.sessions)} sessions{hover.blocked ? `, ${num(hover.blocked)} blocked` : ''}</> : <span className="muted">Move over the bars for the numbers. The red mark under a bar is a period with blocked sessions.</span>}</div>
    </div>
  );
}

function TopList({ title, label, rows, max, blockedFirst }) {
  return (
    <div className="card syslog-top">
      <h3>{title}</h3>
      {rows.length === 0 ? <p className="muted">Nothing yet.</p> : (
        <table className="table"><thead><tr><th>{label}</th><th className="num">{blockedFirst ? 'Blocked' : 'Traffic'}</th><th className="num">Sessions</th></tr></thead>
          <tbody>{rows.map((r) => (
            <tr key={r.key}><td className="mono syslog-key" title={r.key}>{r.key}{r.name && <span className="muted"> {r.name}</span>}{!blockedFirst && r.blocked > 0 && <span className="syslog-tag">{num(r.blocked)} blocked</span>}<div className="syslog-meter"><i style={{ width: `${Math.max(2, ((blockedFirst ? r.blocked : r.bytes) / max) * 100)}%` }} className={blockedFirst ? 'is-blocked' : ''} /></div></td>
              <td className="num">{blockedFirst ? num(r.blocked) : fmtBytes(r.bytes)}</td><td className="num">{num(r.sessions)}</td></tr>))}</tbody></table>
      )}
    </div>
  );
}

function Summary({ status }) {
  const [range, setRange] = useState('24h');
  const [device, setDevice] = useState('');
  const [s, setS] = useState(null);
  const [err, setErr] = useState(null);
  useEffect(() => { api.get(`/syslog/summary?range=${range}${device ? `&device=${encodeURIComponent(device)}` : ''}`).then((d) => { setS(d); setErr(null); }).catch((e) => setErr(e.message)); }, [range, device, status?.counters?.parsed]);
  if (err) return <p className="error">{err}</p>;
  if (!s) return null;
  const evN = (lvl) => s.events.filter((e) => e.level === lvl).reduce((t, e) => t + e.n, 0);
  return (
    <>
      <div className="syslog-bar-head">
        <div className="diag-tabs traffic-ranges" role="tablist">{RANGES.map(([k, l]) => <button key={k} type="button" role="tab" aria-selected={range === k} className={range === k ? 'is-active' : ''} onClick={() => setRange(k)}>{l}</button>)}</div>
        {s.devices.length > 1 && <label>Firewall<select value={device} onChange={(e) => setDevice(e.target.value)} aria-label="Firewall"><option value="">All</option>{s.devices.map((d) => <option key={d}>{d}</option>)}</select></label>}
      </div>
      <div className="traffic-stats syslog-stats">
        <div className="traffic-stat"><span className="muted">Sessions</span><strong>{num(s.sessions)}</strong></div>
        <div className="traffic-stat"><span className="muted">Traffic</span><span>out <strong>{fmtBytes(s.bytes_out)}</strong></span><span>in <strong>{fmtBytes(s.bytes_in)}</strong></span></div>
        <div className="traffic-stat"><span className="muted">Blocked</span><strong>{num(s.blocked)}</strong><span className="muted">{s.sessions ? `${((s.blocked / s.sessions) * 100).toFixed(1)}% of the sessions` : ''}</span></div>
        <div className="traffic-stat"><span className="muted">Security events</span><span><strong>{num(evN('critical') + evN('warning'))}</strong> to look at</span><span className="muted">{num(evN('info'))} for the record</span></div>
      </div>
      <div className="card"><Bars s={s} /></div>
      {s.sessions === 0 ? <div className="card"><p className="muted">No traffic logs in this range. Traffic is only logged by policies that have logging on (<span className="mono">set logtraffic all</span>), and the syslog filter must forward traffic logs: see “Setup”.</p></div> : (
        <div className="syslog-grid">
          {DIM_TITLES.map(([k, t, label]) => <TopList key={k} title={t} label={label} rows={s.top[k]} max={Math.max(1, ...s.top[k].map((r) => (k === 'blocked_src' ? r.blocked : r.bytes)))} blockedFirst={k === 'blocked_src'} />)}
        </div>
      )}
    </>
  );
}

function Events() {
  const [f, setF] = useState({ kind: '', level: '', q: '' });
  const [rows, setRows] = useState(null);
  const [more, setMore] = useState(false);
  const [open, setOpen] = useState(null);
  const query = (extra = '') => `/syslog/events?limit=100${f.kind ? `&kind=${f.kind}` : ''}${f.level ? `&level=${f.level}` : ''}${f.q ? `&q=${encodeURIComponent(f.q)}` : ''}${extra}`;
  useEffect(() => { const t = setTimeout(() => api.get(query()).then((r) => { setRows(r); setMore(r.length === 100); setOpen(null); }).catch(() => setRows([])), 250); return () => clearTimeout(t); }, [f]); // eslint-disable-line react-hooks/exhaustive-deps
  async function older() { const r = await api.get(query(`&before=${rows[rows.length - 1].id}`)); setRows([...rows, ...r]); setMore(r.length === 100); }
  return (
    <>
      <div className="card form-row">
        <label>Kind<select value={f.kind} onChange={(e) => setF({ ...f, kind: e.target.value })} aria-label="Kind"><option value="">All</option>{Object.entries(KIND).map(([k, l]) => <option key={k} value={k}>{l}</option>)}</select></label>
        <label>Level<select value={f.level} onChange={(e) => setF({ ...f, level: e.target.value })} aria-label="Level"><option value="">All</option><option value="critical">critical</option><option value="warning">warning</option><option value="info">info</option></select></label>
        <label className="cab-grow">Search<input value={f.q} onChange={(e) => setF({ ...f, q: e.target.value })} placeholder="a user, an address, a word of the description" aria-label="Search events" autoComplete="off" /></label>
      </div>
      <div className="card">
        {rows === null ? null : rows.length === 0 ? <p className="muted">No events{f.kind || f.level || f.q ? ' that match' : ' yet'}.</p> : (
          <table className="table syslog-events"><thead><tr><th>Time</th><th>Level</th><th>Kind</th><th>What</th><th>Firewall</th></tr></thead>
            <tbody>{rows.map((e) => (
              <Fragment key={e.id}>
                <tr className="syslog-event" onClick={() => setOpen(open === e.id ? null : e.id)} tabIndex={0} onKeyDown={(ev) => ev.key === 'Enter' && setOpen(open === e.id ? null : e.id)} aria-expanded={open === e.id}>
                  <td className="mono">{new Date(e.ts * 1000).toLocaleString()}</td><td><span className={`status-badge ${LEVEL[e.level]}`}>{e.level}</span></td><td>{KIND[e.kind] || e.kind}</td><td>{e.summary}</td><td>{e.device}</td>
                </tr>
                {open === e.id && <tr className="syslog-raw"><td colSpan={5}><pre className="diag-raw">{e.raw}</pre></td></tr>}
              </Fragment>))}</tbody></table>
        )}
        {more && <p><button type="button" className="cab-btn-ghost" onClick={older}>Older events</button></p>}
      </div>
    </>
  );
}

function Setup({ canAdmin, status, onSaved }) {
  const host = window.location.hostname;
  const [f, setF] = useState(null);
  const [msg, setMsg] = useState(null);
  useEffect(() => { if (canAdmin) api.get('/syslog/settings').then(setF).catch(() => {}); }, [canAdmin]);
  const set = (k, v) => { setF({ ...f, [k]: v }); setMsg(null); };
  async function save(e) {
    e.preventDefault();
    try {
      const body = { ...f }; for (const k of ['enabled', 'notify_admin_login', 'notify_config_change', 'notify_ips', 'notify_vpn_failed', 'notify_system']) body[k] = !!f[k];
      for (const k of ['udp_port', 'tcp_port', 'event_days', 'hourly_days', 'fail_count', 'fail_window_minutes', 'silent_minutes']) body[k] = Number(f[k]);
      setF(await api.put('/syslog/settings', body)); setMsg({ type: 'success', text: 'Saved.' }); onSaved();
    } catch (err) { setMsg({ type: 'error', text: err.message }); }
  }
  const port = f?.udp_port || status?.udp?.port || 5140;
  const cli = `config log syslogd setting\n    set status enable\n    set server "${host}"\n    set mode udp\n    set port ${port}\n    set format default\nend\nconfig log syslogd filter\n    set severity information\n    set forward-traffic enable\n    set local-traffic disable\n    set anomaly enable\nend`;
  return (
    <>
      {canAdmin && f && (
        <form className="card" onSubmit={save}>
          <h2>Reception</h2>
          <div className="form-row">
            <label className="checkbox-row"><input type="checkbox" checked={!!f.enabled} onChange={(e) => set('enabled', e.target.checked)} /><span>Receive firewall logs</span></label>
            <label>UDP port<input type="number" min="1" max="65535" value={f.udp_port} onChange={(e) => set('udp_port', e.target.value)} className="cab-in-num" aria-label="UDP port" /></label>
            <label>TCP port (0 = off)<input type="number" min="0" max="65535" value={f.tcp_port} onChange={(e) => set('tcp_port', e.target.value)} className="cab-in-num" aria-label="TCP port" /></label>
          </div>
          <label className="syslog-wide">Addresses that may send, besides the FortiGates of the router list
            <input value={f.allowed_sources} onChange={(e) => set('allowed_sources', e.target.value)} placeholder="the address the firewall sends from, e.g. 10.1.0.1" aria-label="Allowed senders" autoComplete="off" />
          </label>
          <h3 className="cab-h3">What is announced</h3>
          <div className="form-row">
            <label>Failed logins: from<input type="number" min="2" max="50" value={f.fail_count} onChange={(e) => set('fail_count', e.target.value)} className="cab-in-num" aria-label="Failed logins" /></label>
            <label>within (minutes)<input type="number" min="1" max="60" value={f.fail_window_minutes} onChange={(e) => set('fail_window_minutes', e.target.value)} className="cab-in-num" aria-label="Window minutes" /></label>
            <label>Silence after (minutes)<input type="number" min="2" max="240" value={f.silent_minutes} onChange={(e) => set('silent_minutes', e.target.value)} className="cab-in-num" aria-label="Silence minutes" /></label>
          </div>
          <div className="syslog-flags">
            {[['notify_config_change', 'A change of the configuration (said once, when it is over)'], ['notify_ips', 'An attack or malware that was stopped (severity high or critical)'], ['notify_vpn_failed', 'Failed VPN logins (a burst)'], ['notify_system', 'System events (memory, HA, restart)'], ['notify_admin_login', 'Every successful administrator login']].map(([k, l]) => <label key={k} className="checkbox-row"><input type="checkbox" checked={!!f[k]} onChange={(e) => set(k, e.target.checked)} /><span>{l}</span></label>)}
          </div>
          <h3 className="cab-h3">What is kept</h3>
          <div className="form-row">
            <label>Events (days)<input type="number" min="7" max="365" value={f.event_days} onChange={(e) => set('event_days', e.target.value)} className="cab-in-num" aria-label="Event days" /></label>
            <label>Hourly summaries (days)<input type="number" min="30" max="1100" value={f.hourly_days} onChange={(e) => set('hourly_days', e.target.value)} className="cab-in-num" aria-label="Summary days" /></label>
            <button type="submit">Save</button>
          </div>
          {msg && <p className={msg.type === 'error' ? 'error' : 'success'} role="status">{msg.text}</p>}
        </form>
      )}
      <div className="card">
        <h2>On the FortiGate</h2>
        <p className="muted">Logs can go to several places at once, so FortiCloud stays as it is. Use the address of this server in place of <span className="mono">{host}</span> if the firewall cannot resolve the name.</p>
        <pre className="diag-raw syslog-cli" aria-label="FortiGate commands">{cli}</pre>
        <ul className="syslog-notes">
          <li><strong>Format</strong> must be <span className="mono">default</span> (the key=value text), not CSV, CEF or JSON.</li>
          <li>Traffic is only in the logs of <strong>policies that log</strong>: <span className="mono">set logtraffic all</span> (or <span className="mono">utm</span>) on the policy. Logging to FortiCloud does not change that.</li>
          <li>The firewall sends from <strong>one of its own addresses</strong>; if “Turned away” shows an address, that is it: allow it. A port above 1023 (like {port}) needs no extra privileges here; if the server has a firewall of its own, open that port for UDP{f?.tcp_port ? ' and TCP' : ''}.</li>
          <li>Security events (logins, configuration, VPN, attacks) come from the <span className="mono">event</span> and <span className="mono">utm</span> logs; the syslog filter above lets them through at severity “information”.</li>
        </ul>
      </div>
    </>
  );
}
