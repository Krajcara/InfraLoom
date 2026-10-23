import { Fragment, useEffect, useMemo, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { api } from '../api';
import './diagnostics.css';

const TOOLS = [
  ['ping', 'Ping'], ['traceroute', 'Traceroute'], ['dns', 'DNS'], ['port', 'Ports'], ['tls', 'Certificate'], ['http', 'HTTP'], ['mtu', 'MTU'],
];
const DNS_TYPES = ['A', 'AAAA', 'MX', 'TXT', 'NS', 'SOA', 'CNAME', 'PTR', 'SRV', 'CAA'];
const PRESET_SERVERS = [['system', 'This server\'s own DNS'], ['1.1.1.1', 'Cloudflare 1.1.1.1'], ['8.8.8.8', 'Google 8.8.8.8'], ['9.9.9.9', 'Quad9 9.9.9.9']];
const PORT_SETS = [['Web', '80,443'], ['SSH', '22'], ['RDP', '3389'], ['DNS', '53'], ['Mail', '25,465,587,993'], ['SMB', '445']];
const ms = (v) => (v == null ? '—' : `${v} ms`);

export default function DiagnosticsPage() {
  const [params, setParams] = useSearchParams();
  const tool = TOOLS.some(([k]) => k === params.get('tool')) ? params.get('tool') : 'ping';
  const [state, setState] = useState({ busy: false, error: null, result: null });
  const [local, setLocal] = useState([]);
  const [f, setF] = useState({
    host: params.get('host') || '', count: 4, size: 56, df: false, maxHops: 15,
    name: params.get('name') || '', type: 'A', servers: ['system', '1.1.1.1'], extra: '',
    ports: '443', port: 443, servername: '', url: '', method: 'GET', follow: true, ignoreCert: false,
  });
  const set = (k, v) => setF((x) => ({ ...x, [k]: v }));

  useEffect(() => { api.get('/diagnostics/dns-servers').then(setLocal).catch(() => setLocal([])); }, []);
  useEffect(() => { setState({ busy: false, error: null, result: null }); }, [tool]);

  const body = useMemo(() => {
    switch (tool) {
      case 'ping': return { host: f.host, count: Number(f.count), size: Number(f.size), dontFragment: f.df };
      case 'traceroute': return { host: f.host, maxHops: Number(f.maxHops) };
      case 'dns': return { name: f.name, type: f.type, servers: [...f.servers, ...f.extra.split(/[\s,;]+/).filter(Boolean)] };
      case 'port': return { host: f.host, ports: f.ports };
      case 'tls': return { host: f.host, port: Number(f.port), servername: f.servername || undefined };
      case 'http': return { url: f.url, method: f.method, followRedirects: f.follow, ignoreCertErrors: f.ignoreCert };
      default: return { host: f.host };
    }
  }, [tool, f]);

  async function run(e) {
    e.preventDefault();
    setState({ busy: true, error: null, result: null });
    try { setState({ busy: false, error: null, result: await api.post(`/diagnostics/${tool}`, body) }); } catch (err) { setState({ busy: false, error: err.message, result: null }); }
  }

  const toggleServer = (s) => set('servers', f.servers.includes(s) ? f.servers.filter((x) => x !== s) : [...f.servers, s]);
  const hostField = (label = 'Host or IP address') => (
    <label className="cab-grow">{label}
      <input value={f.host} onChange={(e) => set('host', e.target.value)} placeholder="10.1.0.1 or example.com" aria-label="Host" autoComplete="off" required />
    </label>
  );

  return (
    <div className="page diag">
      <div className="diag-head"><h1>Diagnostics</h1></div>
      <p className="muted">Run from the InfraLoom server, so you see the network the way the server does. Each run is logged. For what a device itself sees, capture on it — see the <a href="/capture-helper">Capture helper</a>.</p>
      <nav className="diag-tabs" role="tablist">
        {TOOLS.map(([k, l]) => <button key={k} type="button" role="tab" aria-selected={tool === k} className={tool === k ? 'is-active' : ''} onClick={() => setParams({ tool: k })}>{l}</button>)}
      </nav>

      <form className="card" onSubmit={run}>
        <div className="form-row">
          {tool === 'ping' && (<>
            {hostField()}
            <label>Packets<input type="number" min="1" max="10" value={f.count} onChange={(e) => set('count', e.target.value)} className="cab-in-num" aria-label="Packets" /></label>
            <label>Size (bytes)<input type="number" min="0" max="9000" value={f.size} onChange={(e) => set('size', e.target.value)} className="cab-in-num" aria-label="Size" /></label>
            <label className="checkbox-row"><input type="checkbox" checked={f.df} onChange={(e) => set('df', e.target.checked)} /><span>Don't fragment</span></label>
          </>)}
          {tool === 'traceroute' && (<>{hostField()}<label>Max hops<input type="number" min="1" max="30" value={f.maxHops} onChange={(e) => set('maxHops', e.target.value)} className="cab-in-num" aria-label="Max hops" /></label></>)}
          {tool === 'dns' && (<>
            <label className="cab-grow">Name or IP address<input value={f.name} onChange={(e) => set('name', e.target.value)} placeholder="bizcentar.com" aria-label="Name" autoComplete="off" required /></label>
            <label>Type<select value={f.type} onChange={(e) => set('type', e.target.value)} aria-label="Record type">{DNS_TYPES.map((t) => <option key={t}>{t}</option>)}</select></label>
          </>)}
          {tool === 'port' && (<>{hostField()}<label className="cab-grow">Ports (up to ten, comma separated)<input value={f.ports} onChange={(e) => set('ports', e.target.value)} aria-label="Ports" autoComplete="off" required /></label></>)}
          {tool === 'tls' && (<>{hostField()}<label>Port<input type="number" min="1" max="65535" value={f.port} onChange={(e) => set('port', e.target.value)} className="cab-in-num" aria-label="Port" /></label><label>Name to ask for (SNI)<input value={f.servername} onChange={(e) => set('servername', e.target.value)} placeholder="same as the host" aria-label="SNI" autoComplete="off" /></label></>)}
          {tool === 'http' && (<>
            <label className="cab-grow">Address<input value={f.url} onChange={(e) => set('url', e.target.value)} placeholder="https://example.com/" aria-label="Address" autoComplete="off" required /></label>
            <label>Method<select value={f.method} onChange={(e) => set('method', e.target.value)} aria-label="Method"><option>GET</option><option>HEAD</option></select></label>
            <label className="checkbox-row"><input type="checkbox" checked={f.follow} onChange={(e) => set('follow', e.target.checked)} /><span>Follow redirects</span></label>
            <label className="checkbox-row"><input type="checkbox" checked={f.ignoreCert} onChange={(e) => set('ignoreCert', e.target.checked)} /><span>Ignore certificate errors</span></label>
          </>)}
          {tool === 'mtu' && hostField()}
          <button type="submit" disabled={state.busy}>{state.busy ? 'Running…' : 'Run'}</button>
        </div>
        {tool === 'dns' && (
          <div className="diag-servers">
            <span className="muted">Ask (up to four):</span>
            {[...PRESET_SERVERS, ...local.map((s) => [s.ip, `${s.label || s.role} ${s.ip}`])].map(([v, l]) => (
              <label key={v} className="checkbox-row"><input type="checkbox" checked={f.servers.includes(v)} onChange={() => toggleServer(v)} /><span>{l}</span></label>
            ))}
            <input value={f.extra} onChange={(e) => set('extra', e.target.value)} placeholder="another server, e.g. 10.1.0.2" aria-label="Another DNS server" autoComplete="off" className="diag-extra" />
          </div>
        )}
        {tool === 'port' && (
          <div className="diag-servers"><span className="muted">Usual sets:</span>{PORT_SETS.map(([l, v]) => <button key={l} type="button" className="cab-btn-ghost" onClick={() => set('ports', v)}>{l} ({v})</button>)}</div>
        )}
      </form>

      {state.error && <p className="error" role="alert">{state.error}</p>}
      {state.result && <Result r={state.result} />}
    </div>
  );
}

function Result({ r }) {
  const [raw, setRaw] = useState(false);
  return (
    <div className="card diag-result" data-tool={r.tool}>
      {r.tool === 'ping' && <PingResult r={r} />}
      {r.tool === 'traceroute' && <TraceResult r={r} />}
      {r.tool === 'dns' && <DnsResult r={r} />}
      {r.tool === 'port' && <PortResult r={r} />}
      {r.tool === 'tls' && <TlsResult r={r} />}
      {r.tool === 'http' && <HttpResult r={r} />}
      {r.tool === 'mtu' && <MtuResult r={r} />}
      {r.raw && (<><button type="button" className="btn-link" onClick={() => setRaw(!raw)}>{raw ? 'Hide' : 'Show'} the raw output</button>{raw && <pre className="diag-raw">{r.raw}</pre>}</>)}
    </div>
  );
}

function PingResult({ r }) {
  if (r.error) return <p className="error">{r.error}</p>;
  const max = Math.max(1, ...r.replies.map((x) => x.time));
  return (
    <>
      <p className={`diag-verdict ${r.received === 0 ? 'is-bad' : r.loss > 0 ? 'is-warn' : 'is-ok'}`}>
        {r.received === 0 ? `No answer from ${r.host}` : `${r.host} answers`} — {r.sent} sent, {r.received} received, <strong>{r.loss}% lost</strong>
        {r.rtt && <> · min {r.rtt.min} / avg <strong>{r.rtt.avg}</strong> / max {r.rtt.max} ms</>}
        {r.resolved && r.resolved !== r.host && <span className="muted"> ({r.resolved})</span>}
      </p>
      <div className="diag-bars" aria-label="Round-trip times">{r.replies.map((x) => <div key={x.seq} className="diag-bar" title={`#${x.seq}: ${x.time} ms, ttl ${x.ttl}`}><i style={{ height: `${Math.max(4, (100 * x.time) / max)}%` }} /><span>{x.time}</span></div>)}</div>
      {r.hints.map((h) => <p key={h} className="diag-hint">{h}</p>)}
      {r.dontFragment && r.received === 0 && <p className="muted">With "don't fragment" a packet that is too big for a link on the way is dropped: try a smaller size, or the MTU tool.</p>}
    </>
  );
}

function TraceResult({ r }) {
  return (
    <>
      <p className="muted">Method: {r.method}{r.pmtu ? ` · path MTU ${r.pmtu}` : ''}{r.timedOut ? ' · stopped at the time limit' : ''}</p>
      <table className="table"><thead><tr><th>Hop</th><th>Address</th><th>Time</th><th /></tr></thead>
        <tbody>{r.hops.map((h) => <tr key={h.hop}><td>{h.hop}</td><td className="mono">{h.address || '*'}</td><td>{h.rtt == null ? '—' : `${h.rtt} ms`}</td><td className="muted">{h.note || ''}</td></tr>)}</tbody></table>
      {!r.hops.length && <p className="muted">Nothing came back.</p>}
    </>
  );
}

function DnsResult({ r }) {
  return (
    <>
      {r.differs && <p className="diag-verdict is-warn">The servers do not give the same answer. If one of them is your own DNS, it may hold its own copy of the zone.</p>}
      <div className="diag-cols">
        {r.results.map((x) => (
          <div key={x.server} className="diag-col">
            <h3>{x.server === 'system' ? 'This server\'s DNS' : x.server}</h3>
            <p><span className={`status-badge ${x.status === 'ok' ? 'status-up' : ''}`}>{{ ok: 'answer', nodata: 'no records of this type', nxdomain: 'name does not exist', timeout: 'no answer (timeout)', refused: 'refused' }[x.status] || x.error || 'error'}</span> <span className="muted">{x.ms} ms</span></p>
            {x.answers.length > 0 && <ul className="diag-answers">{x.answers.map((a) => <li key={a} className="mono">{a}</li>)}</ul>}
          </div>
        ))}
      </div>
    </>
  );
}

function PortResult({ r }) {
  const label = { open: 'open', closed: 'closed (refused)', filtered: 'no answer (filtered?)', error: 'error' };
  return (
    <table className="table"><thead><tr><th>Port</th><th>State</th><th>Time</th></tr></thead>
      <tbody>{r.results.map((x) => <tr key={x.port}><td className="mono">{x.port}</td><td><span className={`status-badge ${x.status === 'open' ? 'status-up' : ''}`}>{label[x.status]}</span>{x.error ? <span className="muted"> {x.error}</span> : null}</td><td>{x.ms} ms</td></tr>)}</tbody></table>
  );
}

function TlsResult({ r }) {
  const tone = r.expired ? 'is-bad' : r.daysLeft < 14 ? 'is-bad' : r.daysLeft < 30 ? 'is-warn' : 'is-ok';
  return (
    <>
      <p className={`diag-verdict ${tone}`}>{r.expired ? 'The certificate has expired' : `Valid for ${r.daysLeft} more days`} — until {new Date(r.validTo).toLocaleDateString()}</p>
      <dl className="diag-dl">
        <dt>For</dt><dd>{r.subject}</dd>
        <dt>Names</dt><dd className="mono">{r.sans.join(', ') || '—'}</dd>
        <dt>Issued by</dt><dd>{r.issuer}</dd>
        <dt>Trusted</dt><dd>{r.trusted ? 'yes' : `no — ${r.trustError}`}</dd>
        {r.nameMatches != null && <><dt>Name matches</dt><dd>{r.nameMatches ? `yes (${r.servername})` : `no — the certificate is not for ${r.servername}`}</dd></>}
        <dt>Protocol</dt><dd>{r.protocol} · {r.cipher}</dd>
        <dt>Chain</dt><dd>{r.chain.map((c) => c.subject).join(' → ')}</dd>
        <dt>Fingerprint</dt><dd className="mono diag-fp">{r.fingerprint256}</dd>
      </dl>
    </>
  );
}

function HttpResult({ r }) {
  return (
    <>
      <p className={`diag-verdict ${r.final.status >= 400 ? 'is-bad' : r.final.status >= 300 ? 'is-warn' : 'is-ok'}`}>{r.final.status} {r.final.statusText} — {r.final.timings.total} ms{r.redirects ? ` after ${r.redirects} redirect${r.redirects === 1 ? '' : 's'}` : ''}</p>
      <table className="table"><thead><tr><th>Address</th><th>Status</th><th>DNS</th><th>Connect</th><th>TLS</th><th>First byte</th><th>Total</th></tr></thead>
        <tbody>{r.steps.map((s) => <tr key={s.url}><td className="mono diag-url">{s.url}<span className="muted"> {s.remote}</span></td><td>{s.status}</td><td>{ms(s.timings.dns)}</td><td>{ms(s.timings.connect)}</td><td>{ms(s.timings.tls)}</td><td>{ms(s.timings.firstByte)}</td><td>{ms(s.timings.total)}</td></tr>)}</tbody></table>
      <dl className="diag-dl">{Object.entries(r.final.headers).map(([k, v]) => <Fragment key={k}><dt>{k}</dt><dd className="mono">{v}</dd></Fragment>)}</dl>
    </>
  );
}

function MtuResult({ r }) {
  return (
    <>
      <p className={`diag-verdict ${r.mtu ? 'is-ok' : 'is-bad'}`}>{r.mtu ? <>Path MTU: <strong>{r.mtu}</strong> (largest payload {r.payload})</> : 'No packet got through'}</p>
      <p className="muted">{r.note}</p>
      <table className="table"><thead><tr><th>Packet size</th><th>Result</th></tr></thead><tbody>{r.steps.map((s) => <tr key={s.payload}><td className="mono">{s.mtu}</td><td>{s.ok ? 'passes' : 'too big'}</td></tr>)}</tbody></table>
    </>
  );
}
