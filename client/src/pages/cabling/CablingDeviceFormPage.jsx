import { useEffect, useState } from 'react';
import { Link, useNavigate, useParams, useSearchParams } from 'react-router-dom';
import { api } from '../../api';
import PortStrip from '../../components/cabling/PortStrip';
import PortGroupsEditor, { emptyGroup, groupsForApi, totalPorts } from '../../components/cabling/PortGroupsEditor';
import { BulkOutletsForm } from '../../components/cabling/BulkForms';
import { errText, useCablingRights, useCatalog } from '../../components/cabling/common';

const blank = (room, office, rack, u) => ({
  name: '', device_type: 'switch', purpose: 'production', template_id: '', location: room ? `room:${room}` : office ? `office:${office}` : '', rack_id: room && rack ? rack : '', rack_position: room && rack && u ? u : '', height_u: 1,
  ip_address: '', serial_number: '', manufacturer: '', model: '', mac_address: '', notes: '', linked: '',
});

const fromTemplateGroups = (groups) => groups.map((g) => ({ prefix: g.prefix, start_no: g.start_no, end_no: g.end_no, port_type: g.port_type, speed: g.speed || '', poe: !!g.poe, role: g.role || '', connector: g.connector || '' }));

export default function CablingDeviceFormPage() {
  const { id } = useParams();
  const editing = Boolean(id);
  const [params] = useSearchParams();
  const navigate = useNavigate();
  const catalog = useCatalog();
  const rights = useCablingRights();

  const [form, setForm] = useState(blank(params.get('room'), params.get('office'), params.get('rack'), params.get('u')));
  const [groups, setGroups] = useState(editing ? [] : [emptyGroup()]);
  const [existing, setExisting] = useState([]);
  const [rooms, setRooms] = useState([]);
  const [offices, setOffices] = useState([]);
  const [templates, setTemplates] = useState([]);
  const [racks, setRacks] = useState([]);
  const [linkable, setLinkable] = useState([]);
  const [loaded, setLoaded] = useState(!editing);
  const [error, setError] = useState(null);
  const [info, setInfo] = useState(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    api.get('/cabling/rooms').then((d) => setRooms(d.rooms)).catch(() => {});
    api.get('/cabling/offices').then((d) => setOffices(d.offices)).catch(() => {});
    api.get('/cabling/templates').then((d) => setTemplates(d.templates)).catch(() => {});
    api.get('/cabling/linkable').then((d) => setLinkable(d.items)).catch(() => {});
  }, []);

  useEffect(() => {
    if (!editing) return;
    api.get(`/cabling/devices/${id}`).then(({ device: d }) => {
      setForm({
        name: d.name, device_type: d.device_type, purpose: d.purpose, template_id: d.template_id || '',
        location: d.room_id ? `room:${d.room_id}` : d.office_id ? `office:${d.office_id}` : '', rack_id: d.rack_id || '', rack_position: d.rack_position || '', height_u: d.height_u || 1,
        ip_address: d.ip_address || '', serial_number: d.serial_number || '', manufacturer: d.manufacturer || '', model: d.model || '', mac_address: d.mac_address || '', notes: d.notes || '',
        linked: d.linked_kind ? `${d.linked_kind}:${d.linked_id}` : '',
      });
      setExisting(d.ports);
      setLoaded(true);
    }).catch((e) => setError(errText(e)));
  }, [editing, id]);

  const roomId = form.location.startsWith('room:') ? Number(form.location.slice(5)) : null;
  const officeId = form.location.startsWith('office:') ? Number(form.location.slice(7)) : null;

  useEffect(() => {
    if (!roomId) { setRacks([]); return; }
    api.get(`/cabling/rooms/${roomId}`).then((d) => setRacks(d.racks)).catch(() => setRacks([]));
  }, [roomId]);

  const set = (k, v) => { setError(null); setForm((f) => ({ ...f, [k]: v })); };
  const panel = (catalog?.panel_types || []).includes(form.device_type);

  function pickTemplate(value) {
    set('template_id', value);
    const t = templates.find((x) => String(x.id) === String(value));
    if (!t) return;
    setForm((f) => ({ ...f, template_id: value, device_type: t.device_type, manufacturer: f.manufacturer || t.manufacturer || '', model: f.model || t.model || '' }));
    // a new device: the ports are made when it is saved; an existing one (e.g. added from a monitored device) gets them
    // through "Add these ports", so the template goes into that editor instead of doing nothing
    setGroups(fromTemplateGroups(t.groups));
    if (editing) {
      const n = t.groups.reduce((a, g) => a + g.end_no - g.start_no + 1, 0);
      setInfo(`Template "${t.name}" is loaded under "Add ports" below. Press "Add these ports" to create its ${n} port${n === 1 ? '' : 's'}${existing.length ? ' (names that already exist are refused)' : ''}.`);
    }
  }

  const payload = () => {
    const [kind, linkId] = form.linked ? form.linked.split(':') : [null, null];
    return {
      name: form.name, device_type: form.device_type, purpose: form.purpose, template_id: form.template_id || null,
      room_id: roomId, office_id: officeId, rack_id: roomId && form.rack_id ? Number(form.rack_id) : null, rack_position: roomId && form.rack_id && form.rack_position ? Number(form.rack_position) : null, height_u: Number(form.height_u) || 1,
      ip_address: form.ip_address, serial_number: form.serial_number, manufacturer: form.manufacturer, model: form.model, mac_address: form.mac_address, notes: form.notes,
      linked_kind: kind, linked_id: linkId ? Number(linkId) : null,
    };
  };

  async function save(e) {
    e.preventDefault(); setError(null); setInfo(null); setBusy(true);
    try {
      if (editing) {
        await api.put(`/cabling/devices/${id}`, payload());
        navigate(roomId ? `/cabling/rooms/${roomId}?device=${id}` : '/cabling/devices');
      } else {
        const r = await api.post('/cabling/devices', { ...payload(), groups: groupsForApi(groups) });
        navigate(roomId ? `/cabling/rooms/${roomId}?device=${r.device.id}` : '/cabling/devices');
      }
    } catch (err) { setError(errText(err)); } finally { setBusy(false); }
  }

  async function saveTemplate() {
    setError(null); setInfo(null);
    const name = window.prompt('Template name', form.model || form.name || '');
    if (!name) return;
    try {
      await api.post('/cabling/templates', { name, device_type: form.device_type, manufacturer: form.manufacturer, model: form.model, groups: groupsForApi(groups) });
      setInfo(`Template "${name}" saved.`);
      api.get('/cabling/templates').then((d) => setTemplates(d.templates)).catch(() => {});
    } catch (err) { setError(errText(err)); }
  }

  async function addPorts() {
    setError(null); setInfo(null);
    try {
      const r = await api.post(`/cabling/devices/${id}/ports`, { groups: groupsForApi(groups) });
      setExisting(r.device.ports); setGroups([]); setInfo('Ports added.');
    } catch (err) { setError(errText(err)); }
  }

  async function remove() {
    if (!confirm(`Delete ${form.name} and its ${existing.length} ports?`)) return;
    try { await api.del(`/cabling/devices/${id}`); navigate(roomId ? `/cabling/rooms/${roomId}` : '/cabling/devices'); } catch (err) { setError(errText(err)); }
  }

  if (!loaded && !error) return <div className="page-loading">Loading...</div>;
  const here = roomId ? rooms.find((r) => r.id === roomId) : null;
  const linkChoices = linkable.filter((i) => !i.linked || form.linked === `${i.kind}:${i.id}`);

  return (
    <div className="page cab-page">
      <div className="cab-crumbs muted">
        <Link to="/cabling">Cabling</Link> / {here ? <Link to={`/cabling/rooms/${here.id}`}>{here.name}</Link> : <Link to="/cabling/devices">Devices</Link>} / {editing ? 'Edit device' : 'New device'}
      </div>
      <form onSubmit={save} autoComplete="off">
        <div className="cab-head">
          <h1>{editing ? form.name || 'Edit device' : 'New device'}</h1>
          <div className="cab-head-tools">
            <button type="button" className="cab-btn-ghost" onClick={() => navigate(-1)}>Cancel</button>
            {!editing && rights.canEdit && <button type="button" className="cab-btn-ghost" onClick={saveTemplate} disabled={!totalPorts(groups)}>Save as template</button>}
            {rights.canEdit && <button type="submit" disabled={busy}>{busy ? 'Saving...' : 'Save device'}</button>}
          </div>
        </div>
        {error && <p className="error">{error}</p>}
        {info && <p className="success">{info}</p>}

        <section className="card cab-wide">
          <h2>Basic data</h2>
          <div className="cab-grid4">
            <label>Name<input value={form.name} onChange={(e) => set('name', e.target.value)} required placeholder="SW-03" /></label>
            <label>Device type
              <select value={form.device_type} onChange={(e) => set('device_type', e.target.value)}>{(catalog?.device_types || []).map((t) => <option key={t.value} value={t.value}>{t.label}</option>)}</select>
            </label>
            <label>Purpose
              <select value={form.purpose} onChange={(e) => set('purpose', e.target.value)}>{(catalog?.purposes || []).map((t) => <option key={t.value} value={t.value}>{t.label}</option>)}</select>
            </label>
            <label>Template
              <select value={form.template_id} onChange={(e) => pickTemplate(e.target.value)}><option value="">— none —</option>{templates.map((t) => <option key={t.id} value={t.id}>{t.name} ({t.port_count} ports)</option>)}</select>
            </label>
            <label>Location
              <select value={form.location} onChange={(e) => setForm((f) => ({ ...f, location: e.target.value, rack_id: '', rack_position: '' }))}>
                <option value="">— no place —</option>
                <optgroup label="Rooms">{rooms.map((r) => <option key={`r${r.id}`} value={`room:${r.id}`}>{r.name}</option>)}</optgroup>
                <optgroup label="Offices">{offices.map((o) => <option key={`o${o.id}`} value={`office:${o.id}`}>{o.name}</option>)}</optgroup>
              </select>
            </label>
            <div className="cab-rackpos">
              <label>Rack
                <select value={form.rack_id} onChange={(e) => set('rack_id', e.target.value)} disabled={!roomId}><option value="">—</option>{racks.map((r) => <option key={r.id} value={r.id}>{r.name} ({r.height_u} U)</option>)}</select>
              </label>
              <label>Position (U)<input type="number" min="1" max="60" value={form.rack_position} onChange={(e) => set('rack_position', e.target.value)} disabled={!form.rack_id} placeholder="U37" /></label>
            </div>
            <label>Height (U)<input type="number" min="1" max="60" value={form.height_u} onChange={(e) => set('height_u', e.target.value)} disabled={!form.rack_id} aria-label="Height in rack units" /></label>
            <label>IP address<input className="mono" value={form.ip_address} onChange={(e) => set('ip_address', e.target.value)} placeholder="e.g. 10.10.0.13 or DHCP" /></label>
            <label>Serial number<input className="mono" value={form.serial_number} onChange={(e) => set('serial_number', e.target.value)} /></label>
            <label>Manufacturer<input value={form.manufacturer} onChange={(e) => set('manufacturer', e.target.value)} /></label>
            <label>Model<input value={form.model} onChange={(e) => set('model', e.target.value)} /></label>
            <label>MAC address<input className="mono" value={form.mac_address} onChange={(e) => set('mac_address', e.target.value)} placeholder="84:39:8f:d2:86:40" /></label>
            <label>Monitored in InfraLoom as
              <select value={form.linked} onChange={(e) => set('linked', e.target.value)}>
                <option value="">— not linked —</option>
                {linkChoices.map((i) => <option key={`${i.kind}${i.id}`} value={`${i.kind}:${i.id}`}>{i.name} ({i.kind.replace('_', ' ')}{i.address && i.address !== '0.0.0.0' ? `, ${i.address}` : ''})</option>)}
              </select>
            </label>
          </div>
          <label>Notes<input value={form.notes} onChange={(e) => set('notes', e.target.value)} /></label>
          {form.linked && <p className="muted">Linked devices show their live state (online, down, alerts) on the room view.</p>}
        </section>

        {editing && (
          <section className="card cab-wide">
            <h2>Ports ({existing.length})</h2>
            <p className="muted">Click a port in the room view to edit it. Add more here, for example a new SFP+ module block.</p>
            <PortStrip ports={existing} panel={panel} />
          </section>
        )}

        <section className="card cab-wide">
          <div className="cab-sec-head">
            <div>
              <h2>{editing ? 'Add ports' : 'Port groups'}</h2>
              <p className="muted">{editing ? 'New ports are added after the existing ones.' : 'Filled in from the template. Ports are generated when you save and can be edited one by one afterwards.'}</p>
            </div>
            {editing && rights.canEdit && <button type="button" onClick={addPorts} disabled={!totalPorts(groups)}>Add these ports</button>}
          </div>
          <PortGroupsEditor groups={groups} onChange={setGroups} catalog={catalog} panel={panel} />
        </section>
      </form>
      {editing && form.device_type === 'patch_panel' && existing.length > 0 && rights.canEdit && (
        <BulkOutletsForm
          key={existing.length}
          device={{ id: Number(id), ports: existing }} offices={offices} catalog={catalog}
          onDone={(n) => { setInfo(`${n} wall outlets labelled.`); api.get(`/cabling/devices/${id}`).then((r) => setExisting(r.device.ports)).catch(() => {}); }}
        />
      )}
      {editing && rights.canDelete && <p><button type="button" className="btn-link danger" onClick={remove}>Delete this device</button></p>}
    </div>
  );
}
