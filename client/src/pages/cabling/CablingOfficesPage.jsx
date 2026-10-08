import { Fragment, useCallback, useEffect, useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { api } from '../../api';
import { LiveBadge, errText, labelOf, useCablingRights, useCatalog } from '../../components/cabling/common';

function OfficeDetail({ id, catalog }) {
  const [d, setD] = useState(null);
  useEffect(() => { api.get(`/cabling/offices/${id}`).then(setD).catch(() => setD({ devices: [], outlets: [] })); }, [id]);
  if (!d) return <p className="muted">Loading...</p>;
  return (
    <div className="cab-office-detail">
      <h3>Wall outlets ({d.outlets.length})</h3>
      {d.outlets.length === 0 ? <p className="muted">No outlet is assigned to this office yet. Set the office and outlet label on a patch-panel port in the room view.</p> : (
        <table className="table">
          <thead><tr><th>Outlet</th><th>Patch panel</th><th>Port</th><th>Room / rack</th></tr></thead>
          <tbody>
            {d.outlets.map((o) => (
              <tr key={o.port_id}>
                <td className="mono"><strong>{o.outlet_label || '—'}</strong></td>
                <td className="mono">{o.device_name}</td><td className="mono">{o.port_name}</td>
                <td>{o.room_id ? <Link to={`/cabling/rooms/${o.room_id}?port=${o.port_id}`}>{o.room_name}{o.rack_name ? ` · ${o.rack_name}` : ''}</Link> : '—'}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
      <h3>Devices in this office ({d.devices.length})</h3>
      {d.devices.length === 0 ? <p className="muted">None.</p> : (
        <table className="table">
          <thead><tr><th>Name</th><th>Type</th><th>IP</th><th>Live</th></tr></thead>
          <tbody>{d.devices.map((x) => (
            <tr key={x.id}><td className="mono"><Link to={`/cabling/devices/${x.id}/edit`}>{x.name}</Link></td><td>{labelOf(catalog?.device_types, x.device_type)}</td><td className="mono">{x.ip_address || '—'}</td><td><LiveBadge live={x.live} /></td></tr>
          ))}</tbody>
        </table>
      )}
    </div>
  );
}

export default function CablingOfficesPage() {
  const rights = useCablingRights();
  const catalog = useCatalog();
  const [params] = useSearchParams();
  const [offices, setOffices] = useState(null);
  const [open, setOpen] = useState(Number(params.get('open')) || null);
  const [form, setForm] = useState(null); // { id?, name, floor, notes }
  const [error, setError] = useState(null);

  const load = useCallback(() => api.get('/cabling/offices').then((d) => setOffices(d.offices)).catch((e) => setError(errText(e))), []);
  useEffect(() => { load(); }, [load]);

  async function save(e) {
    e.preventDefault(); setError(null);
    try {
      if (form.id) await api.put(`/cabling/offices/${form.id}`, form); else await api.post('/cabling/offices', form);
      setForm(null); load();
    } catch (err) { setError(errText(err)); }
  }
  async function remove(o) {
    if (!confirm(`Delete office ${o.name}? Its devices stay in the inventory, and outlet labels on patch panels are kept.`)) return;
    try { await api.del(`/cabling/offices/${o.id}`); if (open === o.id) setOpen(null); load(); } catch (err) { setError(errText(err)); }
  }

  return (
    <div className="page cab-page">
      <div className="cab-head">
        <h1>Offices</h1>
        <div className="cab-head-tools">{rights.canEdit && <button type="button" onClick={() => setForm(form ? null : { name: '', floor: '', notes: '' })}>New office</button>}</div>
      </div>
      <p className="muted">Offices are where the wall outlets are. A patch-panel port records which office and outlet its rear side runs to.</p>
      {error && <p className="error">{error}</p>}
      {form && (
        <form className="card cab-wide" onSubmit={save} autoComplete="off">
          <h2>{form.id ? 'Edit office' : 'New office'}</h2>
          <div className="form-row">
            <label>Name<input value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} required placeholder="Office 02" /></label>
            <label>Floor<input value={form.floor || ''} onChange={(e) => setForm({ ...form, floor: e.target.value })} className="cab-in-num" /></label>
            <label className="cab-grow">Notes<input value={form.notes || ''} onChange={(e) => setForm({ ...form, notes: e.target.value })} /></label>
            <button type="submit">Save</button><button type="button" className="cab-btn-ghost" onClick={() => setForm(null)}>Cancel</button>
          </div>
        </form>
      )}
      {!offices ? <p className="muted">Loading...</p> : offices.length === 0 ? <div className="card"><p className="muted">No offices yet.</p></div> : (
        <div className="card cab-wide">
          <table className="table">
            <thead><tr><th>Office</th><th>Floor</th><th>Wall outlets</th><th>Devices</th><th /></tr></thead>
            <tbody>
              {offices.map((o) => (
                <Fragment key={o.id}>
                  <tr>
                    <td><button type="button" className="btn-link" onClick={() => setOpen(open === o.id ? null : o.id)}>{open === o.id ? '▾' : '▸'} <strong className="mono">{o.name}</strong></button></td>
                    <td>{o.floor || '—'}</td><td className="mono">{o.outlets}</td><td className="mono">{o.devices}</td>
                    <td className="actions">
                      {rights.canEdit && <button type="button" className="btn-link" onClick={() => setForm({ id: o.id, name: o.name, floor: o.floor || '', notes: o.notes || '' })}>Edit</button>}
                      {rights.canDelete && <button type="button" className="btn-link danger" onClick={() => remove(o)}>Delete</button>}
                    </td>
                  </tr>
                  {open === o.id && <tr><td colSpan={5}><OfficeDetail id={o.id} catalog={catalog} /></td></tr>}
                </Fragment>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
