import { Fragment, useEffect, useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { api } from '../../api';
import { downloadCsv } from '../../components/cabling/csv';
import { errText, labelOf, useCatalog } from '../../components/cabling/common';

const TYPE_FILTERS = [
  ['switch,router,firewall', 'Switches, routers and firewalls'], ['switch', 'Switches'], ['router', 'Routers'], ['firewall', 'Firewalls'], ['hypervisor,server,nas', 'Hypervisors, servers and NAS'],
];
const place = (d) => [d.room_name, d.rack_name ? `${d.rack_name}${d.rack_position ? ` U${d.rack_position}` : ''}` : null].filter(Boolean).join(' · ') || '—';

function PortsReport({ rooms, room }) {
  const catalog = useCatalog();
  const [types, setTypes] = useState(TYPE_FILTERS[0][0]);
  const [data, setData] = useState(null);
  const [open, setOpen] = useState({});
  const [error, setError] = useState(null);
  useEffect(() => {
    setData(null);
    api.get(`/cabling/reports/ports?type=${types}${room ? `&room_id=${room}` : ''}`).then(setData).catch((e) => setError(errText(e)));
  }, [types, room]);
  if (error) return <p className="error">{error}</p>;
  if (!data) return <p className="muted">Loading...</p>;
  const csv = () => {
    const rows = [['Device', 'Type', 'Room', 'Rack', 'Unit', 'Port', 'Port type', 'Speed', 'State', 'Leads to']];
    for (const d of data.devices) {
      for (const p of d.used_ports) rows.push([d.name, labelOf(catalog?.device_types, d.device_type), d.room_name, d.rack_name, d.rack_position, p.port, labelOf(catalog?.port_types, p.port_type), p.speed, 'in use', p.leads_to]);
      for (const p of d.free_ports) rows.push([d.name, labelOf(catalog?.device_types, d.device_type), d.room_name, d.rack_name, d.rack_position, p.port, labelOf(catalog?.port_types, p.port_type), p.speed, 'free', '']);
    }
    downloadCsv('ports-in-use.csv', rows);
  };
  return (
    <>
      <div className="form-row">
        <label>Show
          <select value={types} onChange={(e) => setTypes(e.target.value)} aria-label="Device kind">{TYPE_FILTERS.map(([v, l]) => <option key={v} value={v}>{l}</option>)}</select>
        </label>
        <span className="muted mono cab-report-sum">{data.totals.devices} devices · {data.totals.ports} ports · {data.totals.used} in use · {data.totals.free} free</span>
        <button type="button" className="cab-btn-ghost" onClick={csv} disabled={!data.devices.length}>Download CSV</button>
      </div>
      {data.devices.length === 0 ? <div className="card"><p className="muted">No such devices{room ? ' in this room' : ''}.</p></div> : (
        <div className="card cab-wide">
          <table className="table">
            <thead><tr><th>Device</th><th>Type</th><th>Place</th><th>Ports</th><th>In use</th><th>Free</th><th>Usage</th><th /></tr></thead>
            <tbody>
              {data.devices.map((d) => {
                const pct = d.total ? Math.round((100 * d.used) / d.total) : 0;
                return (
                  <Fragment key={d.device_id}>
                    <tr>
                      <td className="mono"><strong>{d.room_id ? <Link to={`/cabling/rooms/${d.room_id}?device=${d.device_id}`}>{d.name}</Link> : d.name}</strong></td>
                      <td>{labelOf(catalog?.device_types, d.device_type)}</td><td>{place(d)}</td>
                      <td className="mono">{d.total}</td><td className="mono">{d.used}</td><td className="mono"><strong>{d.free}</strong></td>
                      <td><div className="cab-usage" title={`${pct}% in use`}><i style={{ width: `${pct}%` }} /></div></td>
                      <td className="actions"><button type="button" className="btn-link" onClick={() => setOpen((o) => ({ ...o, [d.device_id]: !o[d.device_id] }))}>{open[d.device_id] ? 'Hide ports' : 'Show ports'}</button></td>
                    </tr>
                    {open[d.device_id] && (
                      <tr>
                        <td colSpan={8}>
                          <div className="cab-ports-detail">
                            <div>
                              <h3 className="cab-h3">Free ({d.free})</h3>
                              <div className="cab-chips">{d.free_ports.length ? d.free_ports.map((p) => <span key={p.port} className="cab-chip mono">{p.port}</span>) : <span className="muted">none</span>}</div>
                            </div>
                            <div>
                              <h3 className="cab-h3">In use ({d.used})</h3>
                              {d.used_ports.length ? (
                                <table className="table"><tbody>
                                  {d.used_ports.map((p) => <tr key={p.port}><td className="mono"><i className={`cab-dot cab-dot--${p.status}`} /> {p.port}</td><td className="muted mono">→ {p.leads_to}</td></tr>)}
                                </tbody></table>
                              ) : <span className="muted">none</span>}
                              {d.console_ports > 0 && <p className="muted">{d.console_ports} console port{d.console_ports === 1 ? '' : 's'} not counted.</p>}
                            </div>
                          </div>
                        </td>
                      </tr>
                    )}
                  </Fragment>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </>
  );
}

function GapsReport({ checks }) {
  const catalog = useCatalog();
  if (!checks) return <p className="muted">Loading...</p>;
  const csv = () => downloadCsv('patch-panel-gaps.csv', [['Room', 'Rack', 'Patch panel', 'Port', 'Office', 'Outlet label', 'Missing', 'Patched to'],
    ...checks.gaps.map((g) => [g.room_name, g.rack_name, g.device_name, g.port_name, g.office_name, g.outlet_label, g.missing.join(' and '), g.front ? `${g.front.device_name} ${g.front.port_name}` : 'not patched'])]);
  void catalog;
  return (
    <>
      <div className="form-row">
        <span className="muted">Patch-panel ports that are patched but miss their office or outlet label, or have only one of the two.</span>
        <button type="button" className="cab-btn-ghost" onClick={csv} disabled={!checks.gaps.length}>Download CSV</button>
      </div>
      {checks.gaps.length === 0 ? (
        <div className="card"><p className="success">Nothing missing: every patched patch-panel port has an office and an outlet label.</p></div>
      ) : (
        <div className="card cab-wide">
          <table className="table">
            <thead><tr><th>Patch panel</th><th>Port</th><th>Office</th><th>Outlet label</th><th>Missing</th><th>Patched to</th><th /></tr></thead>
            <tbody>
              {checks.gaps.map((g) => (
                <tr key={g.port_id}>
                  <td className="mono"><strong>{g.device_name}</strong> <span className="muted">{[g.room_name, g.rack_name].filter(Boolean).join(' · ')}</span></td>
                  <td className="mono">{g.port_name}</td>
                  <td>{g.office_name || <span className="muted">—</span>}</td><td className="mono">{g.outlet_label || <span className="muted">—</span>}</td>
                  <td>{g.missing.map((m) => <span key={m} className="cab-tag cab-tag--gap">{m}</span>)}</td>
                  <td className="mono">{g.front ? `${g.front.device_name} · ${g.front.port_name}` : <span className="muted">not patched</span>}</td>
                  <td className="actions">{g.room_id && <Link className="btn-link" to={`/cabling/rooms/${g.room_id}?port=${g.port_id}`}>Open</Link>}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </>
  );
}

function OtherChecks({ checks }) {
  const catalog = useCatalog();
  if (!checks) return <p className="muted">Loading...</p>;
  const nothing = !checks.no_place.length && !checks.no_position.length;
  return (
    <>
      {nothing && <div className="card"><p className="success">Nothing to check: every device has a place, and every device in a rack has a unit.</p></div>}
      {checks.no_place.length > 0 && (
        <div className="card cab-wide">
          <h2>Devices with no place ({checks.no_place.length})</h2>
          <p className="muted">Not in any room or office, so they appear on no room view.</p>
          <table className="table"><tbody>{checks.no_place.map((d) => <tr key={d.id}><td className="mono"><strong>{d.name}</strong></td><td>{labelOf(catalog?.device_types, d.device_type)}</td><td className="actions"><Link className="btn-link" to={`/cabling/devices/${d.id}/edit`}>Edit</Link></td></tr>)}</tbody></table>
        </div>
      )}
      {checks.no_position.length > 0 && (
        <div className="card cab-wide">
          <h2>In a rack, but without a unit ({checks.no_position.length})</h2>
          <p className="muted">They are listed under the rack in the ports view, but not drawn in the rack view.</p>
          <table className="table"><tbody>{checks.no_position.map((d) => <tr key={d.id}><td className="mono"><strong>{d.name}</strong></td><td>{labelOf(catalog?.device_types, d.device_type)}</td><td className="muted">{d.room_name} · {d.rack_name}</td><td className="actions"><Link className="btn-link" to={`/cabling/devices/${d.id}/edit`}>Edit</Link></td></tr>)}</tbody></table>
        </div>
      )}
    </>
  );
}

export default function CablingReportsPage() {
  const [params, setParams] = useSearchParams();
  const tab = ['ports', 'gaps', 'other'].includes(params.get('tab')) ? params.get('tab') : 'ports';
  const room = params.get('room') || '';
  const [rooms, setRooms] = useState([]);
  const [checks, setChecks] = useState(null);
  const [error, setError] = useState(null);

  useEffect(() => { api.get('/cabling/rooms').then((d) => setRooms(d.rooms)).catch(() => {}); }, []);
  useEffect(() => {
    setChecks(null);
    api.get(`/cabling/reports/checks${room ? `?room_id=${room}` : ''}`).then(setChecks).catch((e) => setError(errText(e)));
  }, [room]);
  const set = (k, v) => { const p = new URLSearchParams(params); if (v) p.set(k, v); else p.delete(k); setParams(p, { replace: true }); };
  const count = (n) => (checks && n > 0 ? ` (${n})` : '');

  return (
    <div className="page cab-page">
      <div className="cab-head">
        <h1>Reports</h1>
        <div className="cab-head-tools">
          <label className="cab-inline">Room
            <select value={room} onChange={(e) => set('room', e.target.value)} aria-label="Room filter"><option value="">All rooms</option>{rooms.map((r) => <option key={r.id} value={r.id}>{r.name}</option>)}</select>
          </label>
        </div>
      </div>
      <p className="muted">What is in use and what is free, and what looks unfinished. Everything here is read from what you have entered.</p>
      {error && <p className="error">{error}</p>}
      <div className="cab-seg cab-tabs" role="tablist">
        <button type="button" role="tab" className={tab === 'ports' ? 'on' : ''} onClick={() => set('tab', '')}>Ports in use</button>
        <button type="button" role="tab" className={tab === 'gaps' ? 'on' : ''} onClick={() => set('tab', 'gaps')}>Patch panel gaps{count(checks?.counts.gaps)}</button>
        <button type="button" role="tab" className={tab === 'other' ? 'on' : ''} onClick={() => set('tab', 'other')}>Other checks{count((checks?.counts.no_place || 0) + (checks?.counts.no_position || 0))}</button>
      </div>
      {tab === 'ports' && <PortsReport rooms={rooms} room={room} />}
      {tab === 'gaps' && <GapsReport checks={checks} />}
      {tab === 'other' && <OtherChecks checks={checks} />}
    </div>
  );
}
