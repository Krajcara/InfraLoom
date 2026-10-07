import { useCallback, useEffect, useState } from 'react';
import { api } from '../api';
import { useSocket } from '../hooks/useSocket';

const when = (iso) => (iso ? new Date(iso).toLocaleString([], { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit', second: '2-digit' }) : '—');
const uptime = (s) => {
  if (s == null) return '—';
  const d = Math.floor(s / 86400), h = Math.floor((s % 86400) / 3600), m = Math.floor((s % 3600) / 60);
  return d > 0 ? `${d}d ${h}h` : h > 0 ? `${h}h ${m}m` : `${m}m`;
};
const levelClass = (level) => (level === 'crit' ? 'status-down' : level === 'warn' ? 'status-degraded' : 'status-up');

/** Short text for a badge; the full sentence is in the tooltip. */
export function alertLabel(a) {
  const v = Math.round(a.value);
  const tail = (s) => String(s).split(' / ').slice(-1)[0];
  switch (a.kind) {
    case 'cpu': return `CPU ${v}%`;
    case 'memory': return `RAM ${v}%`;
    case 'disk': return `${a.subject === 'disk' ? 'disk' : a.subject} ${v}%`;
    case 'temperature': return `${v} °C`;
    case 'ipsec': return `VPN ${a.subject}`;
    case 'ha': return 'HA';
    case 'licence': return `${tail(a.subject)} ${a.value < 0 ? 'expired' : `${v}d`}`;
    case 'sdwan': return `SD-WAN ${tail(a.subject)}`;
    case 'link': return `${a.subject} down`;
    case 'poll': return 'no health data';
    case 'rating': return a.level === 'crit' ? 'health: poor' : 'health: fair';
    case 'fan': return 'fan';
    case 'psu': return `PSU ${a.subject}`;
    case 'poe': return `PoE ${v}%`;
    case 'uplink': return `uplink ${v} Mbps`;
    default: return a.kind;
  }
}

/** Badges for what is over a level on a device (used in the device list). */
export function HealthBadges({ device }) {
  const h = device.health;
  if (!h?.enabled) return null;
  return (
    <>
      {h.alerts.map((a) => (
        <span key={`${a.kind}|${a.subject}`} className={`status-badge ${levelClass(a.level)}`} style={{ marginLeft: 6 }} title={a.detail}>{alertLabel(a)}</span>
      ))}
    </>
  );
}

function Section({ title, children }) {
  return <div className="health-section"><h3>{title}</h3>{children}</div>;
}

function FortiGateReading({ last, canAdmin, onResetHa }) {
  const s = last.sections;
  const bad = Object.entries(s).filter(([, v]) => !v.ok);
  const r = s.resources?.ok ? s.resources.data : null;
  return (
    <>
      {bad.length > 0 && (
        <p className="muted">{bad.map(([k, v]) => `${k}: ${v.error}`).join(' · ')}</p>
      )}
      {r && <Section title="Resources"><p>CPU {r.cpu ?? '—'}% · memory {r.memory ?? '—'}%{r.disk != null && <> · disk {r.disk}%</>}{r.sessions != null && <> · {r.sessions} sessions</>}</p></Section>}
      {s.ha?.ok && (
        <Section title="High availability">
          <p>
            {s.ha.data.mode === 'standalone' ? 'Standalone unit (no HA configured).' : `Mode ${s.ha.data.mode}, ${s.ha.data.count} member${s.ha.data.count === 1 ? '' : 's'}${last.baselines?.ha ? ` (expected ${last.baselines.ha})` : ''}`}
            {s.ha.data.mode !== 'standalone' && canAdmin && <> <button className="btn-link" onClick={onResetHa} title="Forget the highest member count seen, e.g. after you removed a node on purpose">Reset expected members</button></>}
          </p>
          {s.ha.data.members.length > 0 && <p className="muted">{s.ha.data.members.map((m) => m.hostname || m.serial).join(', ')}</p>}
        </Section>
      )}
      {s.ipsec?.ok && (
        <Section title={`IPsec tunnels (${s.ipsec.data.length})`}>
          {s.ipsec.data.length === 0 ? <p className="muted">No site-to-site tunnels found.</p> : (
            <table className="table"><tbody>
              {s.ipsec.data.map((t) => (
                <tr key={t.name}><td>{t.name}</td><td><span className={`status-badge ${t.state === 'up' ? 'status-up' : t.state === 'partial' ? 'status-degraded' : 'status-down'}`}>{t.state}</span></td><td className="muted">{t.total ? `${t.up}/${t.total} selectors` : 'not established'}</td></tr>
              ))}
            </tbody></table>
          )}
        </Section>
      )}
      {s.licenses?.ok && (
        <Section title={`Licences and support (${s.licenses.data.length})`}>
          {s.licenses.data.length === 0 ? <p className="muted">No entitlement with an expiry date was found in the reply (see the raw reply).</p> : (
            <table className="table"><tbody>
              {s.licenses.data.map((l) => (
                <tr key={l.name}><td>{l.name}</td><td className="muted">{l.expires_at.slice(0, 10)}</td><td><span className={`status-badge ${l.days_left <= 7 ? 'status-down' : l.days_left <= 30 ? 'status-degraded' : 'status-up'}`}>{l.days_left < 0 ? `expired ${-l.days_left}d ago` : `${l.days_left} days`}</span></td></tr>
              ))}
            </tbody></table>
          )}
        </Section>
      )}
      {s.sdwan?.ok && s.sdwan.data.length > 0 && (
        <Section title="SD-WAN health checks">
          <table className="table"><tbody>
            {s.sdwan.data.map((m) => <tr key={m.name}><td>{m.name}</td><td><span className={`status-badge ${m.state === 'up' ? 'status-up' : 'status-down'}`}>{m.state}</span></td></tr>)}
          </tbody></table>
        </Section>
      )}
    </>
  );
}

const ratingBadge = (r) => <span className={`status-badge ${!r || /^good$/i.test(r) ? 'status-up' : /fair|moderate|warn/i.test(r) ? 'status-degraded' : 'status-down'}`}>{r || '—'}</span>;

function ManagedSwitchReading({ last }) {
  const r = last.reading;
  return (
    <>
      <Section title="Reported by the FortiGate">
        <p>
          Health {ratingBadge(r.overall)}{r.not_good.length > 0 && <span className="muted"> ({r.not_good.join(', ')})</span>} · up {uptime(r.uptime_s)}
        </p>
        <p>
          CPU {r.cpu ?? '—'}% · memory {r.memory ?? '—'}%{r.temperature != null && <> · {r.temperature} °C</>}
          {r.fans.map((f) => <span key={f.name}> · {f.name} {f.status}{f.speed != null && ` ${Math.round(f.speed)}%`}</span>)}
          {r.psu.map((p) => <span key={p.name}> · {p.name} {p.status}</span>)}
        </p>
        {r.poe && <p>PoE: {Math.round(r.poe.used_w * 10) / 10} of {r.poe.max_w} W in use ({r.poe.pct}%)</p>}
      </Section>
    </>
  );
}

function ManagedApReading({ last }) {
  const r = last.reading;
  return (
    <>
      <Section title="Reported by the FortiGate">
        <p>
          {r.state} · health {ratingBadge(r.overall)} · {r.clients ?? 0} client{r.clients === 1 ? '' : 's'} · CPU {r.cpu ?? '—'}% · memory {r.memory ?? '—'}%
        </p>
        <p>
          {r.uplink && <>Uplink {r.uplink.mbps ?? '—'} Mbps {ratingBadge(r.uplink.severity)} · </>}
          {r.connected_to && <>on {r.connected_to.switch} {r.connected_to.port} · </>}
          firmware {r.os_version || '—'}
          {last.reboot_epoch && <> · last reboot {new Date(last.reboot_epoch * 1000).toLocaleString([], { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' })}</>}
        </p>
        {r.last_failure && <p className="muted">Last failure: {r.last_failure}</p>}
      </Section>
      {r.radios.length > 0 && (
        <Section title="Radios">
          <table className="table"><tbody>
            {r.radios.map((x) => <tr key={x.id}><td>{x.type}</td><td className="muted">channel {x.channel ?? '—'}</td><td>{x.clients ?? 0} clients</td><td className="muted">{x.utilization ?? '—'}% busy</td><td>{ratingBadge(x.health)}</td></tr>)}
          </tbody></table>
        </Section>
      )}
    </>
  );
}

function SnmpReading({ last, watch, setWatch }) {
  const r = last.reading;
  const watched = new Set(watch.split(',').map((x) => x.trim().toLowerCase()).filter(Boolean));
  const toggle = (name) => {
    const list = watch.split(',').map((x) => x.trim()).filter(Boolean);
    const i = list.findIndex((x) => x.toLowerCase() === name.toLowerCase());
    if (i >= 0) list.splice(i, 1); else list.push(name);
    setWatch(list.join(', '));
  };
  return (
    <>
      <Section title="Device">
        <p>{r.sys.description || '—'}{r.version && <> · RouterOS {r.version}</>} · up {uptime(r.sys.uptime_s)}</p>
      </Section>
      <Section title="Resources">
        <p>
          CPU {r.cpu ?? '—'}%{r.cores > 1 && ` (${r.cores} cores)`} · memory {r.memory ? `${r.memory.pct}%` : '—'}
          {r.disks.map((d) => <span key={d.name}> · disk {d.name} {d.pct}%{/^RouterOS\b/i.test(r.sys.description || '') ? ' (flash, not alerted)' : ''}</span>)}
          {r.temperature != null && <> · {r.temperature} °C</>}{r.voltage != null && <> · {r.voltage} V</>}
        </p>
      </Section>
      {r.interfaces.length > 0 && (
        <Section title={`Interfaces (${r.interfaces.length}) — tick the ones that must stay up (uplinks)`}>
          <table className="table"><tbody>
            {r.interfaces.map((i) => (
              <tr key={i.name}>
                <td><label className="checkbox-row"><input type="checkbox" checked={watched.has(i.name.toLowerCase())} onChange={() => toggle(i.name)} /><span>{i.name}</span></label></td>
                <td><span className={`status-badge ${i.admin === 'down' ? '' : i.oper === 'up' ? 'status-up' : 'status-down'}`}>{i.admin === 'down' ? 'disabled' : i.oper}</span></td>
              </tr>
            ))}
          </tbody></table>
        </Section>
      )}
    </>
  );
}

export function DeviceHealthPanel({ apiPath, device, canAdmin, canOperate, onClose, onChanged }) {
  const base = `/${apiPath}/${device.id}/health`;
  const [data, setData] = useState(null);
  const [raw, setRaw] = useState(null);
  const [watch, setWatch] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  const [showRaw, setShowRaw] = useState(false);

  const load = useCallback(() => api.get(base).then((d) => { setData(d); setWatch((w) => (w === '' ? d.watch_ifaces.join(', ') : w)); }).catch((e) => setError(e.message)), [base]);
  useEffect(() => { setData(null); setRaw(null); setShowRaw(false); setWatch(''); load(); }, [load]);
  useSocket({ 'device-health:update': (e) => { if (e.id === device.id) load(); } });

  async function run(fn) {
    setBusy(true); setError(null);
    try { await fn(); await load(); onChanged?.(); } catch (e) { setError(e.message); } finally { setBusy(false); }
  }
  const setEnabled = (enabled) => run(async () => { await api.put(base, { enabled }); if (enabled) await api.post(`${base}/poll`); });
  const readNow = () => run(() => api.post(`${base}/poll`));
  const saveWatch = () => run(() => api.put(base, { watch_ifaces: watch.split(',').map((x) => x.trim()).filter(Boolean) }));
  const resetHa = () => run(() => api.put(base, { reset_ha_baseline: true }));
  const setManaged = (managed) => run(async () => { await api.put(base, { managed }); if (managed) await api.post(`${base}/poll`); });
  async function toggleRaw() {
    if (!showRaw) { try { setRaw(await api.get(`${base}/raw`)); } catch (e) { setError(e.message); } }
    setShowRaw(!showRaw);
  }

  if (!data) return <section className="card"><p className="muted">{error || 'Loading...'}</p></section>;
  const isManaged = !!device.discovered_from_router_id;
  const via = data.method === 'fortigate' ? 'the FortiGate REST API' : data.method === 'snmp' ? 'SNMP' : data.method === 'fortigate-managed' ? `the FortiGate that manages it${data.managed_by ? ` (${data.managed_by})` : ''}` : null;
  const last = data.last && (data.last.sections || data.last.reading) ? data.last : null;

  return (
    <section className="card health-panel">
      <div className="page-header-row">
        <h2>Health — {device.name}</h2>
        <button className="btn-link" onClick={onClose}>Close</button>
      </div>
      {error && <p className="error">{error}</p>}

      {!data.enabled && isManaged ? (
        <p className="muted">
          Health data of this device is read through the FortiGate that manages it{data.managed_by ? ` (${data.managed_by})` : ''}. It is not collected yet: open that FortiGate's Health panel and turn on
          "Also read the switches and access points it manages".
        </p>
      ) : !data.enabled ? (
        <>
          <p className="muted">
            Health data is not collected for this device. {via ? `InfraLoom would read it through ${via}` : 'It needs the FortiGate API token (brand fortigate) or SNMP settings'} every couple of minutes
            and alert on CPU, memory, {device.brand === 'fortigate' ? 'IPsec tunnels, HA, licences and SD-WAN' : 'temperature, restarts and the interfaces you choose'}.
          </p>
          {canAdmin && <button onClick={() => setEnabled(true)} disabled={busy || !via}>{busy ? 'Working...' : 'Start collecting health data'}</button>}
        </>
      ) : (
        <>
          <p className="muted">Read through {via || '—'}. Last reading: {when(data.checked_at)}.</p>
          {data.error && <p className="error">Could not read the device: {data.error}</p>}
          {data.alerts.length > 0 && (
            <div className="health-alerts">
              {data.alerts.map((a) => <p key={`${a.kind}|${a.subject}`}><span className={`status-badge ${levelClass(a.level)}`}>{a.level === 'crit' ? 'critical' : 'warning'}</span> {a.detail}</p>)}
            </div>
          )}
          {data.method === 'fortigate' && canAdmin && (
            <label className="checkbox-row">
              <input type="checkbox" checked={!!data.managed} onChange={(e) => setManaged(e.target.checked)} disabled={busy} />
              <span>Also read the health of the switches and access points this FortiGate manages (FortiLink) — CPU, memory, temperature, PoE, fans, FortiGate's own rating, and every restart</span>
            </label>
          )}
          {last?.sections && <FortiGateReading last={last} canAdmin={canAdmin} onResetHa={resetHa} />}
          {last?.method === 'snmp' && last.reading && <SnmpReading last={last} watch={watch} setWatch={setWatch} />}
          {last?.method === 'managed-switch' && <ManagedSwitchReading last={last} />}
          {last?.method === 'managed-ap' && <ManagedApReading last={last} />}
          {!last && !data.error && <p className="muted">No reading yet — press "Read now".</p>}

          {last?.method === 'snmp' && canAdmin && (
            <label>Watched interfaces (names, comma-separated)
              <input value={watch} onChange={(e) => setWatch(e.target.value)} placeholder="ether1, sfp-sfpplus1" />
            </label>
          )}
          <div className="form-row">
            {canOperate && <button onClick={readNow} disabled={busy}>{busy ? 'Reading...' : 'Read now'}</button>}
            {last?.method === 'snmp' && canAdmin && <button onClick={saveWatch} disabled={busy}>Save watched interfaces</button>}
            <button className="btn-link" onClick={toggleRaw}>{showRaw ? 'Hide raw reply' : 'Raw reply'}</button>
            {canAdmin && !isManaged && <button className="btn-link danger" onClick={() => setEnabled(false)} disabled={busy}>Stop collecting</button>}
          </div>
          {showRaw && (
            <div>
              <p className="muted">What the device actually answered ({when(raw?.checked_at)}). If a value above looks wrong, this shows the field names it was read from.</p>
              <pre className="mono health-raw">{raw?.raw ? JSON.stringify(raw.raw, null, 2) : '(nothing stored yet)'}</pre>
            </div>
          )}
        </>
      )}
    </section>
  );
}

export function DeviceHealthThresholds({ onClose }) {
  const [cfg, setCfg] = useState(null);
  const [active, setActive] = useState([]);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState(null);
  const [saved, setSaved] = useState(false);

  useEffect(() => { api.get('/device-health/thresholds').then((d) => { setCfg(d.config); setActive(d.active); }).catch((e) => setError(e.message)); }, []);
  if (!cfg) return <section className="card"><p className="muted">{error || 'Loading...'}</p></section>;

  const set = (kind, field, value) => setCfg({ ...cfg, [kind]: { ...cfg[kind], [field]: value } });
  async function save(e) {
    e.preventDefault(); setSaving(true); setError(null); setSaved(false);
    try { await api.put('/device-health/thresholds', cfg); setSaved(true); } catch (err) { setError(err.message); } finally { setSaving(false); }
  }
  const row = (kind, label, unit) => (
    <div key={kind} className="threshold-row">
      <label className="checkbox-row threshold-label"><input type="checkbox" checked={cfg[kind].enabled} onChange={(e) => set(kind, 'enabled', e.target.checked)} /><span>{label}</span></label>
      <input type="number" aria-label={`${label}: warning`} value={cfg[kind].warn} onChange={(e) => set(kind, 'warn', Number(e.target.value))} disabled={!cfg[kind].enabled} />
      <input type="number" aria-label={`${label}: critical`} value={cfg[kind].crit} onChange={(e) => set(kind, 'crit', Number(e.target.value))} disabled={!cfg[kind].enabled} />
      <span className="muted">{unit}</span>
    </div>
  );
  const toggle = (kind, label) => (
    <label key={kind} className="checkbox-row"><input type="checkbox" checked={cfg[kind].enabled} onChange={(e) => setCfg({ ...cfg, [kind]: { ...cfg[kind], enabled: e.target.checked } })} /><span>{label}</span></label>
  );

  return (
    <section className="card">
      <div className="page-header-row"><h2>Network device health thresholds</h2><button className="btn-link" onClick={onClose}>Close</button></div>
      <p className="muted">
        Devices are read every couple of minutes once you start collecting health data for them (the Health button on a device). A level has to hold for
        two readings before it alerts, an alert is not repeated, and "back to normal" is announced. These levels apply to every device.
      </p>
      {error && <p className="error">{error}</p>}
      {saved && <p className="success">Saved.</p>}
      <form onSubmit={save} autoComplete="off">
        <label className="checkbox-row"><input type="checkbox" checked={cfg.enabled} onChange={(e) => setCfg({ ...cfg, enabled: e.target.checked })} /><span><strong>Alert on device health</strong></span></label>
        <div className="threshold-grid">
          <span /><span className="threshold-head">Warning at</span><span className="threshold-head">Critical at</span><span />
          {row('cpu', 'CPU', '%')}
          {row('memory', 'Memory', '%')}
          {row('disk', 'Disk', '%')}
          {row('temperature', 'Temperature', '°C')}
          {row('poe', 'PoE budget used (switches)', '%')}
          {row('licence_days', 'Licence / support: days left', 'days')}
        </div>
        {toggle('rating', "Managed switches and APs: FortiGate's own verdict is not \"good\"")}
        {toggle('fan', 'Managed switches: fan or power supply failed')}
        {toggle('uplink', 'Managed APs: uplink rated worse than good')}
        {toggle('ipsec', 'FortiGate: IPsec tunnel down')}
        {toggle('ha', 'FortiGate: HA cluster lost a member')}
        {toggle('sdwan', 'FortiGate: SD-WAN member down')}
        {toggle('links', 'Watched interface down (SNMP devices)')}
        {toggle('restart', 'Device restarted (SNMP devices)')}
        {toggle('poll', 'Health data cannot be read (device or SNMP not answering)')}
        <div className="form-row"><button type="submit" disabled={saving}>{saving ? 'Saving...' : 'Save'}</button></div>
      </form>
      <h3>Over a level right now</h3>
      {active.length === 0 ? <p className="muted">Nothing.</p> : <ul>{active.map((a) => <li key={`${a.device_table}|${a.device_id}|${a.kind}|${a.subject}`}><span className={`status-badge ${levelClass(a.level)}`}>{a.level === 'crit' ? 'critical' : 'warning'}</span> {a.device_name}: {a.detail}</li>)}</ul>}
    </section>
  );
}
