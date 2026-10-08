import { useCallback, useEffect, useState } from 'react';
import { api } from '../../api';
import TrunkCard from '../../components/cabling/TrunkCard';
import { errText, useCablingRights, useCatalog } from '../../components/cabling/common';

const blank = () => ({ name: '', room_a_id: '', room_b_id: '', medium: 'fiber', fiber_type: 'OS2', strand_count: 12, length_m: '', notes: '' });

export default function CablingTrunksPage() {
  const rights = useCablingRights();
  const catalog = useCatalog();
  const [trunks, setTrunks] = useState(null);
  const [rooms, setRooms] = useState([]);
  const [open, setOpen] = useState({});
  const [form, setForm] = useState(null);
  const [error, setError] = useState(null);

  const load = useCallback(() => api.get('/cabling/trunks').then((d) => setTrunks(d.trunks)).catch((e) => setError(errText(e))), []);
  useEffect(() => { load(); api.get('/cabling/rooms').then((d) => setRooms(d.rooms)).catch(() => {}); }, [load]);

  const set = (k, v) => { setError(null); setForm((f) => ({ ...f, [k]: v })); };
  async function save(e) {
    e.preventDefault(); setError(null);
    const body = { name: form.name, room_a_id: Number(form.room_a_id), room_b_id: Number(form.room_b_id), medium: form.medium, fiber_type: form.medium === 'fiber' ? form.fiber_type : null, strand_count: Number(form.strand_count), length_m: form.length_m === '' ? null : form.length_m, notes: form.notes };
    try { if (form.id) await api.put(`/cabling/trunks/${form.id}`, body); else await api.post('/cabling/trunks', body); setForm(null); load(); } catch (err) { setError(errText(err)); }
  }
  async function remove(t) {
    if (!confirm(`Delete the trunk ${t.name}?`)) return;
    try { await api.del(`/cabling/trunks/${t.id}`); load(); } catch (err) { setError(errText(err)); }
  }

  return (
    <div className="page cab-page">
      <div className="cab-head">
        <h1>Links between rooms</h1>
        <div className="cab-head-tools">{rights.canEdit && <button type="button" onClick={() => setForm(form ? null : blank())}>New trunk</button>}</div>
      </div>
      <p className="muted">A trunk is a fibre or copper run between two rooms. Its strands are taken by the links you make between the panels at its two ends.</p>
      {error && <p className="error">{error}</p>}

      {form && (
        <form className="card cab-wide" onSubmit={save} autoComplete="off">
          <h2>{form.id ? 'Edit trunk' : 'New trunk'}</h2>
          <div className="cab-grid4">
            <label>Name<input value={form.name} onChange={(e) => set('name', e.target.value)} required placeholder="TS-1 to TS-2" /></label>
            <label>Room<select value={form.room_a_id} onChange={(e) => set('room_a_id', e.target.value)} required disabled={!!form.id && form.locked}><option value="">— choose —</option>{rooms.map((r) => <option key={r.id} value={r.id}>{r.name}</option>)}</select></label>
            <label>Other room<select value={form.room_b_id} onChange={(e) => set('room_b_id', e.target.value)} required disabled={!!form.id && form.locked}><option value="">— choose —</option>{rooms.map((r) => <option key={r.id} value={r.id}>{r.name}</option>)}</select></label>
            <label>Medium<select value={form.medium} onChange={(e) => set('medium', e.target.value)} disabled={!!form.id && form.locked}><option value="fiber">Fibre</option><option value="copper">Copper</option></select></label>
            {form.medium === 'fiber' && <label>Fibre type<select value={form.fiber_type || ''} onChange={(e) => set('fiber_type', e.target.value)}><option value="">—</option>{(catalog?.fiber_types || []).map((t) => <option key={t} value={t}>{t}</option>)}</select></label>}
            <label>{form.medium === 'fiber' ? 'Strands' : 'Pairs'}<input type="number" min="1" max="288" value={form.strand_count} onChange={(e) => set('strand_count', e.target.value)} required /></label>
            <label>Length (m)<input type="number" min="0" step="0.1" value={form.length_m} onChange={(e) => set('length_m', e.target.value)} /></label>
            <label>Notes<input value={form.notes} onChange={(e) => set('notes', e.target.value)} /></label>
          </div>
          <div className="form-row"><button type="submit">Save trunk</button><button type="button" className="cab-btn-ghost" onClick={() => setForm(null)}>Cancel</button></div>
        </form>
      )}

      {!trunks ? <p className="muted">Loading...</p> : trunks.length === 0 ? <div className="card"><p className="muted">No trunk cables yet.</p></div> : trunks.map((t) => (
        <TrunkCard
          key={t.id} trunk={t} rights={rights} open={!!open[t.id]} onToggle={() => setOpen((o) => ({ ...o, [t.id]: !o[t.id] }))}
          onEdit={() => setForm({ id: t.id, locked: (t.links || []).length > 0, name: t.name, room_a_id: t.room_a_id, room_b_id: t.room_b_id, medium: t.medium, fiber_type: t.fiber_type || '', strand_count: t.strand_count, length_m: t.length_m ?? '', notes: t.notes || '' })}
          onDelete={() => remove(t)}
        />
      ))}
    </div>
  );
}
