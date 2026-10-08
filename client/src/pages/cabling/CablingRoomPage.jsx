import { useCallback, useEffect, useState } from 'react';
import { Link, useNavigate, useParams, useSearchParams } from 'react-router-dom';
import { api } from '../../api';
import PortStrip from '../../components/cabling/PortStrip';
import CablingSearch from '../../components/cabling/CablingSearch';
import { LiveBadge, errText, labelOf, portSummary, useCablingRights, useCatalog } from '../../components/cabling/common';

function Kpi({ label, value }) {
  return <div className="cab-kpi"><div className="muted">{label}</div><div className="cab-kpi-value mono">{value}</div></div>;
}

function PortPanel({ port, device, offices, catalog, rights, onSaved, onDeleted }) {
  const [edit, setEdit] = useState(false);
  const [form, setForm] = useState(null);
  const [error, setError] = useState(null);
  useEffect(() => { setEdit(false); setError(null); }, [port?.id]);

  if (!port) return <aside className="cab-panel card"><h2>Port details</h2><p className="muted">Select a port in a device to see its details.</p></aside>;

  const begin = () => { setForm({ name: port.name, port_type: port.port_type, speed: port.speed || '', poe: port.poe, role: port.role || '', transceiver: port.transceiver || '', connector: port.connector || '', office_id: port.office_id || '', outlet_label: port.outlet_label || '', notes: port.notes || '' }); setEdit(true); };
  const set = (k, v) => setForm((f) => ({ ...f, [k]: v }));
  async function save(e) {
    e.preventDefault(); setError(null);
    try { await api.put(`/cabling/ports/${port.id}`, { ...form, office_id: form.office_id || null }); setEdit(false); onSaved(port.id); } catch (err) { setError(errText(err)); }
  }
  async function remove() {
    if (!confirm(`Delete port ${port.name} from ${device.name}?`)) return;
    try { await api.del(`/cabling/ports/${port.id}`); onDeleted(); } catch (err) { setError(errText(err)); }
  }

  return (
    <aside className="cab-panel card">
      <div className="muted">Selected port</div>
      <h2 className="mono">{device.name} · {port.name}</h2>
      <p>
        <span className={`cab-dot cab-dot--${port.status}`} />{' '}
        {port.status === 'outlet' ? `Wall outlet ${port.outlet_label || ''}${port.office_name ? ` · ${port.office_name}` : ''}`.trim() : 'Free'}
      </p>
      {error && <p className="error">{error}</p>}
      {!edit ? (
        <>
          <dl className="cab-dl">
            <dt>Port type</dt><dd className="mono">{labelOf(catalog?.port_types, port.port_type)}</dd>
            <dt>Speed</dt><dd className="mono">{port.speed || '—'}</dd>
            <dt>PoE</dt><dd className="mono">{port.poe ? 'Yes' : 'No'}</dd>
            <dt>Role</dt><dd className="mono">{port.role ? labelOf(catalog?.port_roles, port.role) : '—'}</dd>
            {port.transceiver && (<><dt>Transceiver</dt><dd className="mono">{port.transceiver}</dd></>)}
            {port.connector && (<><dt>Connector</dt><dd className="mono">{port.connector}</dd></>)}
            {port.notes && (<><dt>Notes</dt><dd>{port.notes}</dd></>)}
          </dl>
          <div className="form-row">
            {rights.canEdit && <button type="button" onClick={begin}>Edit port</button>}
            {rights.canDelete && <button type="button" className="btn-link danger" onClick={remove}>Delete port</button>}
          </div>
        </>
      ) : (
        <form onSubmit={save} className="cab-portform" autoComplete="off">
          <label>Name<input value={form.name} onChange={(e) => set('name', e.target.value)} required /></label>
          <div className="form-row">
            <label>Type
              <select value={form.port_type} onChange={(e) => set('port_type', e.target.value)}>{(catalog?.port_types || []).map((t) => <option key={t.value} value={t.value}>{t.label}</option>)}</select>
            </label>
            <label>Speed
              <select value={form.speed} onChange={(e) => set('speed', e.target.value)}><option value="">—</option>{(catalog?.speeds || []).map((s) => <option key={s} value={s}>{s}</option>)}</select>
            </label>
          </div>
          <div className="form-row">
            <label>Role
              <select value={form.role} onChange={(e) => set('role', e.target.value)}><option value="">—</option>{(catalog?.port_roles || []).map((r) => <option key={r.value} value={r.value}>{r.label}</option>)}</select>
            </label>
            <label>Connector
              <select value={form.connector} onChange={(e) => set('connector', e.target.value)}><option value="">—</option>{(catalog?.connectors || []).map((c) => <option key={c} value={c}>{c}</option>)}</select>
            </label>
          </div>
          <label className="checkbox-row"><input type="checkbox" checked={form.poe} onChange={(e) => set('poe', e.target.checked)} /><span>PoE</span></label>
          <label>Transceiver<input value={form.transceiver} onChange={(e) => set('transceiver', e.target.value)} placeholder="e.g. SFP+ 10G LR" /></label>
          <div className="form-row">
            <label>Office (wall outlet)
              <select value={form.office_id} onChange={(e) => set('office_id', e.target.value)}><option value="">—</option>{offices.map((o) => <option key={o.id} value={o.id}>{o.name}</option>)}</select>
            </label>
            <label>Outlet label<input value={form.outlet_label} onChange={(e) => set('outlet_label', e.target.value)} placeholder="K-02/A" /></label>
          </div>
          <label>Notes<input value={form.notes} onChange={(e) => set('notes', e.target.value)} /></label>
          <div className="form-row"><button type="submit">Save</button><button type="button" className="cab-btn-ghost" onClick={() => { setEdit(false); setError(null); }}>Cancel</button></div>
        </form>
      )}
    </aside>
  );
}

function DeviceCard({ device, catalog, selectedId, onSelect, rights, onDelete, highlight }) {
  const panel = (catalog?.panel_types || []).includes(device.device_type);
  return (
    <div id={`cab-dev-${device.id}`} className={`card cab-device${highlight ? ' cab-device--hl' : ''}`}>
      <div className="cab-device-head">
        <div>
          <strong className="mono cab-device-name">{device.name}</strong>{' '}
          <span className="cab-tag">{labelOf(catalog?.device_types, device.device_type)}</span>{' '}
          <span className="muted">{[device.model, device.rack_position ? `U${device.rack_position}` : null].filter(Boolean).join(' · ')}</span>
        </div>
        <div className="cab-device-meta mono muted">
          {[device.ip_address, portSummary(device.ports, catalog)].filter(Boolean).join(' · ')}
        </div>
      </div>
      <div className="cab-device-sub">
        <LiveBadge live={device.live} />
        {device.purpose !== 'production' && <span className="cab-tag cab-tag--purpose">{labelOf(catalog?.purposes, device.purpose)}</span>}
        <span className="cab-device-actions">
          {rights.canEdit && <Link className="btn-link" to={`/cabling/devices/${device.id}/edit`}>Edit / add ports</Link>}
          {rights.canDelete && <button type="button" className="btn-link danger" onClick={() => onDelete(device)}>Delete</button>}
        </span>
      </div>
      <PortStrip ports={device.ports} panel={panel} selectedId={selectedId} onSelect={(p) => onSelect(device, p)} />
    </div>
  );
}

function RackForm({ initial, onSave, onCancel, label }) {
  const [name, setName] = useState(initial?.name || '');
  const [height, setHeight] = useState(initial?.height_u || 42);
  const [error, setError] = useState(null);
  async function submit(e) { e.preventDefault(); setError(null); try { await onSave({ name, height_u: Number(height) }); } catch (err) { setError(errText(err)); } }
  return (
    <form onSubmit={submit} className="form-row cab-inline-form" autoComplete="off">
      <label>Rack name<input value={name} onChange={(e) => setName(e.target.value)} required placeholder="R1" /></label>
      <label>Height (U)<input type="number" min="1" max="60" value={height} onChange={(e) => setHeight(e.target.value)} className="cab-in-num" /></label>
      <button type="submit">{label}</button>
      <button type="button" className="cab-btn-ghost" onClick={onCancel}>Cancel</button>
      {error && <span className="error">{error}</span>}
    </form>
  );
}

export default function CablingRoomPage() {
  const { id } = useParams();
  const navigate = useNavigate();
  const [params, setParams] = useSearchParams();
  const catalog = useCatalog();
  const rights = useCablingRights();
  const [data, setData] = useState(null);
  const [offices, setOffices] = useState([]);
  const [selected, setSelected] = useState(null); // { deviceId, portId }
  const [error, setError] = useState(null);
  const [addRack, setAddRack] = useState(false);
  const [editRack, setEditRack] = useState(null);
  const [editRoom, setEditRoom] = useState(null);

  const load = useCallback(() => api.get(`/cabling/rooms/${id}`).then(setData).catch((e) => setError(errText(e))), [id]);
  useEffect(() => { setData(null); setSelected(null); load(); }, [load]);
  useEffect(() => { api.get('/cabling/offices').then((d) => setOffices(d.offices)).catch(() => {}); }, []);

  // arriving from the search box: select the port / scroll to the device
  const wantPort = Number(params.get('port')) || null;
  const wantDevice = Number(params.get('device')) || null;
  useEffect(() => {
    if (!data) return;
    if (wantPort) {
      const dev = data.devices.find((d) => d.ports.some((p) => p.id === wantPort));
      if (dev) setSelected({ deviceId: dev.id, portId: wantPort });
      setTimeout(() => document.getElementById(`cab-dev-${dev?.id}`)?.scrollIntoView({ behavior: 'smooth', block: 'center' }), 50);
    } else if (wantDevice) {
      setTimeout(() => document.getElementById(`cab-dev-${wantDevice}`)?.scrollIntoView({ behavior: 'smooth', block: 'center' }), 50);
    }
  }, [data, wantPort, wantDevice]);

  if (error) return <div className="page"><p className="error">{error}</p><Link to="/cabling">Back to rooms</Link></div>;
  if (!data) return <div className="page-loading">Loading...</div>;

  const { room, racks, devices, summary } = data;
  const selDevice = selected && devices.find((d) => d.id === selected.deviceId);
  const selPort = selDevice && selDevice.ports.find((p) => p.id === selected.portId);
  const choose = (device, port) => { setSelected({ deviceId: device.id, portId: port.id }); if (params.get('port') || params.get('device')) setParams({}, { replace: true }); };

  async function removeDevice(d) {
    if (!confirm(`Delete ${d.name} and its ${d.ports.length} ports?`)) return;
    try { await api.del(`/cabling/devices/${d.id}`); setSelected(null); load(); } catch (e) { setError(errText(e)); }
  }
  async function removeRack(r) {
    if (!confirm(`Delete rack ${r.name}? Its devices stay in the room, without a rack position.`)) return;
    try { await api.del(`/cabling/racks/${r.id}`); load(); } catch (e) { setError(errText(e)); }
  }
  async function removeRoom() {
    if (!confirm(`Delete room ${room.name}? Its devices stay in the inventory without a room.`)) return;
    try { await api.del(`/cabling/rooms/${room.id}`); navigate('/cabling'); } catch (e) { setError(errText(e)); }
  }
  async function saveRoom(e) {
    e.preventDefault();
    try { await api.put(`/cabling/rooms/${room.id}`, editRoom); setEditRoom(null); load(); } catch (err) { setError(errText(err)); }
  }

  const rackDevices = (r) => devices.filter((d) => d.rack_id === r.id);
  const others = devices.filter((d) => !d.rack_id);

  return (
    <div className="page cab-page">
      <div className="cab-crumbs muted"><Link to="/cabling">Cabling</Link> / {room.name}</div>
      <div className="cab-head">
        <h1>{room.name}{room.location ? <span className="cab-sub"> · {room.location}</span> : null}{room.floor ? <span className="cab-sub"> · floor {room.floor}</span> : null}</h1>
        <div className="cab-head-tools">
          <CablingSearch />
          {rights.canEdit && <Link className="cab-btn" to={`/cabling/devices/new?room=${room.id}`}>New device</Link>}
        </div>
      </div>
      {error && <p className="error">{error}</p>}

      <div className="cab-kpis">
        <Kpi label="Devices in room" value={summary.devices} />
        <Kpi label="Racks" value={summary.racks} />
        <Kpi label="Ports" value={summary.ports} />
        <Kpi label="Wall outlets recorded / panel ports" value={`${summary.outlets} / ${summary.panel_ports}`} />
      </div>

      <div className="form-row cab-room-actions">
        {rights.canEdit && <button type="button" className="cab-btn-ghost" onClick={() => setAddRack(!addRack)}>+ Add rack</button>}
        {rights.canEdit && <button type="button" className="cab-btn-ghost" onClick={() => setEditRoom(editRoom ? null : { name: room.name, location: room.location || '', floor: room.floor || '', notes: room.notes || '' })}>Edit room</button>}
        {rights.canDelete && <button type="button" className="btn-link danger" onClick={removeRoom}>Delete room</button>}
      </div>
      {addRack && <div className="card cab-wide"><RackForm label="Add rack" onCancel={() => setAddRack(false)} onSave={async (b) => { await api.post(`/cabling/rooms/${room.id}/racks`, b); setAddRack(false); load(); }} /></div>}
      {editRoom && (
        <form className="card cab-wide" onSubmit={saveRoom} autoComplete="off">
          <div className="form-row">
            <label>Name<input value={editRoom.name} onChange={(e) => setEditRoom({ ...editRoom, name: e.target.value })} required /></label>
            <label>Location<input value={editRoom.location} onChange={(e) => setEditRoom({ ...editRoom, location: e.target.value })} /></label>
            <label>Floor<input value={editRoom.floor} onChange={(e) => setEditRoom({ ...editRoom, floor: e.target.value })} className="cab-in-num" /></label>
            <label className="cab-grow">Notes<input value={editRoom.notes} onChange={(e) => setEditRoom({ ...editRoom, notes: e.target.value })} /></label>
            <button type="submit">Save</button><button type="button" className="cab-btn-ghost" onClick={() => setEditRoom(null)}>Cancel</button>
          </div>
        </form>
      )}

      <div className="cab-layout">
        <div className="cab-main">
          {racks.length === 0 && <p className="muted">This room has no rack yet. {rights.canEdit && 'Add one to place devices in it.'}</p>}
          {racks.map((r) => (
            <section key={r.id} className="cab-rack">
              <div className="cab-rack-head">
                <h2>Rack {r.name} <span className="muted">· {r.height_u} U</span></h2>
                <div className="cab-legend">
                  <span><i className="cab-sw cab-sw--outlet" /> Wall outlet recorded</span>
                  <span><i className="cab-sw cab-sw--free" /> Free</span>
                  {rights.canEdit && <button type="button" className="btn-link" onClick={() => setEditRack(editRack === r.id ? null : r.id)}>Edit</button>}
                  {rights.canDelete && <button type="button" className="btn-link danger" onClick={() => removeRack(r)}>Delete</button>}
                </div>
              </div>
              {editRack === r.id && <div className="card cab-wide"><RackForm initial={r} label="Save rack" onCancel={() => setEditRack(null)} onSave={async (b) => { await api.put(`/cabling/racks/${r.id}`, b); setEditRack(null); load(); }} /></div>}
              {rackDevices(r).length === 0 && <p className="muted">Empty rack.</p>}
              {rackDevices(r).map((d) => (
                <DeviceCard key={d.id} device={d} catalog={catalog} rights={rights} selectedId={selected?.deviceId === d.id ? selected.portId : null} onSelect={choose} onDelete={removeDevice} highlight={wantDevice === d.id} />
              ))}
            </section>
          ))}

          {others.length > 0 && (
            <>
              <h2 className="cab-h2">Other devices in this room</h2>
              <div className="card cab-wide">
                <table className="table">
                  <thead><tr><th>Name</th><th>Type</th><th>Purpose</th><th>IP</th><th>Ports</th><th>Live</th><th /></tr></thead>
                  <tbody>
                    {others.map((d) => (
                      <tr key={d.id} id={`cab-dev-${d.id}`}>
                        <td className="mono"><strong>{d.name}</strong></td>
                        <td>{labelOf(catalog?.device_types, d.device_type)}</td>
                        <td>{d.purpose === 'production' ? labelOf(catalog?.purposes, d.purpose) : <span className="cab-tag cab-tag--purpose">{labelOf(catalog?.purposes, d.purpose)}</span>}</td>
                        <td className="mono">{d.ip_address || '—'}</td>
                        <td>{d.ports.length ? <div className="cab-mini"><PortStrip ports={d.ports} selectedId={selected?.deviceId === d.id ? selected.portId : null} onSelect={(p) => choose(d, p)} /></div> : <span className="muted">no ports</span>}</td>
                        <td><LiveBadge live={d.live} /></td>
                        <td className="actions">
                          {rights.canEdit && <Link className="btn-link" to={`/cabling/devices/${d.id}/edit`}>Edit</Link>}
                          {rights.canDelete && <button type="button" className="btn-link danger" onClick={() => removeDevice(d)}>Delete</button>}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </>
          )}
        </div>
        <PortPanel
          port={selPort} device={selDevice} offices={offices} catalog={catalog} rights={rights}
          onSaved={(portId) => { load(); setSelected((s) => (s ? { ...s, portId } : s)); }}
          onDeleted={() => { setSelected(null); load(); }}
        />
      </div>
    </div>
  );
}
