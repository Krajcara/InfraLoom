import { useEffect, useMemo, useState } from 'react';
import { api } from '../../api';
import { errText, labelOf } from './common';

const panelOf = (catalog, type) => (catalog?.panel_types || []).includes(type);

/** Connect one side of a port to a free side of another port. The kind of cable follows from the sides. */
export function NewLinkForm({ fromPort, fromDevice, catalog, onDone, onCancel }) {
  const isPanel = panelOf(catalog, fromDevice.device_type);
  const freeSides = ['front', 'rear'].filter((s) => (s === 'front' || isPanel) && !fromPort.connections?.[s]);
  const [sideA, setSideA] = useState(freeSides[0] || 'front');
  const [devices, setDevices] = useState([]);
  const [filter, setFilter] = useState('');
  const [deviceId, setDeviceId] = useState('');
  const [target, setTarget] = useState(null); // full device with ports
  const [portKey, setPortKey] = useState('');
  const [trunks, setTrunks] = useState([]);
  const [f, setF] = useState({ cable_type: '', color: '', length_m: '', notes: '', trunk_cable_id: '', strands: '' });
  const [error, setError] = useState(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    api.get('/cabling/devices').then((d) => setDevices(d.devices)).catch((e) => setError(errText(e)));
    api.get('/cabling/trunks').then((d) => setTrunks(d.trunks)).catch(() => {});
  }, []);
  useEffect(() => {
    setTarget(null); setPortKey('');
    if (deviceId) api.get(`/cabling/devices/${deviceId}`).then((d) => setTarget(d.device)).catch((e) => setError(errText(e)));
  }, [deviceId]);

  const shown = useMemo(() => {
    const q = filter.trim().toLowerCase();
    return devices.filter((d) => d.id !== fromDevice.id || isPanel).filter((d) => !q || `${d.name} ${d.room_name || ''} ${d.office_name || ''}`.toLowerCase().includes(q));
  }, [devices, filter, fromDevice.id, isPanel]);

  const targetPanel = target && panelOf(catalog, target.device_type);
  const options = target ? target.ports.flatMap((p) => {
    const sides = targetPanel ? ['front', 'rear'] : ['front'];
    return sides.filter((s) => !p.connections?.[s] && !(p.id === fromPort.id && s === sideA)).map((s) => ({ key: `${p.id}:${s}`, label: targetPanel ? `${p.name} · ${s}` : p.name }));
  }) : [];
  const [portId, sideB] = portKey ? portKey.split(':') : [null, null];
  const kind = sideA === 'rear' && sideB === 'rear' ? 'permanent' : 'patch';
  const crossRoom = kind === 'permanent' && target && target.room_id !== fromDevice.room_id;
  const usable = crossRoom ? trunks.filter((t) => (t.room_a_id === fromDevice.room_id && t.room_b_id === target.room_id) || (t.room_b_id === fromDevice.room_id && t.room_a_id === target.room_id)) : [];

  async function submit(e) {
    e.preventDefault(); setError(null); setBusy(true);
    try {
      const body = { port_a_id: fromPort.id, side_a: sideA, port_b_id: Number(portId), side_b: sideB, cable_type: f.cable_type || null, color: f.color || null, length_m: f.length_m || null, notes: f.notes || null };
      if (crossRoom) { body.trunk_cable_id = f.trunk_cable_id ? Number(f.trunk_cable_id) : null; if (f.strands) body.strands = f.strands; }
      await api.post('/cabling/links', body);
      onDone();
    } catch (err) { setError(errText(err)); } finally { setBusy(false); }
  }
  const set = (k, v) => { setError(null); setF((x) => ({ ...x, [k]: v })); };

  if (!freeSides.length) return <div><p className="muted">Every side of this port is already connected. Disconnect one first.</p><button type="button" className="cab-btn-ghost" onClick={onCancel}>Close</button></div>;

  return (
    <form onSubmit={submit} className="cab-linkform" autoComplete="off">
      <h3>Connect {fromDevice.name} · {fromPort.name}</h3>
      {isPanel && (
        <label>This port's side
          <select value={sideA} onChange={(e) => setSideA(e.target.value)}>
            {freeSides.map((s) => <option key={s} value={s}>{s === 'front' ? 'front (patch cord)' : 'rear (permanent installation / outlet)'}</option>)}
          </select>
        </label>
      )}
      <label>Other device
        <input value={filter} onChange={(e) => setFilter(e.target.value)} placeholder="Type to narrow the list" aria-label="Filter devices" />
        <select value={deviceId} onChange={(e) => setDeviceId(e.target.value)} required aria-label="Other device">
          <option value="">— choose —</option>
          {shown.map((d) => <option key={d.id} value={d.id}>{d.room_name || d.office_name || 'no place'} · {d.name}</option>)}
        </select>
      </label>
      <label>Other port
        <select value={portKey} onChange={(e) => setPortKey(e.target.value)} required disabled={!target} aria-label="Other port">
          <option value="">{target ? (options.length ? '— choose —' : 'no free port') : '—'}</option>
          {options.map((o) => <option key={o.key} value={o.key}>{o.label}</option>)}
        </select>
      </label>
      {portKey && <p className="muted">This is a {kind === 'permanent' ? 'permanent installation' : 'patch cord'}.</p>}
      {crossRoom && (
        <div className="cab-trunkpick">
          <label>Trunk cable
            <select value={f.trunk_cable_id} onChange={(e) => set('trunk_cable_id', e.target.value)} required aria-label="Trunk cable">
              <option value="">{usable.length ? '— choose —' : 'no trunk between these rooms'}</option>
              {usable.map((t) => <option key={t.id} value={t.id}>{t.name} ({t.used_strands}/{t.strand_count} strands used)</option>)}
            </select>
          </label>
          <label>Strands<input value={f.strands} onChange={(e) => set('strands', e.target.value)} placeholder="auto (next free pair)" aria-label="Strands" /></label>
        </div>
      )}
      <div className="form-row">
        <label>Cable
          <select value={f.cable_type} onChange={(e) => set('cable_type', e.target.value)} aria-label="Cable type"><option value="">—</option>{(catalog?.cable_types || []).map((c) => <option key={c} value={c}>{c}</option>)}</select>
        </label>
        <label>Colour
          <select value={f.color} onChange={(e) => set('color', e.target.value)} aria-label="Colour"><option value="">—</option>{(catalog?.cable_colors || []).map((c) => <option key={c} value={c}>{c}</option>)}</select>
        </label>
        <label>Length (m)<input type="number" min="0" step="0.1" value={f.length_m} onChange={(e) => set('length_m', e.target.value)} className="cab-in-num" aria-label="Length" /></label>
      </div>
      <label>Notes<input value={f.notes} onChange={(e) => set('notes', e.target.value)} /></label>
      {error && <p className="error">{error}</p>}
      <div className="form-row"><button type="submit" disabled={busy || !portKey}>{busy ? 'Connecting...' : 'Connect'}</button><button type="button" className="cab-btn-ghost" onClick={onCancel}>Cancel</button></div>
    </form>
  );
}

/** Change what is known about a cable (not its ends). */
export function EditLinkForm({ connection, side, port, catalog, onDone, onCancel }) {
  const [link, setLink] = useState(null);
  const [f, setF] = useState(null);
  const [error, setError] = useState(null);
  useEffect(() => {
    api.get(`/cabling/links?device_id=${port.device_id}`).then((d) => {
      const l = d.links.find((x) => x.id === connection.link_id);
      if (l) { setLink(l); setF({ cable_type: l.cable_type || '', color: l.color || '', length_m: l.length_m ?? '', notes: l.notes || '', strands: l.strands || '' }); }
    }).catch((e) => setError(errText(e)));
  }, [connection.link_id, port.device_id]);
  if (!f) return <p className="muted">{error || 'Loading...'}</p>;
  const set = (k, v) => { setError(null); setF((x) => ({ ...x, [k]: v })); };
  async function save(e) {
    e.preventDefault(); setError(null);
    try {
      const body = { cable_type: f.cable_type || null, color: f.color || null, length_m: f.length_m === '' ? null : f.length_m, notes: f.notes || null };
      if (link.trunk_cable_id) body.strands = f.strands;
      await api.put(`/cabling/links/${link.id}`, body);
      onDone();
    } catch (err) { setError(errText(err)); }
  }
  return (
    <form onSubmit={save} className="cab-linkform" autoComplete="off">
      <h3>Cable to {connection.other_device_name} · {connection.other_port_name}{connection.other_side === 'rear' ? ' (rear)' : ''}</h3>
      <div className="form-row">
        <label>Cable
          <select value={f.cable_type} onChange={(e) => set('cable_type', e.target.value)} aria-label="Cable type"><option value="">—</option>{(catalog?.cable_types || []).map((c) => <option key={c} value={c}>{c}</option>)}</select>
        </label>
        <label>Colour
          <select value={f.color} onChange={(e) => set('color', e.target.value)} aria-label="Colour"><option value="">—</option>{(catalog?.cable_colors || []).map((c) => <option key={c} value={c}>{c}</option>)}</select>
        </label>
        <label>Length (m)<input type="number" min="0" step="0.1" value={f.length_m} onChange={(e) => set('length_m', e.target.value)} className="cab-in-num" aria-label="Length" /></label>
      </div>
      {link.trunk_cable_id && <label>Strands on {link.trunk_name}<input value={f.strands} onChange={(e) => set('strands', e.target.value)} aria-label="Strands" /></label>}
      <label>Notes<input value={f.notes} onChange={(e) => set('notes', e.target.value)} /></label>
      {error && <p className="error">{error}</p>}
      <div className="form-row"><button type="submit">Save cable</button><button type="button" className="cab-btn-ghost" onClick={onCancel}>Cancel</button></div>
    </form>
  );
}
