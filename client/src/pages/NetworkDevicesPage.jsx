import { useEffect, useState } from 'react';
import { api } from '../api';
import { useAuth } from '../context/AuthContext';
import { useSocket } from '../hooks/useSocket';
import { formatDbDate } from '../utils/formatDate';
import MaintenanceBadge, { MaintenanceLink } from '../components/MaintenanceBadge';
import { DeviceHealthPanel, DeviceHealthThresholds, HealthBadges } from '../components/DeviceHealth';

const emptyForm = {
  name: '', brand: 'other', model: '', ip_address: '', username: '', device_password: '', notes: '', api_token: '',
  snmp_version: '2c', snmp_community: 'public', snmp_port: 161, snmp_username: '',
  snmp_auth_protocol: 'SHA', snmp_auth_password: '', snmp_priv_protocol: 'AES', snmp_priv_password: '',
  snmp_security_level: 'authPriv',
};

export default function NetworkDevicesPage({ apiPath, title }) {
  const { user } = useAuth();
  const canEdit = ['superadmin', 'admin', 'operator'].includes(user?.role);
  const canDelete = ['superadmin', 'admin'].includes(user?.role);

  const [devices, setDevices] = useState([]);
  const [brands, setBrands] = useState([]);
  const [form, setForm] = useState(null);
  const [showSnmp, setShowSnmp] = useState(false);
  const [error, setError] = useState(null);
  const [message, setMessage] = useState(null);
  const [revealed, setRevealed] = useState({});
  const [snmpResult, setSnmpResult] = useState(null);
  const [snmpLoading, setSnmpLoading] = useState(null);
  const [healthFor, setHealthFor] = useState(null);
  const [showHealthTh, setShowHealthTh] = useState(false);

  async function load() {
    try {
      const data = await api.get(`/${apiPath}`);
      setDevices(data.devices);
      setBrands(data.brands);
    } catch (err) {
      setError(err.message);
    }
  }

  useEffect(() => {
    load();
    setForm(null);
    setSnmpResult(null);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [apiPath]);

  useSocket({
    'monitor:status': ({ monitorId, status, latency_ms, checked_at }) => {
      setDevices((prev) =>
        prev.map((d) => (d.monitor_id === monitorId ? { ...d, last_status: status, last_latency_ms: latency_ms, last_checked_at: checked_at } : d))
      );
    },
    // Switches/APs discovered from a FortiGate report status from the controller, not a ping
    'devices:controller-sync': () => load(),
    'device-health:update': () => load(),
  });

  function flash(msg) {
    setMessage(msg);
    setError(null);
    setTimeout(() => setMessage(null), 4000);
  }

  function openCreate() {
    setForm({ ...emptyForm });
    setShowSnmp(false);
  }

  function openEdit(d) {
    setForm({
      id: d.id, name: d.name, brand: d.brand, model: d.model || '', ip_address: d.ip_address,
      username: d.username || '', device_password: '', notes: d.notes || '', api_token: '',
      snmp_version: d.snmp_version, snmp_community: d.snmp_community, snmp_port: d.snmp_port,
      snmp_username: d.snmp_username || '', snmp_auth_protocol: d.snmp_auth_protocol, snmp_auth_password: '',
      snmp_priv_protocol: d.snmp_priv_protocol, snmp_priv_password: '', snmp_security_level: d.snmp_security_level,
    });
    setShowSnmp(false);
  }

  async function save(e) {
    e.preventDefault();
    try {
      if (form.id) {
        await api.put(`/${apiPath}/${form.id}`, form);
      } else {
        await api.post(`/${apiPath}`, form);
      }
      setForm(null);
      flash('Saved.');
      load();
    } catch (err) {
      setError(err.message);
    }
  }

  async function remove(d) {
    if (!confirm(`Delete "${d.name}"? This also removes its ping monitor.`)) return;
    try {
      await api.del(`/${apiPath}/${d.id}`);
      flash('Deleted.');
      load();
    } catch (err) {
      setError(err.message);
    }
  }

  async function reveal(d) {
    try {
      const data = await api.post(`/${apiPath}/${d.id}/reveal-password`);
      setRevealed((prev) => ({ ...prev, [d.id]: data.password }));
    } catch (err) {
      setError(err.message);
    }
  }

  async function checkSnmp(d) {
    setSnmpLoading(d.id);
    setSnmpResult(null);
    try {
      const data = await api.get(`/${apiPath}/${d.id}/snmp-stats`);
      setSnmpResult({ id: d.id, ...data });
    } catch (err) {
      setSnmpResult({ id: d.id, connected: false, error: err.message });
    } finally {
      setSnmpLoading(null);
    }
  }

  const [syncing, setSyncing] = useState(null);
  const [syncLog, setSyncLog] = useState(null); // router row whose last sync details are shown
  async function sync(d) {
    setSyncing(d.id);
    setError(null);
    try {
      const data = await api.post(`/${apiPath}/${d.id}/sync`);
      const problems = Object.entries(data.errors || {}).map(([k, v]) => `${k === 'accessPoints' ? 'access points' : k}: ${v}`);
      if (problems.length) setError(`Partial sync — ${problems.join(' | ')}`);
      else flash(`Synced: ${data.switches} switches, ${data.accessPoints} access points.`);
      load();
    } catch (err) {
      setError(err.message);
    } finally {
      setSyncing(null);
    }
  }

  return (
    <div className="page">
      <h1>{title}</h1>
      <p className="muted">{devices.length} device{devices.length === 1 ? '' : 's'} — ping required, SNMP optional</p>
      {message && <p className="success">{message}</p>}
      {error && <p className="error">{error}</p>}

      {!form && canEdit && (
        <div className="filters">
          <button onClick={openCreate}>+ New {title.slice(0, -1)}</button>
          {canDelete && <button onClick={() => setShowHealthTh(!showHealthTh)}>Health thresholds</button>}
        </div>
      )}

      {form && (
        <section className="card">
          <h2>{form.id ? 'Edit' : 'New'} {title.slice(0, -1)}</h2>
          <form onSubmit={save} autoComplete="off">
            <div className="form-row">
              <label>
                Name
                <input value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} required />
              </label>
              <label>
                IP address
                <input value={form.ip_address} onChange={(e) => setForm({ ...form, ip_address: e.target.value })} placeholder="192.168.1.1" required />
              </label>
              <label>
                Brand
                <select value={form.brand} onChange={(e) => setForm({ ...form, brand: e.target.value })}>
                  {brands.map((b) => (
                    <option key={b} value={b}>{b}</option>
                  ))}
                </select>
              </label>
              <label>
                Model
                <input value={form.model} onChange={(e) => setForm({ ...form, model: e.target.value })} />
              </label>
            </div>

            <div className="form-row">
              <label>
                Management username
                <input value={form.username} onChange={(e) => setForm({ ...form, username: e.target.value })} autoComplete="off" name="device_user_field" />
              </label>
              <label>
                Management password
                <input
                  type="password"
                  value={form.device_password}
                  onChange={(e) => setForm({ ...form, device_password: e.target.value })}
                  placeholder={form.id ? 'unchanged' : ''}
                  autoComplete="new-password"
                  name="device_pass_field"
                />
              </label>
            </div>

            <label>
              Notes
              <textarea value={form.notes} onChange={(e) => setForm({ ...form, notes: e.target.value })} rows={2} />
            </label>

            {apiPath === 'routers' && form.brand === 'fortigate' && (
              <label>
                FortiGate API token
                <input
                  type="password"
                  value={form.api_token}
                  onChange={(e) => setForm({ ...form, api_token: e.target.value })}
                  placeholder={form.id ? 'unchanged' : 'generated in FortiGate: System > Administrators > REST API Admin'}
                  autoComplete="new-password"
                  name="fortigate_token_field"
                />
              </label>
            )}

            <button type="button" className="btn-link" onClick={() => setShowSnmp(!showSnmp)}>
              {showSnmp ? '− Hide SNMP settings (optional)' : '+ SNMP settings (optional)'}
            </button>

            {showSnmp && (
              <div className="snmp-fields">
                <div className="form-row">
                  <label>
                    SNMP version
                    <select value={form.snmp_version} onChange={(e) => setForm({ ...form, snmp_version: e.target.value })}>
                      <option value="1">v1</option>
                      <option value="2c">v2c</option>
                      <option value="3">v3</option>
                    </select>
                  </label>
                  <label>
                    Port
                    <input type="number" value={form.snmp_port} onChange={(e) => setForm({ ...form, snmp_port: e.target.value })} />
                  </label>
                  {form.snmp_version !== '3' && (
                    <label>
                      Community string
                      <input value={form.snmp_community} onChange={(e) => setForm({ ...form, snmp_community: e.target.value })} autoComplete="off" name="snmp_community_field" />
                    </label>
                  )}
                </div>
                {form.snmp_version === '3' && (
                  <div className="form-row">
                    <label>
                      Security level
                      <select value={form.snmp_security_level} onChange={(e) => setForm({ ...form, snmp_security_level: e.target.value })}>
                        <option value="noAuthNoPriv">noAuthNoPriv</option>
                        <option value="authNoPriv">authNoPriv</option>
                        <option value="authPriv">authPriv</option>
                      </select>
                    </label>
                    <label>
                      Username
                      <input value={form.snmp_username} onChange={(e) => setForm({ ...form, snmp_username: e.target.value })} autoComplete="off" name="snmp_user_field" />
                    </label>
                    <label>
                      Auth password
                      <input type="password" value={form.snmp_auth_password} onChange={(e) => setForm({ ...form, snmp_auth_password: e.target.value })} placeholder={form.id ? 'unchanged' : ''} autoComplete="new-password" name="snmp_authpass_field" />
                    </label>
                    <label>
                      Priv password
                      <input type="password" value={form.snmp_priv_password} onChange={(e) => setForm({ ...form, snmp_priv_password: e.target.value })} placeholder={form.id ? 'unchanged' : ''} autoComplete="new-password" name="snmp_privpass_field" />
                    </label>
                  </div>
                )}
              </div>
            )}

            <div className="form-row">
              <button type="submit">Save</button>
              <button type="button" onClick={() => setForm(null)}>Cancel</button>
            </div>
          </form>
        </section>
      )}

      {syncLog && (
        <section className="card">
          <h2>FortiGate sync — {syncLog.name}</h2>
          <p className="muted">
            Last sync: {formatDbDate(syncLog.last_sync_at)} — {syncLog.last_sync_status}. Switch/AP status is whatever the FortiGate
            reports (Connected / Disconnected); below is the first raw entry it returned per list, in case a field is being read wrong.
          </p>
          <pre className="mono" style={{ whiteSpace: 'pre-wrap', maxHeight: 320, overflow: 'auto' }}>{syncLog.last_sync_debug || '(no details stored yet — run a sync)'}</pre>
        </section>
      )}

      <table className="table">
        <thead>
          <tr>
            <th>Name</th>
            <th>Brand</th>
            <th>IP</th>
            <th>Ping</th>
            <th>Latency</th>
            <th>Credentials</th>
            <th></th>
          </tr>
        </thead>
        <tbody>
          {devices.map((d) => (
            <tr key={d.id}>
              <td>
                {d.name}
                <MaintenanceBadge w={d.in_maintenance} />
                <HealthBadges device={d} />
                {d.discovered_from_router_id && (
                  <>
                    {' '}
                    <span className="status-badge" title={d.discovered_missing_at ? `Not seen since ${d.discovered_missing_at}` : `Discovered via router #${d.discovered_from_router_id}`}>
                      {d.discovered_missing_at ? 'offline (auto)' : 'auto-discovered'}
                    </span>
                  </>
                )}
              </td>
              <td className="muted">{d.brand}</td>
              <td className="mono">{d.ip_address === '0.0.0.0' ? '—' : d.ip_address}</td>
              <td><span className={`status-badge status-${d.last_status}`} title={d.status_source === 'fortigate' ? 'Reported by the FortiGate' : undefined}>{d.last_status}</span></td>
              <td>{d.last_latency_ms != null ? `${d.last_latency_ms}ms` : '—'}</td>
              <td>
                {d.username || '—'}
                {d.device_password && (
                  <>
                    {' · '}
                    {revealed[d.id] ? <code>{revealed[d.id]}</code> : <button className="btn-link" onClick={() => reveal(d)}>show</button>}
                  </>
                )}
              </td>
              <td className="actions">
                <button className="btn-link" onClick={() => checkSnmp(d)} disabled={snmpLoading === d.id}>
                  {snmpLoading === d.id ? 'Checking SNMP...' : 'SNMP check'}
                </button>
                {apiPath === 'routers' && d.brand === 'fortigate' && canEdit && (
                  <button className="btn-link" onClick={() => sync(d)} disabled={syncing === d.id} title={d.last_sync_status || 'Never synced'}>
                    {syncing === d.id ? 'Syncing...' : 'Sync switches/APs'}
                  </button>
                )}
                {apiPath === 'routers' && d.brand === 'fortigate' && d.last_sync_at && (
                  <button className="btn-link" onClick={() => setSyncLog(syncLog?.id === d.id ? null : d)}>Sync log</button>
                )}
                <button className="btn-link" onClick={() => setHealthFor(healthFor === d.id ? null : d.id)}>Health</button>
                {canEdit && <MaintenanceLink type="device" table={apiPath === 'access-points' ? 'access_points' : apiPath} id={d.id} />}
                {canEdit && <button className="btn-link" onClick={() => openEdit(d)}>Edit</button>}
                {canDelete && <button className="btn-link danger" onClick={() => remove(d)}>Delete</button>}
              </td>
            </tr>
          ))}
        </tbody>
      </table>

      {showHealthTh && canDelete && <DeviceHealthThresholds onClose={() => setShowHealthTh(false)} />}
      {healthFor && devices.find((d) => d.id === healthFor) && (
        <DeviceHealthPanel apiPath={apiPath} device={devices.find((d) => d.id === healthFor)} canAdmin={canDelete} canOperate={canEdit} onClose={() => setHealthFor(null)} onChanged={load} />
      )}

      {snmpResult && (
        <section className="card">
          <h2>SNMP result — {devices.find((d) => d.id === snmpResult.id)?.name}</h2>
          {snmpResult.connected ? (
            <>
              <p className="success">Connected</p>
              <p className="muted">Hostname: {snmpResult.hostname || '—'} · Uptime: {snmpResult.uptime || '—'}</p>
              {snmpResult.interfaces?.length > 0 && (
                <table className="table">
                  <thead>
                    <tr><th>Interface</th><th>Link</th><th>Speed</th><th>RX</th><th>TX</th></tr>
                  </thead>
                  <tbody>
                    {snmpResult.interfaces.map((i) => (
                      <tr key={i.name}>
                        <td>{i.name}</td>
                        <td><span className={`status-badge ${i.link ? 'status-up' : 'status-down'}`}>{i.link ? 'up' : 'down'}</span></td>
                        <td>{i.speed ? `${Math.round(i.speed / 1000)} Mbps` : '—'}</td>
                        <td>{(i.rx_bytes / 1e9).toFixed(2)} GB</td>
                        <td>{(i.tx_bytes / 1e9).toFixed(2)} GB</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              )}
            </>
          ) : (
            <p className="error">{snmpResult.error}</p>
          )}
        </section>
      )}
    </div>
  );
}
