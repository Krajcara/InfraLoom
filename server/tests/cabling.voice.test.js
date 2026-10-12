'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { startServer, clientsFor } = require('./_helpers');

let srv; let c;
test.before(async () => { srv = await startServer(); c = await clientsFor(srv); });
test.after(() => srv?.stop());

const A = '/api/cabling';
const id = {}; const port = {};
const mk = async (client, path, body) => { const r = await client.post(`${A}${path}`, body); assert.ok(r.status < 300, `${path} ${JSON.stringify(body)} -> ${r.status} ${JSON.stringify(r.body)}`); return r.body; };
const rj = (prefix, a, b, extra = {}) => [{ prefix, start_no: a, end_no: b, port_type: 'rj45', speed: '1G', ...extra }];
const device = async (name, type, where, groups) => { const d = (await mk(c.admin, '/devices', { name, device_type: type, groups, ...where })).device; id[name] = d.id; for (const p of d.ports) port[`${name}/${p.name}`] = p.id; return d; };
const portOf = (d, n) => port[`${d}/${n}`];
const portView = async (d, n) => (await c.viewer.get(`${A}/devices/${id[d]}`)).body.device.ports.find((p) => p.name === n);
const link = (a, sa, b, sb, extra = {}) => c.operator.post(`${A}/links`, { port_a_id: portOf(...a), side_a: sa, port_b_id: portOf(...b), side_b: sb, ...extra });

test('the lists know about telephony', async () => {
  const cat = (await c.viewer.get(`${A}/catalog`)).body;
  assert.deepEqual(cat.services, [{ value: 'data', label: 'Data' }, { value: 'voice', label: 'Telephone' }]);
  assert.ok(cat.device_types.some((t) => t.value === 'pbx' && /exchange/.test(t.label)));
  for (const t of ['rj11', 'rj21', 'lsa']) assert.ok(cat.port_types.some((p) => p.value === t), t);
  assert.ok(cat.cable_types.includes('Telephone'));
});

test('setup: a room, an office, a patch panel, a switch and a telephone exchange', async () => {
  id.room = (await mk(c.admin, '/rooms', { name: 'TS-1' })).room.id;
  id.office = (await mk(c.admin, '/offices', { name: 'Office 02' })).office.id;
  await device('PP-A', 'patch_panel', { room_id: id.room }, rj('', 1, 24));
  await device('SW-01', 'switch', { room_id: id.room }, rj('Gi1/0/', 1, 8));
  const pbx = await device('PBX-1', 'pbx', { room_id: id.room }, [{ prefix: 'ext', start_no: 1, end_no: 8, port_type: 'rj11', service: 'voice' }]);
  assert.equal(pbx.ports.length, 8); assert.ok(pbx.ports.every((p) => p.port_type === 'rj11' && p.service === 'voice'), 'a group can carry the service');
  assert.ok((await portView('PP-A', '1')).service === 'data' && (await portView('SW-01', 'Gi1/0/1')).service === 'data', 'data is the default');
});

test('groups and templates: an unknown service is refused, and a template remembers the service', async () => {
  const bad = await c.operator.post(`${A}/templates`, { name: 'Bad', device_type: 'patch_panel', groups: rj('', 1, 4, { service: 'fax' }) });
  assert.equal(bad.status, 400); assert.match(bad.body.error, /Group 1: unknown service "fax"/);
  const t = await mk(c.operator, '/templates', { name: 'Telephone panel 12', device_type: 'patch_panel', groups: rj('', 1, 12, { service: 'voice' }) });
  assert.equal(t.template.groups[0].service, 'voice');
  const d = (await mk(c.operator, '/devices', { name: 'PP-T', device_type: 'patch_panel', room_id: id.room, template_id: t.template.id })).device;
  assert.equal(d.ports.length, 12); assert.ok(d.ports.every((p) => p.service === 'voice'), 'ports made from the template are telephone ports');
  id['PP-T'] = d.id; for (const p of d.ports) port[`PP-T/${p.name}`] = p.id;
  const edited = await mk(c.operator, `/devices/${id['PP-A']}/ports`, { groups: [{ prefix: 'x', start_no: 1, end_no: 2, port_type: 'rj45' }] });
  assert.ok(edited.device.ports.slice(-2).every((p) => p.service === 'data'));
});

test('a port gets its service from its edit; an unknown one is refused', async () => {
  assert.equal((await c.operator.put(`${A}/ports/${portOf('PP-A', '5')}`, { service: 'fax' })).status, 400);
  assert.equal((await c.viewer.put(`${A}/ports/${portOf('PP-A', '5')}`, { service: 'voice' })).status, 403);
  const ok = await c.operator.put(`${A}/ports/${portOf('PP-A', '5')}`, { service: 'voice', office_id: id.office, outlet_label: 'T-5', rear_cable_type: 'Telephone', rear_length_m: 20 });
  assert.equal(ok.status, 200); assert.equal(ok.body.port.service, 'voice'); assert.equal(ok.body.port.rear_cable_type, 'Telephone');
  assert.equal(ok.body.port.status, 'outlet', 'a telephone outlet with nothing patched is still the dashed outlet state');
  assert.equal((await c.operator.put(`${A}/ports/${portOf('PP-A', '5')}`, { notes: 'x' })).body.port.service, 'voice', 'an edit that does not mention it keeps it');
});

test('the telephone line: exchange -> telephone cable -> panel -> telephone socket, coloured as voice at every point', async () => {
  const l = await link(['PBX-1', 'ext1'], 'front', ['PP-A', '5'], 'front', { cable_type: 'Telephone', length_m: 2, color: 'grey' });
  assert.equal(l.status, 201, JSON.stringify(l.body));
  const t = l.body.trace;
  assert.deepEqual(t.steps.map((s) => (s.type === 'port' ? `${s.device_name}:${s.port_name}` : s.type === 'outlet' ? `outlet ${s.label}` : s.type)), ['PBX-1:ext1', 'link', 'PP-A:5', 'installation', 'outlet T-5']);
  assert.equal(t.steps[1].cable_type, 'Telephone'); assert.equal(t.steps[3].cable_type, 'Telephone'); assert.equal(t.steps[3].length_m, 20);
  assert.equal(t.steps[4].service, 'voice'); assert.equal(t.steps[0].device_type, 'pbx');
  assert.equal((await portView('PBX-1', 'ext1')).status, 'voice'); assert.equal((await portView('PP-A', '5')).status, 'voice');
  assert.equal((await portView('PBX-1', 'ext2')).status, 'free');
  const ports = (await c.viewer.get(`${A}/devices/${id['PBX-1']}`)).body.device.ports;
  assert.equal(ports[0].connections.front.other_device_name, 'PP-A');
});

test('a data path next to it is not touched, and a telephone cable on a data port makes it a telephone line', async () => {
  assert.equal((await c.operator.put(`${A}/ports/${portOf('PP-A', '1')}`, { office_id: id.office, outlet_label: 'K-01' })).status, 200);
  assert.equal((await link(['SW-01', 'Gi1/0/1'], 'front', ['PP-A', '1'], 'front', { cable_type: 'Cat6' })).status, 201);
  assert.equal((await portView('SW-01', 'Gi1/0/1')).status, 'office', 'an ordinary data patch stays blue');
  assert.equal((await link(['SW-01', 'Gi1/0/2'], 'front', ['PP-A', '2'], 'front', { cable_type: 'Telephone' })).status, 201);
  assert.equal((await portView('SW-01', 'Gi1/0/2')).status, 'voice');
});

test('bulk outlets can mark a run as telephone, or leave the service as it is', async () => {
  const base = { start_port: '1', count: 4, office_id: id.office, label_prefix: 'T-', label_start: 1, label_pad: 2, rear_cable_type: 'Telephone' };
  assert.equal((await c.operator.post(`${A}/devices/${id['PP-T']}/outlets/bulk`, { ...base, service: 'fax', dry_run: true })).status, 400);
  const keep = await c.operator.post(`${A}/devices/${id['PP-T']}/outlets/bulk`, base);
  assert.equal(keep.status, 200); assert.equal((await portView('PP-T', '2')).service, 'voice', 'left as the template made it');
  const set = await c.operator.post(`${A}/devices/${id['PP-A']}/outlets/bulk`, { ...base, start_port: '9', count: 3, service: 'voice', label_prefix: 'P-' });
  assert.equal(set.status, 200); for (const n of ['9', '10', '11']) assert.equal((await portView('PP-A', n)).service, 'voice');
  assert.equal((await portView('PP-A', '12')).service, 'data');
  const back = await c.operator.post(`${A}/devices/${id['PP-A']}/outlets/bulk`, { ...base, start_port: '9', count: 3, service: 'data', overwrite: true, label_prefix: 'P-' });
  assert.equal(back.status, 200); assert.equal((await portView('PP-A', '9')).service, 'data');
});

test('the office lists which outlets are telephone ones, and the audit log records the service', async () => {
  const off = (await c.viewer.get(`${A}/offices/${id.office}`)).body;
  assert.equal(off.outlets.find((o) => o.outlet_label === 'T-5').service, 'voice');
  assert.equal(off.outlets.find((o) => o.outlet_label === 'K-01').service, 'data');
  assert.ok(JSON.stringify((await c.admin.get('/api/audit-log?limit=300')).body).includes('cabling.outlets.bulk'));
});
