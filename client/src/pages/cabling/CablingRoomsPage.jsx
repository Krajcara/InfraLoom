import { useCallback, useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { api } from '../../api';
import CablingSearch from '../../components/cabling/CablingSearch';
import { errText, useCablingRights } from '../../components/cabling/common';

export default function CablingRoomsPage() {
  const rights = useCablingRights();
  const [rooms, setRooms] = useState(null);
  const [summary, setSummary] = useState(null);
  const [form, setForm] = useState(null);
  const [error, setError] = useState(null);

  const load = useCallback(() => {
    api.get('/cabling/rooms').then((d) => setRooms(d.rooms)).catch((e) => setError(errText(e)));
    api.get('/cabling/summary').then(setSummary).catch(() => {});
  }, []);
  useEffect(() => { load(); }, [load]);

  async function create(e) {
    e.preventDefault(); setError(null);
    try { await api.post('/cabling/rooms', form); setForm(null); load(); } catch (err) { setError(errText(err)); }
  }

  return (
    <div className="page cab-page">
      <div className="cab-head">
        <h1>Technical rooms</h1>
        <div className="cab-head-tools">
          <CablingSearch />
          {rights.canEdit && <button type="button" onClick={() => setForm(form ? null : { name: '', location: '', floor: '', notes: '' })}>New room</button>}
        </div>
      </div>
      <p className="muted">Network equipment per room: racks, devices, patch panels and the wall outlets they feed. Documentation only — nothing here changes your network.</p>
      {error && <p className="error">{error}</p>}

      {summary && (
        <div className="cab-kpis">
          <div className="cab-kpi"><div className="muted">Rooms / offices</div><div className="cab-kpi-value mono">{summary.rooms} / {summary.offices}</div></div>
          <div className="cab-kpi"><div className="muted">Devices</div><div className="cab-kpi-value mono">{summary.devices}</div></div>
          <div className="cab-kpi"><div className="muted">Ports</div><div className="cab-kpi-value mono">{summary.ports}</div></div>
          <div className="cab-kpi"><div className="muted">Wall outlets recorded</div><div className="cab-kpi-value mono">{summary.outlets}</div></div>
        </div>
      )}

      {form && (
        <form className="card cab-wide" onSubmit={create} autoComplete="off">
          <h2>New room</h2>
          <div className="form-row">
            <label>Name<input value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} required placeholder="TS-1" /></label>
            <label>Location<input value={form.location} onChange={(e) => setForm({ ...form, location: e.target.value })} placeholder="Ground floor" /></label>
            <label>Floor<input value={form.floor} onChange={(e) => setForm({ ...form, floor: e.target.value })} className="cab-in-num" /></label>
            <label className="cab-grow">Notes<input value={form.notes} onChange={(e) => setForm({ ...form, notes: e.target.value })} /></label>
            <button type="submit">Create</button>
            <button type="button" className="cab-btn-ghost" onClick={() => setForm(null)}>Cancel</button>
          </div>
        </form>
      )}

      {!rooms ? <p className="muted">Loading...</p> : rooms.length === 0 ? (
        <div className="card"><p className="muted">No rooms yet. {rights.canEdit ? 'Create the first one with "New room".' : 'Ask an operator or administrator to add the first room.'}</p></div>
      ) : (
        <div className="card cab-wide">
          <table className="table">
            <thead><tr><th>Room</th><th>Location</th><th>Floor</th><th>Racks</th><th>Devices</th><th>Ports</th></tr></thead>
            <tbody>
              {rooms.map((r) => (
                <tr key={r.id}>
                  <td><Link to={`/cabling/rooms/${r.id}`}><strong className="mono">{r.name}</strong></Link></td>
                  <td>{r.location || '—'}</td><td>{r.floor || '—'}</td>
                  <td className="mono">{r.racks}</td><td className="mono">{r.devices}</td><td className="mono">{r.ports}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
