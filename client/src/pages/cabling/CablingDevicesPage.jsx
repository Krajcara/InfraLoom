import { useCallback, useEffect, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { api } from '../../api';
import CablingSearch from '../../components/cabling/CablingSearch';
import { LiveBadge, errText, labelOf, useCablingRights, useCatalog } from '../../components/cabling/common';

const KIND_LABEL = { router: 'Router', switch: 'Switch', access_point: 'Access point', hypervisor: 'Hypervisor', ups: 'UPS' };

export default function CablingDevicesPage() {
  const rights = useCablingRights();
  const catalog = useCatalog();
  const navigate = useNavigate();
  const [devices, setDevices] = useState(null);
  const [rooms, setRooms] = useState([]);
  const [filter, setFilter] = useState({ q: '', room_id: '', type: '', purpose: '' });
  const [linkable, setLinkable] = useState(null);
  const [templates, setTemplates] = useState([]);
  const [adoptTpl, setAdoptTpl] = useState('');
  const [adoptRoom, setAdoptRoom] = useState('');
  const [error, setError] = useState(null);

  const load = useCallback(() => {
    const qs = new URLSearchParams(Object.entries(filter).filter(([, v]) => v)).toString();
    api.get(`/cabling/devices${qs ? `?${qs}` : ''}`).then((d) => setDevices(d.devices)).catch((e) => setError(errText(e)));
  }, [filter]);
  useEffect(() => { const t = setTimeout(load, filter.q ? 250 : 0); return () => clearTimeout(t); }, [load, filter.q]);
  useEffect(() => { api.get('/cabling/rooms').then((d) => setRooms(d.rooms)).catch(() => {}); }, []);

  async function openLinkable() {
    try {
      setLinkable((await api.get('/cabling/linkable')).items.filter((i) => !i.linked));
      setTemplates((await api.get('/cabling/templates')).templates);
    } catch (e) { setError(errText(e)); }
  }
  async function adopt(item) {
    try { const r = await api.post('/cabling/devices/from-linked', { kind: item.kind, id: item.id, template_id: adoptTpl ? Number(adoptTpl) : undefined, room_id: adoptRoom ? Number(adoptRoom) : undefined }); navigate(`/cabling/devices/${r.device.id}/edit`); } catch (e) { setError(errText(e)); }
  }
  const set = (k, v) => setFilter((f) => ({ ...f, [k]: v }));

  return (
    <div className="page cab-page">
      <div className="cab-head">
        <h1>Devices</h1>
        <div className="cab-head-tools">
          <CablingSearch />
          {rights.canEdit && <Link className="cab-btn" to="/cabling/devices/new">New device</Link>}
        </div>
      </div>
      {error && <p className="error">{error}</p>}

      <div className="card cab-wide">
        <div className="form-row">
          <label>Filter<input value={filter.q} onChange={(e) => set('q', e.target.value)} placeholder="Name, IP, serial, model" /></label>
          <label>Room
            <select value={filter.room_id} onChange={(e) => set('room_id', e.target.value)}><option value="">All</option>{rooms.map((r) => <option key={r.id} value={r.id}>{r.name}</option>)}</select>
          </label>
          <label>Type
            <select value={filter.type} onChange={(e) => set('type', e.target.value)}><option value="">All</option>{(catalog?.device_types || []).map((t) => <option key={t.value} value={t.value}>{t.label}</option>)}</select>
          </label>
          <label>Purpose
            <select value={filter.purpose} onChange={(e) => set('purpose', e.target.value)}><option value="">All</option>{(catalog?.purposes || []).map((t) => <option key={t.value} value={t.value}>{t.label}</option>)}</select>
          </label>
          {rights.canEdit && <button type="button" className="cab-btn-ghost" onClick={() => (linkable ? setLinkable(null) : openLinkable())}>Add from monitored devices</button>}
        </div>
      </div>

      {linkable && (
        <div className="card cab-wide">
          <h2>Monitored by InfraLoom, not documented yet</h2>
          <div className="form-row">
            <label>Template for the new device (creates its ports)
              <select value={adoptTpl} onChange={(e) => setAdoptTpl(e.target.value)} aria-label="Template for new devices"><option value="">— none, I will add ports later —</option>{templates.map((t) => <option key={t.id} value={t.id}>{t.name} ({t.port_count} ports)</option>)}</select>
            </label>
            <label>Room
              <select value={adoptRoom} onChange={(e) => setAdoptRoom(e.target.value)} aria-label="Room for new devices"><option value="">— choose later —</option>{rooms.map((r) => <option key={r.id} value={r.id}>{r.name}</option>)}</select>
            </label>
          </div>
          {linkable.length === 0 ? <p className="muted">Everything InfraLoom monitors already has a device here.</p> : (
            <table className="table">
              <thead><tr><th>Name</th><th>Kind</th><th>Address</th><th /></tr></thead>
              <tbody>{linkable.map((i) => (
                <tr key={`${i.kind}${i.id}`}>
                  <td className="mono"><strong>{i.name}</strong>{i.managed && <span className="cab-tag" style={{ marginLeft: 6 }}>FortiGate-managed</span>}</td>
                  <td>{KIND_LABEL[i.kind]}</td><td className="mono">{i.address && i.address !== '0.0.0.0' ? i.address : '—'}</td>
                  <td className="actions"><button type="button" className="btn-link" onClick={() => adopt(i)}>Add to inventory</button></td>
                </tr>
              ))}</tbody>
            </table>
          )}
        </div>
      )}

      {!devices ? <p className="muted">Loading...</p> : devices.length === 0 ? <div className="card"><p className="muted">No devices match.</p></div> : (
        <div className="card cab-wide">
          <table className="table">
            <thead><tr><th>Name</th><th>Type</th><th>Purpose</th><th>Location</th><th>IP</th><th>Ports</th><th>Live</th><th /></tr></thead>
            <tbody>
              {devices.map((d) => (
                <tr key={d.id}>
                  <td className="mono"><strong>{d.room_id ? <Link to={`/cabling/rooms/${d.room_id}?device=${d.id}`}>{d.name}</Link> : d.name}</strong></td>
                  <td>{labelOf(catalog?.device_types, d.device_type)}</td>
                  <td>{d.purpose === 'production' ? labelOf(catalog?.purposes, d.purpose) : <span className="cab-tag cab-tag--purpose">{labelOf(catalog?.purposes, d.purpose)}</span>}</td>
                  <td>{d.room_name ? `${d.room_name}${d.rack_name ? ` · ${d.rack_name}${d.rack_position ? ` U${d.rack_position}` : ''}` : ''}` : d.office_name ? `${d.office_name} (office)` : <span className="muted">no place</span>}</td>
                  <td className="mono">{d.ip_address || '—'}</td><td className="mono">{d.port_count}</td>
                  <td><LiveBadge live={d.live} /></td>
                  <td className="actions">{rights.canEdit && <Link className="btn-link" to={`/cabling/devices/${d.id}/edit`}>Edit</Link>}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
