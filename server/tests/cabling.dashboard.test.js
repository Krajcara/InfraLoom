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
const card = async (client = c.viewer) => (await client.get(`${A}/dashboard`)).body;
const layout = async (client) => (await client.get('/api/dashboard/layout')).body.layout;

test('an empty module reports zeros, and every number is there', async () => {
  const d = await card();
  assert.deepEqual(d.counts, { rooms: 0, racks: 0, devices: 0 }); assert.deepEqual(d.switch_ports, { used: 0, total: 0 });
  assert.deepEqual(d.outlets, { total: 0, in_use: 0, free: 0 }); assert.deepEqual(d.telephone, { total: 0, in_use: 0 });
  assert.deepEqual(d.fibre, { trunks: 0, strands: 0, used: 0, nearly_full: [] }); assert.deepEqual(d.warnings, { incomplete: 0, no_place: 0, no_position: 0 });
  assert.equal((await c.anon.get(`${A}/dashboard`)).status, 401);
});

test('setup: rooms, switches, a router, panels, an exchange, fibre', async () => {
  id.r1 = (await mk(c.admin, '/rooms', { name: 'TS-1' })).room.id; id.r2 = (await mk(c.admin, '/rooms', { name: 'TS-2' })).room.id;
  id.rack = (await mk(c.admin, `/rooms/${id.r1}/racks`, { name: 'R1', height_u: 42 })).rack.id;
  id.office = (await mk(c.admin, '/offices', { name: 'Kanc 10' })).office.id;
  const w = { room_id: id.r1 };
  await device('SW-1', 'switch', w, [{ prefix: 'Gi1/0/', start_no: 1, end_no: 8, port_type: 'rj45', speed: '1G' }, { prefix: 'C', start_no: 1, end_no: 1, port_type: 'console' }]);
  await device('SW-2', 'switch', { room_id: id.r2 }, rj('p', 1, 4));
  await device('R-1', 'router', w, rj('ge', 1, 4));
  await device('PP-A', 'patch_panel', w, rj('', 1, 8));
  await device('PBX-1', 'pbx', w, [{ prefix: 'ext', start_no: 1, end_no: 4, port_type: 'rj11', service: 'voice' }]);
  const fibre = (n) => [{ prefix: '', start_no: 1, end_no: n, port_type: 'lc_duplex' }];
  await device('ODF-1', 'fiber_panel', w, fibre(8)); await device('ODF-2', 'fiber_panel', { room_id: id.r2 }, fibre(8));
  await device('LOST-1', 'server', {});
  await device('LOOSE-1', 'server', { room_id: id.r1, rack_id: id.rack });
  const put = (n, body) => c.operator.put(`${A}/ports/${P('PP-A', n)}`, body);
  await put('1', { office_id: id.office, outlet_label: 'K-01' }); await put('2', { office_id: id.office, outlet_label: 'K-02' }); await put('3', { office_id: id.office, outlet_label: 'K-03' });
  await put('4', { office_id: id.office, outlet_label: 'K-04', service: 'voice' }); await put('5', { office_id: id.office, outlet_label: 'K-05', service: 'voice' });
  await put('6', { office_id: id.office });                                                    // an office without a label
  for (const [sw, pn, panel] of [['Gi1/0/1', '1'], ['Gi1/0/2', '2'], ['Gi1/0/6', '6']]) assert.equal((await link(['SW-1', sw], 'front', ['PP-A', pn], 'front')).status, 201);
  assert.equal((await link(['PBX-1', 'ext1'], 'front', ['PP-A', '4'], 'front', { cable_type: 'Telephone' })).status, 201);
  id.t1 = (await mk(c.operator, '/trunks', { name: 'T1', room_a_id: id.r1, room_b_id: id.r2, medium: 'fiber', fiber_type: 'OS2', strand_count: 12 })).trunk.id;
  id.t2 = (await mk(c.operator, '/trunks', { name: 'T2', room_a_id: id.r1, room_b_id: id.r2, medium: 'fiber', fiber_type: 'OS2', strand_count: 4 })).trunk.id;
  for (const [n, t] of [['1', id.t1], ['2', id.t1], ['3', id.t2], ['4', id.t2]]) assert.equal((await link(['ODF-1', n], 'rear', ['ODF-2', n], 'rear', { trunk_cable_id: t })).status, 201);
});

test('the numbers on the card', async () => {
  const d = await card();
  assert.deepEqual(d.counts, { rooms: 2, racks: 1, devices: 9 });
  assert.deepEqual(d.switch_ports, { used: 3, total: 12 }, 'switches only; the console port and the router are not counted');
  assert.deepEqual(d.outlets, { total: 6, in_use: 4, free: 2 }, 'K-01, K-02, K-04 (exchange) and the one without a label are patched; K-03 and K-05 are free');
  assert.deepEqual(d.telephone, { total: 2, in_use: 1 });
  assert.deepEqual(d.fibre, { trunks: 2, strands: 16, used: 8, nearly_full: ['T2'] }, 'T2 has 4 of 4 strands in use, T1 has 4 of 12');
  assert.deepEqual(d.warnings, { incomplete: 1, no_place: 1, no_position: 1 }, 'PP-A 6 is patched without a label; LOST-1 has no place; LOOSE-1 is in a rack without a unit');
  assert.deepEqual(await card(c.operator), d, 'the same for everybody who may use the module');
});

test('the numbers follow the data', async () => {
  assert.equal((await c.operator.put(`${A}/ports/${P('PP-A', '6')}`, { outlet_label: 'K-06' })).status, 200);
  assert.equal((await link(['SW-1', 'Gi1/0/3'], 'front', ['PP-A', '3'], 'front')).status, 201);
  const d = await card();
  assert.equal(d.warnings.incomplete, 0); assert.deepEqual(d.switch_ports, { used: 4, total: 12 }); assert.deepEqual(d.outlets, { total: 6, in_use: 5, free: 1 });
});

test('the card is offered only where the module is on, and a hidden card stays hidden', async () => {
  const before = await layout(c.admin);
  assert.deepEqual(before.find((w) => w.id === 'cabling'), { id: 'cabling', visible: true, title: 'Cabling', phase: 15 }, 'new, visible, at the end');
  assert.equal(before[before.length - 1].id, 'cabling');
  // the user hides it, then the module is switched off and the user reorders the others
  assert.equal((await c.admin.put('/api/dashboard/layout', { layout: before.map((w) => ({ id: w.id, visible: w.id === 'cabling' ? false : w.visible })) })).status, 200);
  assert.equal((await c.admin.put(`${A}/settings`, { enabled: false })).status, 200);
  const off = await layout(c.admin);
  assert.ok(!off.some((w) => w.id === 'cabling'), 'no card while the module is off');
  assert.equal((await c.viewer.get(`${A}/dashboard`)).status, 404);
  assert.equal((await c.admin.put('/api/dashboard/layout', { layout: off.slice().reverse().map((w) => ({ id: w.id, visible: w.visible })) })).status, 200);
  assert.equal((await c.admin.put(`${A}/settings`, { enabled: true })).status, 200);
  const on = await layout(c.admin);
  assert.deepEqual(on.find((w) => w.id === 'cabling'), { id: 'cabling', visible: false, title: 'Cabling', phase: 15 }, 'still hidden, as the user left it');
  assert.equal((await c.admin.put('/api/dashboard/layout', { layout: on.map((w) => ({ id: w.id, visible: true })) })).status, 200);
  assert.equal((await layout(c.viewer)).find((w) => w.id === 'cabling').visible, true, 'another user is not affected by the first one');
});
