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
const rj = (prefix, a, b) => [{ prefix, start_no: a, end_no: b, port_type: 'rj45', speed: '1G' }];
const device = async (name, type, where, groups) => { const d = (await mk(c.admin, '/devices', { name, device_type: type, groups, ...where })).device; id[name] = d.id; for (const p of d.ports) port[`${name}/${p.name}`] = p.id; return d; };
const P = (d, n) => port[`${d}/${n}`];
const link = (a, sa, b, sb, extra = {}) => c.operator.post(`${A}/links`, { port_a_id: P(...a), side_a: sa, port_b_id: P(...b), side_b: sb, ...extra });
const outlet = (n, body) => c.operator.put(`${A}/ports/${P('PP-A', n)}`, body);
const offOf = async (o) => (await c.viewer.get(`${A}/offices/${id[o]}`)).body;

test('setup: offices, a panel, a switch, a telephone exchange and two PCs', async () => {
  id.r = (await mk(c.admin, '/rooms', { name: 'TS-1' })).room.id;
  for (const n of ['Kanc 10', 'Kanc 11', 'Kanc 12']) id[n] = (await mk(c.admin, '/offices', { name: n })).office.id;
  const w = { room_id: id.r };
  await device('PP-A', 'patch_panel', w, rj('', 1, 12));
  await device('SW-1', 'switch', w, rj('Gi1/0/', 1, 8));
  await device('PBX-1', 'pbx', w, [{ prefix: 'ext', start_no: 1, end_no: 4, port_type: 'rj11', service: 'voice' }]);
  await device('PC-1', 'desktop', { office_id: id['Kanc 10'] }, rj('eth', 0, 0));
  await device('PC-2', 'desktop', { office_id: id['Kanc 10'] }, rj('eth', 0, 0));
});

test('each outlet says if it is in use or free, what is patched to it and what is plugged in, and whether it is LAN or telephone', async () => {
  const k10 = id['Kanc 10'];
  assert.equal((await outlet('1', { office_id: k10, outlet_label: 'K-01' })).status, 200);                                   // LAN, patched, PC-1 plugged in
  assert.equal((await outlet('2', { office_id: k10, outlet_label: 'K-02' })).status, 200);                                   // LAN, patched, nothing recorded behind it
  assert.equal((await outlet('3', { office_id: k10, outlet_label: 'K-03' })).status, 200);                                   // free
  assert.equal((await outlet('4', { office_id: k10, outlet_label: 'K-04', service: 'voice' })).status, 200);                // telephone, patched to the exchange
  assert.equal((await outlet('5', { office_id: k10, outlet_label: 'K-05', service: 'voice' })).status, 200);                // telephone, free
  assert.equal((await outlet('6', { office_id: k10, outlet_label: 'K-06' })).status, 200);                                   // PC-2 plugged in, but not patched on the panel
  assert.equal((await outlet('8', { office_id: k10 })).status, 200);                                                         // office without a label
  assert.equal((await link(['SW-1', 'Gi1/0/1'], 'front', ['PP-A', '1'], 'front')).status, 201);
  assert.equal((await link(['PP-A', '1'], 'rear', ['PC-1', 'eth0'], 'front', { cable_type: 'Cat6' })).status, 201);
  assert.equal((await link(['SW-1', 'Gi1/0/2'], 'front', ['PP-A', '2'], 'front')).status, 201);
  assert.equal((await link(['PBX-1', 'ext1'], 'front', ['PP-A', '4'], 'front', { cable_type: 'Telephone' })).status, 201);
  assert.equal((await link(['PP-A', '6'], 'rear', ['PC-2', 'eth0'], 'front')).status, 201);

  const o = await offOf('Kanc 10');
  const by = Object.fromEntries(o.outlets.map((x) => [x.outlet_label || `port ${x.port_name}`, x]));
  assert.deepEqual(Object.keys(by), ['K-01', 'K-02', 'K-03', 'K-04', 'K-05', 'K-06', 'port 8'], 'by label, an outlet without one last');

  assert.equal(by['K-01'].in_use, true); assert.deepEqual(by['K-01'].patched_to, { device_id: id['SW-1'], device_name: 'SW-1', port_name: 'Gi1/0/1' }); assert.equal(by['K-01'].at_outlet.device_name, 'PC-1'); assert.equal(by['K-01'].kind, 'lan');
  assert.equal(by['K-02'].in_use, true); assert.equal(by['K-02'].at_outlet, null, 'patched, nobody recorded behind it');
  assert.equal(by['K-03'].in_use, false); assert.equal(by['K-03'].patched_to, null); assert.equal(by['K-03'].at_outlet, null);
  assert.equal(by['K-04'].in_use, true); assert.equal(by['K-04'].kind, 'voice'); assert.equal(by['K-04'].patched_to.device_name, 'PBX-1');
  assert.equal(by['K-05'].in_use, false); assert.equal(by['K-05'].kind, 'voice', 'a telephone outlet is telephone even when free');
  assert.equal(by['K-06'].in_use, false); assert.equal(by['K-06'].at_outlet.device_name, 'PC-2', 'a device is recorded here, but the outlet is not patched');
  assert.equal(by['port 8'].outlet_label, null); assert.deepEqual(by['port 8'].gaps, ['outlet label']); assert.equal(by['port 8'].in_use, false);
  assert.deepEqual(o.summary, { total: 7, in_use: 3, free: 4, lan: 5, voice: 2, voice_in_use: 1, lan_in_use: 2 });
  // what was there before is still there
  assert.equal(by['K-01'].device_name, 'PP-A'); assert.equal(by['K-01'].room_name, 'TS-1'); assert.equal(by['K-01'].service, 'data'); assert.ok(by['K-01'].port_id);
});

test('a telephone cable or exchange on the path makes an outlet telephone even if the port says data; labels sort naturally', async () => {
  const k11 = id['Kanc 11'], k12 = id['Kanc 12'];
  assert.equal((await outlet('7', { office_id: k11, outlet_label: 'K-7' })).status, 200);
  assert.equal((await link(['SW-1', 'Gi1/0/7'], 'front', ['PP-A', '7'], 'front', { cable_type: 'Telephone' })).status, 201);
  const a = (await offOf('Kanc 11')).outlets[0];
  assert.equal(a.service, 'data'); assert.equal(a.kind, 'voice', 'the line is a telephone line'); assert.equal(a.in_use, true);
  for (const [n, l] of [['9', 'K-10'], ['10', 'K-2'], ['11', 'K-9']]) assert.equal((await outlet(n, { office_id: k12, outlet_label: l })).status, 200);
  assert.deepEqual((await offOf('Kanc 12')).outlets.map((x) => x.outlet_label), ['K-2', 'K-9', 'K-10'], 'K-2, K-9, K-10 — not K-10, K-2, K-9');
});

test('the list of offices carries the counts, and one call gives every outlet for an export', async () => {
  const list = (await c.viewer.get(`${A}/offices`)).body.offices;
  const k10 = list.find((o) => o.name === 'Kanc 10');
  assert.deepEqual([k10.outlets_in_use, k10.outlets_free, k10.outlets_lan, k10.outlets_voice], [3, 4, 5, 2]); assert.equal(k10.outlets, 7, 'the old count is unchanged');
  const k11 = list.find((o) => o.name === 'Kanc 11'); assert.deepEqual([k11.outlets_in_use, k11.outlets_free, k11.outlets_voice], [1, 0, 1]);
  const all = (await c.viewer.get(`${A}/reports/outlets`)).body;
  assert.equal(all.outlets.length, 7 + 1 + 3); assert.deepEqual(all.summary, { total: 11, in_use: 4, free: 7, lan: 8, voice: 3, voice_in_use: 2, lan_in_use: 2 });
  assert.equal((await c.viewer.get(`${A}/reports/outlets?office_id=${id['Kanc 12']}`)).body.outlets.length, 3);
  assert.equal((await c.anon.get(`${A}/reports/outlets`)).status, 401);
});

test('patching a free outlet turns it into one in use; unplugging does the reverse', async () => {
  assert.equal((await offOf('Kanc 10')).summary.free, 4);
  const l = await link(['SW-1', 'Gi1/0/3'], 'front', ['PP-A', '3'], 'front');
  assert.equal(l.status, 201);
  const after = await offOf('Kanc 10'); assert.equal(after.summary.in_use, 4); assert.equal(after.summary.free, 3);
  assert.equal((await c.operator.del(`${A}/links/${l.body.link.id}`)).status, 200);
  assert.equal((await offOf('Kanc 10')).summary.free, 4);
});
