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
const portOf = (d, n) => port[`${d}/${n}`];
const link = (a, b, extra = {}) => c.operator.post(`${A}/links`, { port_a_id: portOf(...a), side_a: extra.sa || 'front', port_b_id: portOf(...b), side_b: extra.sb || 'front' });
const status = async (d, n) => (await c.viewer.get(`${A}/devices/${id[d]}`)).body.device.ports.find((p) => p.name === n).status;
const setOutlet = (d, n, body) => c.operator.put(`${A}/ports/${portOf(d, n)}`, body);

test('setup: two rooms, an office, switches, a router, a firewall, patch panels', async () => {
  id.r1 = (await mk(c.admin, '/rooms', { name: 'TS-1' })).room.id; id.r2 = (await mk(c.admin, '/rooms', { name: 'TS-2' })).room.id;
  id.rack = (await mk(c.admin, `/rooms/${id.r1}/racks`, { name: 'R1', height_u: 42 })).rack.id;
  id.office = (await mk(c.admin, '/offices', { name: 'Kanc 10' })).office.id;
  const w = { room_id: id.r1 };
  await device('SW-01', 'switch', w, [{ prefix: 'Gi1/0/', start_no: 1, end_no: 8, port_type: 'rj45', speed: '1G' }, { prefix: 'C', start_no: 1, end_no: 1, port_type: 'console' }]);
  await device('R-01', 'router', w, rj('ge', 1, 4));
  await device('FW-1', 'firewall', w, rj('wan', 1, 2));
  await device('SW-20', 'switch', { room_id: id.r2 }, rj('p', 1, 4));
  await device('SRV-1', 'hypervisor', w, rj('eth', 0, 1));
  await device('PP-A', 'patch_panel', w, rj('', 1, 8));
  await device('PP-C', 'patch_panel', w, rj('', 1, 2));
  await device('PP-D', 'patch_panel', w, rj('', 1, 2));
  await device('ODF-1', 'fiber_panel', w, [{ prefix: '', start_no: 1, end_no: 2, port_type: 'lc_duplex' }]);
});

test('ports in use and free, per switch, router and firewall (console ports left out)', async () => {
  for (const [a, b] of [['1', 'PP-A:1'], ['2', 'PP-A:2'], ['3', 'PP-A:3'], ['4', 'PP-A:4']]) { const [pd, pn] = b.split(':'); assert.equal((await link(['SW-01', `Gi1/0/${a}`], [pd, pn])).status, 201); }
  assert.equal((await link(['SW-01', 'Gi1/0/8'], ['R-01', 'ge1'])).status, 201);
  const r = (await c.viewer.get(`${A}/reports/ports`)).body;
  assert.deepEqual(r.devices.map((d) => d.name), ['FW-1', 'R-01', 'SW-01', 'SW-20'], 'by room, then by name');
  const sw = r.devices.find((d) => d.name === 'SW-01');
  assert.equal(sw.total, 8, 'the console port is not counted'); assert.equal(sw.console_ports, 1); assert.equal(sw.used, 5); assert.equal(sw.free, 3);
  assert.deepEqual(sw.free_ports.map((p) => p.port), ['Gi1/0/5', 'Gi1/0/6', 'Gi1/0/7']);
  assert.deepEqual(sw.used_ports.map((p) => [p.port, p.leads_to]), [['Gi1/0/1', 'PP-A 1'], ['Gi1/0/2', 'PP-A 2'], ['Gi1/0/3', 'PP-A 3'], ['Gi1/0/4', 'PP-A 4'], ['Gi1/0/8', 'R-01 ge1']]);
  assert.equal(r.devices.find((d) => d.name === 'R-01').used, 1); assert.equal(r.devices.find((d) => d.name === 'FW-1').used, 0); assert.equal(r.devices.find((d) => d.name === 'FW-1').free, 2);
  assert.deepEqual(r.totals, { devices: 4, ports: 8 + 4 + 2 + 4, used: 5 + 1, free: 3 + 3 + 2 + 4 });
  assert.equal(sw.room_name, 'TS-1'); assert.equal(sw.ip_address, null);
});

test('the ports report can be narrowed and refuses nonsense', async () => {
  assert.deepEqual((await c.viewer.get(`${A}/reports/ports?room_id=${id.r2}`)).body.devices.map((d) => d.name), ['SW-20']);
  assert.deepEqual((await c.viewer.get(`${A}/reports/ports?type=hypervisor`)).body.devices.map((d) => d.name), ['SRV-1']);
  assert.deepEqual((await c.viewer.get(`${A}/reports/ports?type=switch&room_id=${id.r1}`)).body.devices.map((d) => d.name), ['SW-01']);
  assert.equal((await c.viewer.get(`${A}/reports/ports?type=toaster`)).status, 400);
  assert.equal((await c.anon.get(`${A}/reports/ports`)).status, 401);
});

test('patch panels: patched ports that miss the office or the outlet label are listed, with what is missing', async () => {
  assert.equal((await setOutlet('PP-A', '1', { office_id: id.office, outlet_label: 'K-01' })).status, 200);   // complete
  assert.equal((await setOutlet('PP-A', '3', { office_id: id.office })).status, 200);                           // office only
  assert.equal((await setOutlet('PP-A', '4', { outlet_label: 'K-04' })).status, 200);                           // label only
  assert.equal((await setOutlet('PP-A', '5', { outlet_label: 'K-05' })).status, 200);                           // half a record, not patched
  const r = (await c.viewer.get(`${A}/reports/checks`)).body;
  assert.deepEqual(r.gaps.map((x) => [x.device_name, x.port_name, x.missing, x.reason]), [
    ['PP-A', '2', ['office', 'outlet label'], 'patched'], ['PP-A', '3', ['outlet label'], 'patched'], ['PP-A', '4', ['office'], 'patched'], ['PP-A', '5', ['office'], 'half-filled'],
  ], 'port 1 is complete and 6-8 are simply unused');
  assert.deepEqual(r.gaps[0].front, { device_name: 'SW-01', port_name: 'Gi1/0/2' }); assert.equal(r.gaps[3].front, null);
  assert.equal(r.gaps[1].office_name, 'Kanc 10'); assert.equal(r.gaps[2].outlet_label, 'K-04'); assert.equal(r.gaps[0].room_name, 'TS-1'); assert.ok(r.gaps[0].port_id);
  assert.equal(r.counts.gaps, 4);
});

test('the colour: the panel port and the switch port that leads to it are both "incomplete"; a complete one stays blue', async () => {
  for (const [d, n] of [['PP-A', '2'], ['SW-01', 'Gi1/0/2'], ['PP-A', '3'], ['SW-01', 'Gi1/0/3'], ['PP-A', '4'], ['SW-01', 'Gi1/0/4'], ['PP-A', '5']]) assert.equal(await status(d, n), 'incomplete', `${d} ${n}`);
  assert.equal(await status('PP-A', '1'), 'office'); assert.equal(await status('SW-01', 'Gi1/0/1'), 'office');
  assert.equal(await status('PP-A', '6'), 'free');
  const room = (await c.viewer.get(`${A}/rooms/${id.r1}`)).body;
  assert.equal(room.summary.incomplete, 4, 'the room says how many panel ports need attention');
  assert.equal(room.summary.switch_ports, 8, 'the console port is not counted in the room either'); assert.equal(room.summary.switch_ports_used, 5);
  const p = room.devices.find((d) => d.name === 'PP-A').ports.find((x) => x.name === '3');
  assert.deepEqual(p.gaps, ['outlet label']);
  const t = (await c.viewer.get(`${A}/ports/${portOf('SW-01', 'Gi1/0/3')}/trace`)).body.trace;
  assert.deepEqual(t.steps.filter((s) => s.type === 'port').map((s) => s.gaps), [[], ['outlet label']], 'and the trace names the step that is missing something');
});

test('a panel rear that runs to another panel, and a fibre panel, are not outlets and are never flagged', async () => {
  assert.equal((await link(['PP-C', '1'], ['PP-D', '1'], { sa: 'rear', sb: 'rear' })).status, 201);
  assert.equal((await link(['SW-01', 'Gi1/0/5'], ['PP-C', '1'])).status, 201);
  assert.equal((await link(['SW-01', 'Gi1/0/6'], ['ODF-1', '1'])).status, 201);
  assert.equal(await status('SW-01', 'Gi1/0/5'), 'device'); assert.equal(await status('SW-01', 'Gi1/0/6'), 'fiber');
  const r = (await c.viewer.get(`${A}/reports/checks`)).body;
  assert.ok(!r.gaps.some((x) => ['PP-C', 'PP-D', 'ODF-1'].includes(x.device_name)));
});

test('fixing the record clears it: the lists, the colours and the room counter follow', async () => {
  assert.equal((await setOutlet('PP-A', '2', { office_id: id.office, outlet_label: 'K-02' })).status, 200);
  assert.equal((await setOutlet('PP-A', '3', { outlet_label: 'K-03' })).status, 200);
  assert.equal(await status('PP-A', '2'), 'office'); assert.equal(await status('SW-01', 'Gi1/0/2'), 'office'); assert.equal(await status('SW-01', 'Gi1/0/3'), 'office');
  const r = (await c.viewer.get(`${A}/reports/checks`)).body;
  assert.deepEqual(r.gaps.map((x) => x.port_name), ['4', '5']);
  assert.equal((await c.viewer.get(`${A}/rooms/${id.r1}`)).body.summary.incomplete, 2);
  assert.equal((await c.viewer.get(`${A}/reports/checks?room_id=${id.r2}`)).body.gaps.length, 0, 'a room filter');
});

test('other checks: devices with no place, and devices in a rack without a position', async () => {
  await mk(c.operator, '/devices', { name: 'LOST-1', device_type: 'server' });
  await mk(c.operator, '/devices', { name: 'LOOSE-1', device_type: 'server', room_id: id.r1, rack_id: id.rack });
  await mk(c.operator, '/devices', { name: 'PLACED-1', device_type: 'server', room_id: id.r1, rack_id: id.rack, rack_position: 10 });
  const r = (await c.viewer.get(`${A}/reports/checks`)).body;
  assert.deepEqual(r.no_place.map((d) => d.name), ['LOST-1']);
  assert.deepEqual(r.no_position.map((d) => [d.name, d.rack_name, d.room_name]), [['LOOSE-1', 'R1', 'TS-1']]);
  assert.deepEqual(r.counts, { gaps: 2, no_place: 1, no_position: 1 });
  const inRoom = (await c.viewer.get(`${A}/reports/checks?room_id=${id.r1}`)).body;
  assert.deepEqual(inRoom.no_place, [], 'devices with no place belong to no room'); assert.equal(inRoom.no_position.length, 1);
});
