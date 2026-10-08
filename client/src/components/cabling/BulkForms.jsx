import { useEffect, useState } from 'react';
import { api } from '../../api';
import { errText } from './common';

const isPanel = (catalog, d) => d && (catalog?.panel_types || []).includes(d.device_type);

function PreviewTable({ rows }) {
  return (
    <table className="table cab-preview-table">
      <tbody>
        {rows.map((r, i) => (
          <tr key={i} className={r.ok === false ? 'cab-bad' : ''}>
            <td className="mono">{i + 1}</td>
            <td className="mono">{r.a}</td>
            <td className="muted">↔</td>
            <td className="mono">{r.b}</td>
            <td>{r.ok === false ? <span className="error">{r.error}</span> : <span className="success">{r.strands ? `strands ${r.strands}` : 'ok'}</span>}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

/** Connect a run of ports to a run of ports — PP-A 1–24 to SW-01 Gi1/0/1–24, or ODF-1 1–6 to ODF-2 1–6 over a trunk. */
export function BulkLinkForm({ catalog, initialDeviceId, onDone, onCancel }) {
  const [devices, setDevices] = useState([]);
  const [trunks, setTrunks] = useState([]);
  const [a, setA] = useState({ device_id: initialDeviceId ? String(initialDeviceId) : '', side: 'front', start_port: '' });
  const [b, setB] = useState({ device_id: '', side: 'front', start_port: '' });
  const [da, setDa] = useState(null);
  const [dbv, setDbv] = useState(null);
  const [count, setCount] = useState(12);
  const [f, setF] = useState({ cable_type: '', color: '', length_m: '', trunk_cable_id: '' });
  const [preview, setPreview] = useState(null);
  const [error, setError] = useState(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    api.get('/cabling/devices').then((d) => setDevices(d.devices)).catch((e) => setError(errText(e)));
    api.get('/cabling/trunks').then((d) => setTrunks(d.trunks)).catch(() => {});
  }, []);
  const load = (id, set, setDev) => {
    set((x) => ({ ...x, start_port: '' })); setDev(null);
    if (id) api.get(`/cabling/devices/${id}`).then((d) => { setDev(d.device); set((x) => ({ ...x, start_port: d.device.ports[0]?.name || '' })); }).catch((e) => setError(errText(e)));
  };
  useEffect(() => { load(a.device_id, setA, setDa); }, [a.device_id]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => { load(b.device_id, setB, setDbv); }, [b.device_id]); // eslint-disable-line react-hooks/exhaustive-deps

  const touch = () => { setPreview(null); setError(null); };
  const remaining = (dev, start) => { const i = dev ? dev.ports.findIndex((p) => p.name === start) : -1; return i < 0 ? 0 : dev.ports.length - i; };
  const maxCount = Math.min(remaining(da, a.start_port), remaining(dbv, b.start_port)) || 0;
  const rear = a.side === 'rear' && b.side === 'rear';
  const cross = rear && da && dbv && da.room_id !== dbv.room_id;
  const usable = cross ? trunks.filter((t) => (t.room_a_id === da.room_id && t.room_b_id === dbv.room_id) || (t.room_b_id === da.room_id && t.room_a_id === dbv.room_id)) : [];

  const body = (dry) => ({
    a: { device_id: Number(a.device_id), side: a.side, start_port: a.start_port }, b: { device_id: Number(b.device_id), side: b.side, start_port: b.start_port }, count: Number(count),
    cable_type: f.cable_type || null, color: f.color || null, length_m: f.length_m || null, trunk_cable_id: cross && f.trunk_cable_id ? Number(f.trunk_cable_id) : null, dry_run: dry || undefined,
  });
  async function run(dry) {
    setError(null); setBusy(true);
    try {
      const r = await api.post('/cabling/links/bulk', body(dry));
      if (dry) setPreview(r); else onDone(r.created);
    } catch (e) { setError(errText(e)); } finally { setBusy(false); }
  }

  const side = (x, setX, dev) => (
    <div className="cab-bulkend">
      <label>Device
        <select value={x.device_id} onChange={(e) => { touch(); setX({ ...x, device_id: e.target.value }); }} aria-label="Bulk device">
          <option value="">— choose —</option>
          {devices.map((d) => <option key={d.id} value={d.id}>{d.room_name || d.office_name || 'no place'} · {d.name}</option>)}
        </select>
      </label>
      {isPanel(catalog, dev) && (
        <label>Side
          <select value={x.side} onChange={(e) => { touch(); setX({ ...x, side: e.target.value }); }} aria-label="Bulk side"><option value="front">front (patch cords)</option><option value="rear">rear (permanent)</option></select>
        </label>
      )}
      <label>First port
        <select value={x.start_port} onChange={(e) => { touch(); setX({ ...x, start_port: e.target.value }); }} disabled={!dev} aria-label="Bulk first port">
          {(dev?.ports || []).map((p) => <option key={p.id} value={p.name}>{p.name}</option>)}
        </select>
      </label>
    </div>
  );

  return (
    <form className="card cab-wide cab-bulk" autoComplete="off" onSubmit={(e) => { e.preventDefault(); run(true); }}>
      <h2>Bulk connect</h2>
      <p className="muted">Connect a run of ports to a run of ports in order: the first of each, and how many. Nothing is made until the preview is clean, and then all of it is made or none.</p>
      <div className="cab-bulkgrid">
        {side(a, setA, da)}
        <div className="cab-bulkmid">
          <label>How many
            <input type="number" min="1" max="96" value={count} onChange={(e) => { touch(); setCount(e.target.value); }} className="cab-in-num" aria-label="How many" />
          </label>
          {maxCount > 0 && <button type="button" className="btn-link" onClick={() => { touch(); setCount(Math.min(maxCount, 96)); }}>all {Math.min(maxCount, 96)} possible</button>}
        </div>
        {side(b, setB, dbv)}
      </div>
      {cross && (
        <label>Trunk cable
          <select value={f.trunk_cable_id} onChange={(e) => { touch(); setF({ ...f, trunk_cable_id: e.target.value }); }} required aria-label="Bulk trunk">
            <option value="">{usable.length ? '— choose —' : 'no trunk between these rooms'}</option>
            {usable.map((t) => <option key={t.id} value={t.id}>{t.name} ({t.used_strands}/{t.strand_count} strands used)</option>)}
          </select>
        </label>
      )}
      <div className="form-row">
        <label>Cable
          <select value={f.cable_type} onChange={(e) => { touch(); setF({ ...f, cable_type: e.target.value }); }} aria-label="Bulk cable type"><option value="">—</option>{(catalog?.cable_types || []).map((c) => <option key={c} value={c}>{c}</option>)}</select>
        </label>
        <label>Colour
          <select value={f.color} onChange={(e) => { touch(); setF({ ...f, color: e.target.value }); }} aria-label="Bulk colour"><option value="">—</option>{(catalog?.cable_colors || []).map((c) => <option key={c} value={c}>{c}</option>)}</select>
        </label>
        <label>Length (m)<input type="number" min="0" step="0.1" value={f.length_m} onChange={(e) => { touch(); setF({ ...f, length_m: e.target.value }); }} className="cab-in-num" aria-label="Bulk length" /></label>
      </div>
      {error && <p className="error">{error}</p>}
      {preview && (
        <>
          <p>{preview.error_count ? <span className="error">{preview.error_count} of {preview.pairs.length} pairs cannot be connected.</span> : <span className="success">All {preview.pairs.length} pairs can be connected.</span>}</p>
          <div className="cab-scroll"><PreviewTable rows={preview.pairs} /></div>
        </>
      )}
      <div className="form-row">
        <button type="submit" className="cab-btn-ghost" disabled={busy || !a.device_id || !b.device_id || !a.start_port || !b.start_port}>Preview</button>
        <button type="button" disabled={busy || !preview || preview.error_count > 0} onClick={() => run(false)}>{busy ? 'Working...' : `Connect all${preview ? ` ${preview.pairs.length}` : ''}`}</button>
        <button type="button" className="cab-btn-ghost" onClick={onCancel}>Cancel</button>
      </div>
    </form>
  );
}

/** Label the wall outlets of a patch panel in one go: ports 1–24 → K-01…K-24 in an office. */
export function BulkOutletsForm({ device, offices, catalog, onDone }) {
  const [f, setF] = useState({ office_id: '', start_port: device.ports[0]?.name || '', count: Math.min(24, device.ports.length) || 1, label_prefix: 'K-', label_start: 1, label_pad: 2, rear_cable_type: '', rear_length_m: '', overwrite: false });
  const [plan, setPlan] = useState(null);
  const [error, setError] = useState(null);
  const [done, setDone] = useState(null);
  const [busy, setBusy] = useState(false);
  const set = (k, v) => { setPlan(null); setError(null); setDone(null); setF((x) => ({ ...x, [k]: v })); };
  const body = (dry) => ({ ...f, office_id: f.office_id ? Number(f.office_id) : null, count: Number(f.count), label_start: Number(f.label_start), label_pad: Number(f.label_pad), rear_length_m: f.rear_length_m === '' ? null : f.rear_length_m, rear_cable_type: f.rear_cable_type || null, dry_run: dry || undefined });
  async function run(dry) {
    setError(null); setBusy(true);
    try {
      const r = await api.post(`/cabling/devices/${device.id}/outlets/bulk`, body(dry));
      if (dry) setPlan(r); else { setPlan(null); setDone(`${r.updated} wall outlets labelled: ${r.plan[0].label} to ${r.plan[r.plan.length - 1].label}.`); onDone(r.updated); }
    } catch (e) { setError(errText(e)); } finally { setBusy(false); }
  }
  return (
    <form className="card cab-wide cab-bulk" autoComplete="off" onSubmit={(e) => { e.preventDefault(); run(true); }}>
      <h2>Label wall outlets</h2>
      <p className="muted">Name the outlets that the rear side of these ports runs to, a run at a time: for example ports 1–24 become K-01 to K-24 in Office 02.</p>
      <div className="cab-grid4">
        <label>Office
          <select value={f.office_id} onChange={(e) => set('office_id', e.target.value)} required aria-label="Outlets office"><option value="">— choose —</option>{offices.map((o) => <option key={o.id} value={o.id}>{o.name}</option>)}</select>
        </label>
        <label>First port
          <select value={f.start_port} onChange={(e) => set('start_port', e.target.value)} aria-label="Outlets first port">{device.ports.map((p) => <option key={p.id} value={p.name}>{p.name}</option>)}</select>
        </label>
        <label>How many<input type="number" min="1" max="96" value={f.count} onChange={(e) => set('count', e.target.value)} aria-label="Outlets how many" /></label>
        <label>Label starts with<input value={f.label_prefix} onChange={(e) => set('label_prefix', e.target.value)} maxLength={30} aria-label="Outlets prefix" /></label>
        <label>First number<input type="number" min="0" value={f.label_start} onChange={(e) => set('label_start', e.target.value)} aria-label="Outlets first number" /></label>
        <label>Digits (01 = 2)<input type="number" min="0" max="6" value={f.label_pad} onChange={(e) => set('label_pad', e.target.value)} aria-label="Outlets digits" /></label>
        <label>Cable to the outlet
          <select value={f.rear_cable_type} onChange={(e) => set('rear_cable_type', e.target.value)} aria-label="Outlets cable"><option value="">—</option>{(catalog?.cable_types || []).map((c) => <option key={c} value={c}>{c}</option>)}</select>
        </label>
        <label>Length (m)<input type="number" min="0" step="0.1" value={f.rear_length_m} onChange={(e) => set('rear_length_m', e.target.value)} aria-label="Outlets length" /></label>
      </div>
      <label className="checkbox-row"><input type="checkbox" checked={f.overwrite} onChange={(e) => set('overwrite', e.target.checked)} /><span>Replace outlets that are already recorded</span></label>
      {error && <p className="error">{error}</p>}
      {done && <p className="success">{done}</p>}
      {plan && (
        <div className="cab-scroll">
          <p className="muted">{plan.plan.length} ports{plan.overwrites ? `, ${plan.overwrites} existing outlet${plan.overwrites === 1 ? '' : 's'} will be replaced` : ''}: <span className="mono">{plan.plan[0].port} → {plan.plan[0].label}</span> … <span className="mono">{plan.plan[plan.plan.length - 1].port} → {plan.plan[plan.plan.length - 1].label}</span></p>
        </div>
      )}
      <div className="form-row">
        <button type="submit" className="cab-btn-ghost" disabled={busy}>Preview</button>
        <button type="button" disabled={busy || !plan} onClick={() => run(false)}>{busy ? 'Working...' : `Label ${plan ? plan.plan.length : ''} outlets`}</button>
      </div>
    </form>
  );
}
