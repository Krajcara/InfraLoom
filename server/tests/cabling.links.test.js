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
const portOf = (device, name) => port[`${device}/${name}`];
const link = (a, sa, b, sb, extra = {}) => c.operator.post(`${A}/links`, { port_a_id: portOf(...a), side_a: sa, port_b_id: portOf(...b), side_b: sb, ...extra });
const shape = (t) => t.steps.map((s) => (s.type === 'port' ? `${s.device_name}:${s.port_name}` : s.type === 'outlet' ? `outlet ${s.label}` : s.type));
const statusOf = async (device, name) => (await c.viewer.get(`${A}/devices/${id[device]}`)).body.device.ports.find((p) => p.name === name).status;
const rj = (prefix, a, b) => [{ prefix, start_no: a, end_no: b, port_type: 'rj45', speed: '1G' }];
const lc = (n) => [{ prefix: '', start_no: 1, end_no: n, port_type: 'lc_duplex', connector: 'LC' }];

test('setup: two rooms, an office, and the devices of the design', async () => {
  id.r1 = (await mk(c.admin, '/rooms', { name: 'TS-1', location: 'Ground floor' })).room.id;
  id.r2 = (await mk(c.admin, '/rooms', { name: 'TS-2', location: 'First floor' })).room.id;
  id.r3 = (await mk(c.admin, '/rooms', { name: 'TS-3' })).room.id;
  id.office = (await mk(c.admin, '/offices', { name: 'Office 02' })).office.id;
  const sw = [{ prefix: 'Gi1/0/', start_no: 1, end_no: 24, port_type: 'rj45', speed: '1G', poe: true }, { prefix: 'Te1/1/', start_no: 1, end_no: 4, port_type: 'sfp_plus', speed: '10G' }];
  const defs = [['SW-01', 'switch', id.r1, sw], ['PP-A', 'patch_panel', id.r1, rj('', 1, 24)], ['ODF-1', 'fiber_panel', id.r1, lc(6)], ['HV-01', 'hypervisor', id.r1, rj('eth', 0, 0)],
    ['ODF-2', 'fiber_panel', id.r2, lc(6)], ['SW-10', 'switch', id.r2, [{ prefix: 'S', start_no: 1, end_no: 2, port_type: 'sfp_plus', speed: '10G' }]], ['ODF-3', 'fiber_panel', id.r3, lc(2)],
    ['PA', 'patch_panel', id.r1, rj('', 1, 2)], ['PB', 'patch_panel', id.r1, rj('', 1, 2)]];
  for (const [name, type, room, groups] of defs) {
    const d = (await mk(c.admin, '/devices', { name, device_type: type, room_id: room, groups })).device;
    id[name] = d.id; for (const p of d.ports) port[`${name}/${p.name}`] = p.id;
  }
  const pc = (await mk(c.admin, '/devices', { name: 'PC-K02-A', device_type: 'desktop', office_id: id.office, groups: rj('eth', 0, 0) })).device;
  id['PC-K02-A'] = pc.id; port['PC-K02-A/eth0'] = pc.ports[0].id;
});

test('wall outlets and the permanent cable belong to patch-panel ports only', async () => {
  const bad = await c.operator.put(`${A}/ports/${portOf('SW-01', 'Gi1/0/1')}`, { office_id: id.office, outlet_label: 'X' });
  assert.equal(bad.status, 400); assert.match(bad.body.error, /only be recorded on patch-panel ports/);
  assert.equal((await c.operator.put(`${A}/ports/${portOf('PP-A', '3')}`, { rear_cable_type: 'Cat99' })).status, 400);
  assert.equal((await c.operator.put(`${A}/ports/${portOf('PP-A', '3')}`, { rear_length_m: 0 })).status, 400);
  const ok = await c.operator.put(`${A}/ports/${portOf('PP-A', '3')}`, { office_id: id.office, outlet_label: 'K-02/A', rear_cable_type: 'Cat6', rear_length_m: 12 });
  assert.equal(ok.status, 200); assert.equal(ok.body.port.rear_cable_type, 'Cat6'); assert.equal(ok.body.port.status, 'outlet', 'an outlet without a cord is the dashed state');
  await mk(c.operator, '/ports/' + portOf('PP-A', '1'), undefined).catch(() => {});
  assert.equal((await c.operator.put(`${A}/ports/${portOf('PP-A', '1')}`, { office_id: id.office, outlet_label: 'K-01' })).status, 200);
});

test('trunk cables: validation, uniqueness, roles', async () => {
  const bad = [
    [{ name: 'x', room_a_id: id.r1, room_b_id: id.r1, medium: 'fiber', strand_count: 12 }, /two different rooms/],
    [{ name: 'x', room_a_id: id.r1, room_b_id: id.r2, medium: 'wireless', strand_count: 12 }, /fibre or copper/],
    [{ name: 'x', room_a_id: id.r1, room_b_id: id.r2, medium: 'fiber', fiber_type: 'OS9', strand_count: 12 }, /fibre type/],
    [{ name: 'x', room_a_id: id.r1, room_b_id: id.r2, medium: 'fiber' }, /strands is required/],
    [{ name: 'x', room_a_id: id.r1, room_b_id: id.r2, medium: 'fiber', strand_count: 0 }, /whole number/],
    [{ name: 'x', room_a_id: id.r1, room_b_id: id.r2, medium: 'fiber', strand_count: 9999 }, /whole number/],
    [{ name: 'x', room_a_id: id.r1, room_b_id: 9999, medium: 'fiber', strand_count: 12 }, /Room not found/],
    [{ name: 'x', room_a_id: id.r1, room_b_id: id.r2, medium: 'fiber', strand_count: 12, length_m: -5 }, /Length/],
  ];
  for (const [b, re] of bad) { const r = await c.operator.post(`${A}/trunks`, b); assert.ok([400, 404].includes(r.status), JSON.stringify(b)); assert.match(r.body.error, re); }
  assert.equal((await c.viewer.post(`${A}/trunks`, { name: 'v', room_a_id: id.r1, room_b_id: id.r2, medium: 'fiber', strand_count: 12 })).status, 403);
  const t = await mk(c.operator, '/trunks', { name: 'TS-1 to TS-2', room_a_id: id.r1, room_b_id: id.r2, medium: 'fiber', fiber_type: 'OS2', strand_count: 12, length_m: 85 });
  id.trunk = t.trunk.id; assert.equal(t.trunk.used_strands, 0); assert.equal(t.trunk.room_a_name, 'TS-1');
  assert.equal((await c.operator.post(`${A}/trunks`, { name: 'ts-1 to ts-2', room_a_id: id.r1, room_b_id: id.r3, medium: 'fiber', strand_count: 4 })).status, 409);
  id.trunk13 = (await mk(c.operator, '/trunks', { name: 'TS-1 to TS-3', room_a_id: id.r1, room_b_id: id.r3, medium: 'copper', strand_count: 4 })).trunk.id;
});

test('links: the design example, step by step, with the rules that protect it', async () => {
  const first = await link(['SW-01', 'Gi1/0/3'], 'front', ['PP-A', '3'], 'front', { cable_type: 'Cat6', color: 'blue', length_m: 1 });
  assert.equal(first.status, 201); assert.equal(first.body.link.kind, 'patch'); assert.equal(first.body.link.device_a_name, 'SW-01'); assert.equal(first.body.link.port_b_name, '3');
  assert.deepEqual(shape(first.body.trace), ['SW-01:Gi1/0/3', 'link', 'PP-A:3', 'installation', 'outlet K-02/A'], 'the answer already carries the new trace');
  assert.deepEqual(first.body.trace.ends, ['device', 'outlet']);

  const again = await link(['SW-01', 'Gi1/0/3'], 'front', ['HV-01', 'eth0'], 'front');
  assert.equal(again.status, 409); assert.match(again.body.error, /SW-01 Gi1\/0\/3 is already connected to PP-A 3/);
  const reversed = await link(['HV-01', 'eth0'], 'front', ['SW-01', 'Gi1/0/3'], 'front');
  assert.equal(reversed.status, 409, 'the same side is taken whichever end it is on');
  const front2 = await link(['PP-A', '3'], 'front', ['HV-01', 'eth0'], 'front');
  assert.equal(front2.status, 409); assert.match(front2.body.error, /PP-A 3 \(front\) is already connected to SW-01 Gi1\/0\/3/);

  assert.equal((await link(['SW-01', 'Gi1/0/5'], 'front', ['SW-01', 'Gi1/0/5'], 'front')).status, 400);
  const noRear = await link(['SW-01', 'Gi1/0/5'], 'rear', ['PP-A', '5'], 'front');
  assert.equal(noRear.status, 400); assert.match(noRear.body.error, /not a patch or fibre panel/);
  assert.equal((await link(['SW-01', 'Gi1/0/5'], 'sideways', ['PP-A', '5'], 'front')).status, 400);
  const mismatch = await link(['PP-A', '5'], 'rear', ['PP-A', '6'], 'rear', { kind: 'patch' });
  assert.equal(mismatch.status, 400); assert.match(mismatch.body.error, /permanent installation/);
  const noOutlet = await link(['PP-A', '2'], 'rear', ['PC-K02-A', 'eth0'], 'front');
  assert.equal(noOutlet.status, 400); assert.match(noOutlet.body.error, /record the office and outlet on PP-A 2 \(rear\) first/);
  const toPanel = await link(['PP-A', '3'], 'rear', ['PP-A', '1'], 'front');
  assert.equal(toPanel.status, 400); assert.match(toPanel.body.error, /goes to a device, not to another panel/);
  assert.equal((await c.viewer.post(`${A}/links`, { port_a_id: portOf('SW-01', 'Gi1/0/6'), port_b_id: portOf('PP-A', '6') })).status, 403);
  assert.equal((await link(['SW-01', 'Gi1/0/6'], 'front', ['PP-A', '9999'], 'front')).status, 404);

  const cord = await link(['PP-A', '3'], 'rear', ['PC-K02-A', 'eth0'], 'front', { cable_type: 'Cat6', length_m: 3 });
  assert.equal(cord.status, 201, JSON.stringify(cord.body));
  assert.deepEqual(shape(cord.body.trace), ['SW-01:Gi1/0/3', 'link', 'PP-A:3', 'installation', 'outlet K-02/A', 'link', 'PC-K02-A:eth0']);
  assert.equal(cord.body.trace.complete, true);
  id.cord = cord.body.link.id; id.patch1 = first.body.link.id;

  const fromPc = (await c.viewer.get(`${A}/ports/${portOf('PC-K02-A', 'eth0')}/trace`)).body.trace;
  assert.deepEqual(shape(fromPc), shape(cord.body.trace).slice().reverse());
  const fromPanel = (await c.viewer.get(`${A}/ports/${portOf('PP-A', '3')}/trace`)).body.trace;
  assert.deepEqual(shape(fromPanel), shape(cord.body.trace), 'from the panel in the middle it reads the same');
  assert.equal(fromPanel.steps[3].cable_type, 'Cat6'); assert.equal(fromPanel.steps[3].length_m, 12); assert.equal(fromPanel.steps[1].color, 'blue');
  assert.equal((await c.viewer.get(`${A}/ports/999999/trace`)).status, 404);
});

test('colours: office, direct to device, outlet without cord, free', async () => {
  assert.equal((await link(['SW-01', 'Gi1/0/17'], 'front', ['HV-01', 'eth0'], 'front')).status, 201);
  assert.equal(await statusOf('SW-01', 'Gi1/0/3'), 'office'); assert.equal(await statusOf('PP-A', '3'), 'office'); assert.equal(await statusOf('PC-K02-A', 'eth0'), 'office');
  assert.equal(await statusOf('SW-01', 'Gi1/0/17'), 'device'); assert.equal(await statusOf('HV-01', 'eth0'), 'device');
  assert.equal(await statusOf('PP-A', '1'), 'outlet'); assert.equal(await statusOf('PP-A', '2'), 'free'); assert.equal(await statusOf('SW-01', 'Gi1/0/24'), 'free');
  const sw = (await c.viewer.get(`${A}/devices/${id['SW-01']}`)).body.device.ports.find((p) => p.name === 'Gi1/0/3');
  assert.equal(sw.connections.front.other_device_name, 'PP-A'); assert.equal(sw.connections.front.other_port_name, '3'); assert.equal(sw.connections.rear, null);
});

test('permanent installation and trunks: rules, automatic strands, conflicts', async () => {
  const noTrunk = await link(['ODF-1', '1'], 'rear', ['ODF-2', '1'], 'rear');
  assert.equal(noTrunk.status, 400); assert.match(noTrunk.body.error, /different rooms: choose the trunk cable/);
  const wrongRooms = await link(['ODF-1', '1'], 'rear', ['ODF-2', '1'], 'rear', { trunk_cable_id: id.trunk13 });
  assert.equal(wrongRooms.status, 400); assert.match(wrongRooms.body.error, /one panel must be in each of those rooms/);
  const copper = await link(['ODF-1', '1'], 'rear', ['ODF-3', '1'], 'rear', { trunk_cable_id: id.trunk13 });
  assert.equal(copper.status, 400); assert.match(copper.body.error, /copper trunk joins RJ45/);
  const patchOnTrunk = await link(['ODF-1', '1'], 'front', ['ODF-2', '1'], 'front', { trunk_cable_id: id.trunk });
  assert.equal(patchOnTrunk.status, 400); assert.match(patchOnTrunk.body.error, /Only a permanent installation/);

  const l1 = await link(['ODF-1', '1'], 'rear', ['ODF-2', '1'], 'rear', { trunk_cable_id: id.trunk, cable_type: 'OS2', length_m: 85 });
  assert.equal(l1.status, 201, JSON.stringify(l1.body)); assert.equal(l1.body.link.kind, 'permanent'); assert.equal(l1.body.link.strands, '1-2'); assert.equal(l1.body.link.trunk_name, 'TS-1 to TS-2');
  const l2 = await link(['ODF-1', '2'], 'rear', ['ODF-2', '2'], 'rear', { trunk_cable_id: id.trunk });
  assert.equal(l2.body.link.strands, '3-4', 'the next free pair is taken');
  for (const [s, status, re] of [['1-2', 409, /already used/], ['2-3', 409, /already used/], ['13-14', 400, /does not exist/], ['5', 400, /uses 2 strands/], ['5-7', 400, /uses 2 strands/], ['abc', 400, /Strands look like/]]) {
    const r = await link(['ODF-1', '3'], 'rear', ['ODF-2', '3'], 'rear', { trunk_cable_id: id.trunk, strands: s });
    assert.equal(r.status, status, s); assert.match(r.body.error, re, s);
  }
  const l3 = await link(['ODF-1', '3'], 'rear', ['ODF-2', '3'], 'rear', { trunk_cable_id: id.trunk, strands: '9-10' });
  assert.equal(l3.status, 201); assert.equal(l3.body.link.strands, '9-10'); id.l1 = l1.body.link.id; id.l3 = l3.body.link.id;
  const t = (await c.viewer.get(`${A}/trunks/${id.trunk}`)).body.trunk;
  assert.equal(t.used_strands, 6); assert.deepEqual(t.strand_numbers, [1, 2, 3, 4, 9, 10]); assert.equal(t.links.length, 3);
  assert.ok(t.links.some((x) => x.strands === '1-2' && x.device_a_name === 'ODF-1' && x.device_b_name === 'ODF-2'));
});

test('the fibre path between the rooms, and what it does to the colours and the KPIs', async () => {
  assert.equal((await link(['SW-01', 'Te1/1/1'], 'front', ['ODF-1', '1'], 'front')).status, 201);
  const far = await link(['ODF-2', '1'], 'front', ['SW-10', 'S1'], 'front');
  assert.equal(far.status, 201);
  // the answer to a new link carries the trace of its first port (ODF-2, whose room side is TS-2), so it reads from SW-10 to SW-01
  assert.deepEqual(shape(far.body.trace), ['SW-10:S1', 'link', 'ODF-2:1', 'link', 'ODF-1:1', 'link', 'SW-01:Te1/1/1']);
  const t = (await c.viewer.get(`${A}/ports/${portOf('SW-01', 'Te1/1/1')}/trace`)).body.trace;
  assert.deepEqual(shape(t), ['SW-01:Te1/1/1', 'link', 'ODF-1:1', 'link', 'ODF-2:1', 'link', 'SW-10:S1']);
  assert.equal(t.steps[3].trunk.name, 'TS-1 to TS-2'); assert.equal(t.steps[3].strands, '1-2'); assert.equal(t.steps[4].room_name, 'TS-2'); assert.equal(t.steps[6].room_name, 'TS-2');
  assert.equal(await statusOf('SW-01', 'Te1/1/1'), 'fiber'); assert.equal(await statusOf('ODF-1', '1'), 'fiber'); assert.equal(await statusOf('SW-10', 'S1'), 'fiber');
  const room = (await c.viewer.get(`${A}/rooms/${id.r1}`)).body;
  assert.equal(room.summary.fiber_strands, 12); assert.equal(room.summary.fiber_strands_used, 6, 'only fibre trunks count, and only the strands in use');
  assert.equal(room.summary.switch_ports_used, 3, 'Gi1/0/3, Gi1/0/17 and Te1/1/1 on SW-01');
  assert.equal(room.summary.outlets_active, 1); assert.equal(room.summary.outlets_spare, 1);
  assert.equal(room.trunks.length, 2); const tr = room.trunks.find((x) => x.name === 'TS-1 to TS-2'); assert.equal(tr.other_room_name, 'TS-2'); assert.equal(tr.links.length, 3);
  const r2 = (await c.viewer.get(`${A}/rooms/${id.r2}`)).body;
  assert.equal(r2.trunks[0].other_room_name, 'TS-1'); assert.equal(r2.summary.fiber_strands_used, 6);
});

test('a ring of cables does not hang the server', async () => {
  assert.equal((await link(['PA', '1'], 'front', ['PB', '1'], 'front')).status, 201);
  const ring = await link(['PA', '1'], 'rear', ['PB', '1'], 'rear');
  assert.equal(ring.status, 201);
  const t = ring.body.trace; assert.equal(t.loop, true); assert.equal(t.complete, false);
  assert.equal((await c.viewer.get(`${A}/ports/${portOf('PA', '1')}/trace`)).body.trace.loop, true);
});

test('editing a link changes the cable, not the ends; strands are re-checked', async () => {
  const ok = await c.operator.put(`${A}/links/${id.patch1}`, { cable_type: 'Cat6a', color: 'red', length_m: 2.5, notes: 'moved from port 4' });
  assert.equal(ok.status, 200); assert.equal(ok.body.link.cable_type, 'Cat6a'); assert.equal(ok.body.link.length_m, 2.5); assert.equal(ok.body.trace.steps[1].color, 'red');
  assert.equal((await c.operator.put(`${A}/links/${id.patch1}`, { cable_type: 'Cat99' })).status, 400);
  assert.equal((await c.operator.put(`${A}/links/${id.patch1}`, { port_b_id: portOf('PP-A', '4') })).status, 400);
  assert.equal((await c.operator.put(`${A}/links/${id.patch1}`, { length_m: 0 })).status, 400);
  assert.equal((await c.viewer.put(`${A}/links/${id.patch1}`, { color: 'x' })).status, 403);
  const taken = await c.operator.put(`${A}/links/${id.l3}`, { strands: '3-4' });
  assert.equal(taken.status, 409); assert.match(taken.body.error, /already used/);
  const moved = await c.operator.put(`${A}/links/${id.l3}`, { strands: '11-12' });
  assert.equal(moved.status, 200); assert.equal(moved.body.link.strands, '11-12');
  const same = await c.operator.put(`${A}/links/${id.l3}`, { strands: '11-12', color: 'yellow' });
  assert.equal(same.status, 200, 'keeping its own strands is not a conflict');
  const off = await c.operator.put(`${A}/links/${id.l3}`, { trunk_cable_id: null });
  assert.equal(off.status, 400); assert.match(off.body.error, /different rooms/);
});

test('lists: links by room, device and trunk', async () => {
  const byTrunk = (await c.viewer.get(`${A}/links?trunk_id=${id.trunk}`)).body.links;
  assert.equal(byTrunk.length, 3);
  const byDevice = (await c.viewer.get(`${A}/links?device_id=${id['PP-A']}`)).body.links;
  assert.equal(byDevice.length, 2);
  assert.ok((await c.viewer.get(`${A}/links?room_id=${id.r2}`)).body.links.length >= 4);
});

test('trunks: shrinking, moving and deleting are refused while links use them', async () => {
  const shrink = await c.operator.put(`${A}/trunks/${id.trunk}`, { strand_count: 8 });
  assert.equal(shrink.status, 409); assert.match(shrink.body.error, /Strand 12 is in use/);
  assert.equal((await c.operator.put(`${A}/trunks/${id.trunk}`, { strand_count: 24, length_m: 90 })).body.trunk.strand_count, 24);
  assert.equal((await c.operator.put(`${A}/trunks/${id.trunk}`, { room_b_id: id.r3 })).status, 409);
  assert.equal((await c.operator.put(`${A}/trunks/${id.trunk}`, { medium: 'copper' })).status, 409);
  const del = await c.admin.del(`${A}/trunks/${id.trunk}`);
  assert.equal(del.status, 409); assert.match(del.body.error, /3 links use this trunk/);
  assert.equal((await c.operator.del(`${A}/trunks/${id.trunk13}`)).status, 403, 'only an administrator deletes a trunk');
  assert.equal((await c.admin.del(`${A}/trunks/${id.trunk13}`)).status, 200);
});

test('unplugging: an operator may, a viewer may not; colours and traces follow', async () => {
  assert.equal((await c.viewer.del(`${A}/links/${id.cord}`)).status, 403);
  assert.equal((await c.operator.del(`${A}/links/${id.cord}`)).status, 200);
  assert.equal(await statusOf('PC-K02-A', 'eth0'), 'free');
  assert.deepEqual(shape((await c.viewer.get(`${A}/ports/${portOf('SW-01', 'Gi1/0/3')}/trace`)).body.trace), ['SW-01:Gi1/0/3', 'link', 'PP-A:3', 'installation', 'outlet K-02/A']);
  assert.equal((await c.operator.del(`${A}/links/${id.patch1}`)).status, 200);
  assert.equal(await statusOf('SW-01', 'Gi1/0/3'), 'free'); assert.equal(await statusOf('PP-A', '3'), 'outlet', 'the outlet is recorded again without a cord');
  assert.equal((await c.operator.del(`${A}/links/${id.patch1}`)).status, 404);
  assert.equal((await link(['SW-01', 'Gi1/0/3'], 'front', ['PP-A', '3'], 'front')).status, 201, 'and the freed sides can be used again');
});

test('deleting a device or a port takes its links with it', async () => {
  const before = (await c.viewer.get(`${A}/links`)).body.links.length;
  assert.equal((await c.admin.del(`${A}/ports/${portOf('SW-01', 'Gi1/0/17')}`)).status, 200);
  assert.equal(await statusOf('HV-01', 'eth0'), 'free');
  assert.equal((await c.viewer.get(`${A}/links`)).body.links.length, before - 1);
  assert.equal((await c.admin.del(`${A}/devices/${id['ODF-2']}`)).status, 200);
  const trunk = (await c.viewer.get(`${A}/trunks/${id.trunk}`)).body.trunk;
  assert.equal(trunk.used_strands, 0, 'the strands of its links are free again');
  assert.equal(await statusOf('SW-01', 'Te1/1/1'), 'fiber', 'still optics: it is patched to a fibre panel, whose far end is gone');
  assert.deepEqual((await c.viewer.get(`${A}/ports/${portOf('SW-01', 'Te1/1/1')}/trace`)).body.trace.ends, ['device', 'open']);
});

test('audit log: links and trunks are recorded', async () => {
  const log = JSON.stringify((await c.admin.get('/api/audit-log?limit=500')).body);
  for (const a of ['cabling.link.create', 'cabling.link.update', 'cabling.link.delete', 'cabling.trunk.create', 'cabling.trunk.update', 'cabling.trunk.delete']) assert.ok(log.includes(a), a);
});
