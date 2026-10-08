import { useCallback, useEffect, useState } from 'react';
import { api } from '../../api';
import PortGroupsEditor, { emptyGroup, groupsForApi } from '../../components/cabling/PortGroupsEditor';
import { errText, labelOf, useCablingRights, useCatalog } from '../../components/cabling/common';

const toEditor = (groups) => groups.map((g) => ({ prefix: g.prefix, start_no: g.start_no, end_no: g.end_no, port_type: g.port_type, speed: g.speed || '', poe: !!g.poe, role: g.role || '', connector: g.connector || '' }));

export default function CablingTemplatesPage() {
  const rights = useCablingRights();
  const catalog = useCatalog();
  const [templates, setTemplates] = useState(null);
  const [form, setForm] = useState(null); // { id?, name, device_type, manufacturer, model, notes, groups }
  const [error, setError] = useState(null);

  const load = useCallback(() => api.get('/cabling/templates').then((d) => setTemplates(d.templates)).catch((e) => setError(errText(e))), []);
  useEffect(() => { load(); }, [load]);

  async function save(e) {
    e.preventDefault(); setError(null);
    const body = { name: form.name, device_type: form.device_type, manufacturer: form.manufacturer, model: form.model, notes: form.notes, groups: groupsForApi(form.groups) };
    try { if (form.id) await api.put(`/cabling/templates/${form.id}`, body); else await api.post('/cabling/templates', body); setForm(null); load(); } catch (err) { setError(errText(err)); }
  }
  async function remove(t) {
    if (!confirm(`Delete template ${t.name}? Devices made from it keep their ports.`)) return;
    try { await api.del(`/cabling/templates/${t.id}`); load(); } catch (err) { setError(errText(err)); }
  }
  const panel = form && (catalog?.panel_types || []).includes(form.device_type);

  return (
    <div className="page cab-page">
      <div className="cab-head">
        <h1>Device templates</h1>
        <div className="cab-head-tools">{rights.canEdit && <button type="button" onClick={() => setForm({ name: '', device_type: 'switch', manufacturer: '', model: '', notes: '', groups: [emptyGroup()] })}>New template</button>}</div>
      </div>
      <p className="muted">A template is a ready-made set of port groups (for example 24 × RJ45 PoE + 4 × SFP+). Pick it when adding a device and the ports are created for you.</p>
      {error && <p className="error">{error}</p>}

      {form && (
        <form className="card cab-wide" onSubmit={save} autoComplete="off">
          <h2>{form.id ? 'Edit template' : 'New template'}</h2>
          <div className="cab-grid4">
            <label>Name<input value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} required placeholder="FortiSwitch 124F-POE" /></label>
            <label>Device type
              <select value={form.device_type} onChange={(e) => setForm({ ...form, device_type: e.target.value })}>{(catalog?.device_types || []).map((t) => <option key={t.value} value={t.value}>{t.label}</option>)}</select>
            </label>
            <label>Manufacturer<input value={form.manufacturer} onChange={(e) => setForm({ ...form, manufacturer: e.target.value })} /></label>
            <label>Model<input value={form.model} onChange={(e) => setForm({ ...form, model: e.target.value })} /></label>
          </div>
          <PortGroupsEditor groups={form.groups} onChange={(groups) => setForm({ ...form, groups })} catalog={catalog} panel={panel} />
          <div className="form-row" style={{ marginTop: 12 }}><button type="submit">Save template</button><button type="button" className="cab-btn-ghost" onClick={() => setForm(null)}>Cancel</button></div>
        </form>
      )}

      {!templates ? <p className="muted">Loading...</p> : templates.length === 0 ? <div className="card"><p className="muted">No templates yet.</p></div> : (
        <div className="card cab-wide">
          <table className="table">
            <thead><tr><th>Name</th><th>Type</th><th>Model</th><th>Ports</th><th /></tr></thead>
            <tbody>
              {templates.map((t) => (
                <tr key={t.id}>
                  <td className="mono"><strong>{t.name}</strong></td><td>{labelOf(catalog?.device_types, t.device_type)}</td>
                  <td>{[t.manufacturer, t.model].filter(Boolean).join(' ') || '—'}</td><td className="mono">{t.port_count}</td>
                  <td className="actions">
                    {rights.canEdit && <button type="button" className="btn-link" onClick={() => setForm({ id: t.id, name: t.name, device_type: t.device_type, manufacturer: t.manufacturer || '', model: t.model || '', notes: t.notes || '', groups: toEditor(t.groups) })}>Edit</button>}
                    {rights.canDelete && <button type="button" className="btn-link danger" onClick={() => remove(t)}>Delete</button>}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
