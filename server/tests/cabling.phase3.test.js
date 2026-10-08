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
const rj = (prefix, a, b) => [{ prefix, start_no: a, end_no: b, port_type: 'rj45', speed: '1G' }];
const lc = (n) => [{ prefix: '', start_no: 1, end_no: n, port_type: 'lc_duplex', connector: 'LC' }];
const device = async (name, type, where, groups, extra = {}) => {
  const d = (await mk(c.admin, '/devices', { name, device_type: type, groups, ...where, ...extra })).device;
  id[name] = d.id; for (const p of d.ports) port[`${name}/${p.name}`] = p.id; return d;
};
const link = (a, sa, b, sb, extra = {}) => c.operator.post(`${A}/links`, { port_a_id: portOf(...a), side_a: sa, port_b_id: portOf(...b), side_b: sb, ...extra });
const statusOf = async (dev, name) => (await c.viewer.get(`${A}/devices/${id[dev]}`)).body.device.ports.find((p) => p.name === name).status;

test('setup: rooms, a rack, an office and the devices', async () => {
  id.r1 = (await mk(c.admin, '/rooms', { name: 'TS-1' })).room.id;
  id.r2 = (await mk(c.admin, '/rooms', { name: 'TS-2' })).room.id;
  id.r3 = (await mk(c.admin, '/rooms', { name: 'TS-3' })).room.id;
  id.rack = (await mk(c.admin, `/rooms/${id.r1}/racks`, { name: 'R1', height_u: 42 })).rack.id;
  id.office = (await mk(c.admin, '/offices', { name: 'Office 02' })).office.id;
  const where = { room_id: id.r1 };
  await device('SW-01', 'switch', where, [{ prefix: 'Gi1/0/', start_no: 1, end_no: 24, port_type: 'rj45', speed: '1G' }]);
  await device('PP-A', 'patch_panel', where, rj('', 1, 24));
  await device('HV-01', 'hypervisor', where, rj('eth', 0, 0));
  await device('ODF-1', 'fiber_panel', where, lc(6));
  await device('ODF-4', 'fiber_panel', where, lc(6));
  await device('ODF-2', 'fiber_panel', { room_id: id.r2 }, lc(6));
  await device('ODF-3', 'fiber_panel', { room_id: id.r3 }, lc(6));
  await device('PC-K02-A', 'desktop', { office_id: id.office }, rj('eth', 0, 0));
  id.trunk = (await mk(c.operator, '/trunks', { name: 'TS-1 to TS-2', room_a_id: id.r1, room_b_id: id.r2, medium: 'fiber', fiber_type: 'OS2', strand_count: 12 })).trunk.id;
  id.trunk13 = (await mk(c.operator, '/trunks', { name: 'TS-1 to TS-3', room_a_id: id.r1, room_b_id: id.r3, medium: 'fiber', strand_count: 4 })).trunk.id;
});

test('rack units: a device can be taller than 1 U and two devices cannot share a unit', async () => {
  const put = (name, type, pos, h, extra = {}) => c.operator.post(`${A}/devices`, { name, device_type: type, room_id: id.r1, rack_id: id.rack, rack_position: pos, height_u: h, ...extra });
  const a = await put('RU-A', 'server', 10, 2); assert.equal(a.status, 201); assert.equal(a.body.device.height_u, 2); id.ruA = a.body.device.id;
  const clash = await put('RU-B', 'server', 11, 1);
  assert.equal(clash.status, 409); assert.match(clash.body.error, /U11 in R1 is taken by RU-A \(U10–U11\)/);
  assert.equal((await put('RU-B', 'server', 12, 1)).status, 201);
  const tall = await put('RU-C', 'server', 9, 3);
  assert.equal(tall.status, 409); assert.match(tall.body.error, /U9–U11 in R1 is taken by RU-A/);
  assert.equal((await put('RU-D', 'server', 41, 2)).status, 201, 'U41–U42 fits the 42 U rack');
  const over = await put('RU-E', 'server', 42, 2);
  assert.equal(over.status, 400); assert.match(over.body.error, /only 42 U high: a 2 U device at U42 would reach U43/);
  for (const h of [0, 61, 'x']) assert.equal((await put(`RU-H${h}`, 'server', 30, h)).status, 400, `height ${h}`);
  assert.equal((await put('RU-F', 'server', 30, undefined)).body.device.height_u, 1, 'the default is 1 U');
});

test('rack units: moving, editing and shrinking a rack respect the units in use', async () => {
  const moved = await c.operator.put(`${A}/devices/${id.ruA}`, { rack_position: 20 });
  assert.equal(moved.status, 200); assert.equal(moved.body.device.rack_position, 20);
  const back = await c.operator.post(`${A}/devices`, { name: 'RU-G', device_type: 'server', room_id: id.r1, rack_id: id.rack, rack_position: 10, height_u: 2 });
  assert.equal(back.status, 201, 'the units RU-A left are free again');
  const onto = await c.operator.put(`${A}/devices/${back.body.device.id}`, { rack_position: 20 });
  assert.equal(onto.status, 409); assert.match(onto.body.error, /taken by RU-A/);
  assert.equal((await c.operator.put(`${A}/devices/${id.ruA}`, { notes: 'edited' })).status, 200, 'an edit that does not move it is never blocked');
  assert.equal((await c.operator.put(`${A}/devices/${id.ruA}`, { height_u: 3 })).body.device.height_u, 3);
  const stretch = await c.operator.put(`${A}/devices/${id.ruA}`, { height_u: 60 });
  assert.equal(stretch.status, 400, 'it would reach beyond the rack');
  const shrink = await c.operator.put(`${A}/racks/${id.rack}`, { height_u: 20 });
  assert.equal(shrink.status, 400); assert.match(shrink.body.error, /reaches U\d+, above the new height of 20 U/);
  assert.equal((await c.operator.put(`${A}/devices/${id.ruA}`, { rack_id: null, rack_position: 5 })).body.device.rack_position, null, 'out of the rack it has no unit');
});

test('"what is connected": everything that depends on a device, with the wall outlets and the live state', async () => {
  const fg = await c.admin.post('/api/routers', { name: 'FG-100F', brand: 'fortigate', ip_address: '10.10.0.1' });
  const made = await c.operator.post(`${A}/devices/from-linked`, { kind: 'router', id: fg.body.device.id, room_id: id.r1 });
  assert.equal(made.status, 201); id.fg = made.body.device.id;
  const fgPorts = (await mk(c.operator, `/devices/${id.fg}/ports`, { groups: rj('port', 1, 2) })).device.ports; port['FG-100F/port1'] = fgPorts[0].id;
  assert.equal((await c.operator.put(`${A}/ports/${portOf('PP-A', '3')}`, { office_id: id.office, outlet_label: 'K-02/B', rear_cable_type: 'Cat6', rear_length_m: 12 })).status, 200);
  assert.equal((await link(['SW-01', 'Gi1/0/3'], 'front', ['PP-A', '3'], 'front')).status, 201);
  assert.equal((await link(['PP-A', '3'], 'rear', ['PC-K02-A', 'eth0'], 'front')).status, 201);
  assert.equal((await link(['SW-01', 'Gi1/0/17'], 'front', ['HV-01', 'eth0'], 'front')).status, 201);
  assert.equal((await link(['SW-01', 'Gi1/0/24'], 'front', ['FG-100F', 'port1'], 'front')).status, 201);

  const sw = (await c.viewer.get(`${A}/devices/${id['SW-01']}/connected`)).body;
  assert.deepEqual(sw.connected.map((x) => x.name), ['FG-100F', 'HV-01', 'PC-K02-A']);
  const pc = sw.connected.find((x) => x.name === 'PC-K02-A');
  assert.equal(pc.office_name, 'Office 02'); assert.deepEqual(pc.via, [{ port: 'Gi1/0/3', remote_port: 'eth0', outlet: 'K-02/B' }]);
  assert.deepEqual(sw.offices, ['Office 02']); assert.deepEqual(sw.outlets, [{ label: 'K-02/B', office_name: 'Office 02', in_use: true, port: 'Gi1/0/3' }]);
  assert.ok(['up', 'down', 'unknown'].includes(sw.connected.find((x) => x.name === 'FG-100F').live.state), 'a linked device carries its live state');
  assert.equal(sw.connected.find((x) => x.name === 'HV-01').live, null, 'an unlinked one does not');
  assert.equal(typeof sw.down, 'number');

  const fromPc = (await c.viewer.get(`${A}/devices/${id['PC-K02-A']}/connected`)).body;
  assert.deepEqual(fromPc.connected.map((x) => x.name), ['SW-01']);
  const panel = (await c.viewer.get(`${A}/devices/${id['PP-A']}/connected`)).body;
  assert.deepEqual(panel.connected.map((x) => x.name), ['PC-K02-A', 'SW-01'], 'a panel depends on both ends');
  const alone = (await c.viewer.get(`${A}/devices/${id['ODF-1']}/connected`)).body;
  assert.deepEqual(alone.connected, []); assert.deepEqual(alone.outlets, []);
  assert.equal((await c.viewer.get(`${A}/devices/999999/connected`)).status, 404);
});

test('search: where a found port leads, and where a found device sits', async () => {
  const r = (await c.viewer.get(`${A}/search?q=K-02`)).body;
  assert.equal(r.ports.length, 1); assert.equal(r.ports[0].leads_to, 'SW-01 Gi1/0/3'); assert.equal(r.ports[0].status, 'office');
  const d = (await c.viewer.get(`${A}/search?q=RU-D`)).body.devices[0];
  assert.equal(d.rack_name, 'R1'); assert.equal(d.rack_position, 41); assert.equal(d.room_name, 'TS-1');
});

test('bulk connect: a dry run shows every pair, the real run connects them all', async () => {
  const body = { a: { device_id: id['PP-A'], side: 'front', start_port: '5' }, b: { device_id: id['SW-01'], side: 'front', start_port: 'Gi1/0/5' }, count: 4, cable_type: 'Cat6', color: 'blue', length_m: 1 };
  const dry = await c.operator.post(`${A}/links/bulk`, { ...body, dry_run: true });
  assert.equal(dry.status, 200); assert.equal(dry.body.ok_count, 4); assert.equal(dry.body.error_count, 0);
  assert.deepEqual(dry.body.pairs[0], { a: 'PP-A 5 (front)', b: 'SW-01 Gi1/0/5', ok: true, error: null, kind: 'patch', strands: null });
  assert.equal((await c.viewer.get(`${A}/links?device_id=${id['PP-A']}`)).body.links.length, 2, 'a dry run writes nothing');
  const real = await c.operator.post(`${A}/links/bulk`, body);
  assert.equal(real.status, 201); assert.equal(real.body.created, 4);
  const links = (await c.viewer.get(`${A}/links?device_id=${id['PP-A']}`)).body.links;
  assert.equal(links.length, 6); assert.ok(links.filter((l) => l.cable_type === 'Cat6' && l.color === 'blue' && l.length_m === 1).length >= 4);
  assert.equal(await statusOf('PP-A', '8'), 'device'); assert.equal(await statusOf('SW-01', 'Gi1/0/8'), 'device');
  assert.equal((await c.viewer.post(`${A}/links/bulk`, body)).status, 403);
});

test('bulk connect: all or nothing, with the pair named', async () => {
  const body = { a: { device_id: id['PP-A'], side: 'front', start_port: '5' }, b: { device_id: id['SW-01'], side: 'front', start_port: 'Gi1/0/5' }, count: 4 };
  const again = await c.operator.post(`${A}/links/bulk`, body);
  assert.equal(again.status, 409); assert.match(again.body.error, /Pair 1 of 4 \(PP-A 5 \(front\) ↔ SW-01 Gi1\/0\/5\): PP-A 5 \(front\) is already connected to SW-01 Gi1\/0\/5\. Nothing was connected\./);
  // the third pair of 9..12 is blocked, so none of them may be made
  assert.equal((await link(['PP-A', '11'], 'front', ['HV-01', 'eth0'], 'front')).status, 409, 'HV-01 eth0 is already used; use a free one');
  const before = (await c.viewer.get(`${A}/links`)).body.links.length;
  const partial = { a: { device_id: id['PP-A'], side: 'front', start_port: '9' }, b: { device_id: id['SW-01'], side: 'front', start_port: 'Gi1/0/9' }, count: 4 };
  assert.equal((await c.operator.post(`${A}/links/bulk`, { a: { device_id: id['SW-01'], side: 'front', start_port: 'Gi1/0/11' }, b: { device_id: id.fg, side: 'front', start_port: 'port2' }, count: 1 })).status, 201, 'block SW-01 Gi1/0/11 with something else');
  const dry = (await c.operator.post(`${A}/links/bulk`, { ...partial, dry_run: true })).body;
  assert.equal(dry.error_count, 1); assert.equal(dry.pairs[2].ok, false); assert.match(dry.pairs[2].error, /SW-01 Gi1\/0\/11 is already connected to FG-100F port2/);
  const real = await c.operator.post(`${A}/links/bulk`, partial);
  assert.equal(real.status, 409); assert.match(real.body.error, /Pair 3 of 4/);
  assert.equal((await c.viewer.get(`${A}/links`)).body.links.length, before + 1, 'only the blocker is new: pairs 1 and 2 were rolled back');
  assert.equal(await statusOf('PP-A', '9'), 'free');
});

test('bulk connect: input is checked', async () => {
  const ok = { a: { device_id: id['PP-A'], side: 'front', start_port: '13' }, b: { device_id: id['SW-01'], side: 'front', start_port: 'Gi1/0/13' } };
  for (const [b, status, re] of [
    [{ ...ok, count: 0 }, 400, /Count must be a whole number/], [{ ...ok, count: 97 }, 400, /Count must be a whole number/], [{ ...ok }, 400, /Count is required/],
    [{ ...ok, count: 3, a: { ...ok.a, start_port: 'nope' } }, 400, /first port "nope" was not found/],
    [{ ...ok, count: 20, a: { ...ok.a, start_port: '20' } }, 400, /PP-A has only 5 ports from 20 on, but 20 are needed/],
    [{ ...ok, count: 2, a: { ...ok.a, device_id: 99999 } }, 404, /not found/],
    [{ ...ok, count: 2, a: { ...ok.a, side: 'rear' }, b: { ...ok.b, side: 'rear' } }, 400, /not a patch or fibre panel/],
  ]) { const r = await c.operator.post(`${A}/links/bulk`, b); assert.equal(r.status, status, JSON.stringify(b)); assert.match(r.body.error, re); }
});

test('bulk connect over a trunk: strands are taken pair by pair, and running out stops the whole batch', async () => {
  const trunkBody = { a: { device_id: id['ODF-1'], side: 'rear', start_port: '1' }, b: { device_id: id['ODF-2'], side: 'rear', start_port: '1' }, count: 4, trunk_cable_id: id.trunk, cable_type: 'OS2' };
  const dry = (await c.operator.post(`${A}/links/bulk`, { ...trunkBody, dry_run: true })).body;
  assert.deepEqual(dry.pairs.map((p) => p.strands), ['1-2', '3-4', '5-6', '7-8'], 'the dry run promises each pair its own strands');
  assert.equal((await c.operator.post(`${A}/links/bulk`, trunkBody)).status, 201);
  const t = (await c.viewer.get(`${A}/trunks/${id.trunk}`)).body.trunk;
  assert.equal(t.used_strands, 8); assert.deepEqual(t.links.map((l) => l.strands).sort(), ['1-2', '3-4', '5-6', '7-8']);
  const small = { a: { device_id: id['ODF-4'], side: 'rear', start_port: '1' }, b: { device_id: id['ODF-3'], side: 'rear', start_port: '1' }, count: 3, trunk_cable_id: id.trunk13 };
  const d2 = (await c.operator.post(`${A}/links/bulk`, { ...small, dry_run: true })).body;
  assert.equal(d2.error_count, 1); assert.match(d2.pairs[2].error, /no free strands left/);
  const r = await c.operator.post(`${A}/links/bulk`, small);
  assert.equal(r.status, 409); assert.match(r.body.error, /Pair 3 of 3/);
  assert.equal((await c.viewer.get(`${A}/trunks/${id.trunk13}`)).body.trunk.used_strands, 0, 'nothing of the failed batch remains');
});

test('bulk outlets: label a run of patch-panel ports in one go', async () => {
  const body = { start_port: '13', count: 4, office_id: id.office, label_prefix: 'K-', label_start: 1, label_pad: 2, rear_cable_type: 'Cat6', rear_length_m: 12 };
  const dry = await c.operator.post(`${A}/devices/${id['PP-A']}/outlets/bulk`, { ...body, dry_run: true });
  assert.equal(dry.status, 200); assert.deepEqual(dry.body.plan.map((x) => [x.port, x.label]), [['13', 'K-01'], ['14', 'K-02'], ['15', 'K-03'], ['16', 'K-04']]);
  assert.equal(await statusOf('PP-A', '13'), 'free', 'a dry run changes nothing');
  const real = await c.operator.post(`${A}/devices/${id['PP-A']}/outlets/bulk`, body);
  assert.equal(real.status, 200); assert.equal(real.body.updated, 4);
  const ports = (await c.viewer.get(`${A}/devices/${id['PP-A']}`)).body.device.ports;
  const p14 = ports.find((p) => p.name === '14');
  assert.equal(p14.outlet_label, 'K-02'); assert.equal(p14.office_name, 'Office 02'); assert.equal(p14.rear_cable_type, 'Cat6'); assert.equal(p14.rear_length_m, 12); assert.equal(p14.status, 'outlet');
  const again = await c.operator.post(`${A}/devices/${id['PP-A']}/outlets/bulk`, { ...body, label_prefix: 'L-' });
  assert.equal(again.status, 409); assert.match(again.body.error, /4 of these ports already have an outlet \(13: K-01, 14: K-02, 15: K-03, …\)/);
  const over = await c.operator.post(`${A}/devices/${id['PP-A']}/outlets/bulk`, { ...body, label_prefix: 'L-', overwrite: true });
  assert.equal(over.status, 200); assert.equal((await c.viewer.get(`${A}/devices/${id['PP-A']}`)).body.device.ports.find((p) => p.name === '13').outlet_label, 'L-01');
  for (const [b, status, re] of [
    [{ ...body, office_id: undefined }, 400, /Choose the office/], [{ ...body, office_id: 9999 }, 404, /Office not found/], [{ ...body, count: 0 }, 400, /Count must be a whole number/],
    [{ ...body, start_port: '22', count: 6 }, 400, /has only 3 ports from 22 on/], [{ ...body, rear_cable_type: 'Cat99' }, 400, /Unknown cable type/],
    [{ ...body, label_prefix: 'x'.repeat(30), label_start: 123456 }, 400, /First number/],
  ]) { const r = await c.operator.post(`${A}/devices/${id['PP-A']}/outlets/bulk`, b); assert.equal(r.status, status, JSON.stringify(b)); assert.match(r.body.error, re); }
  assert.equal((await c.operator.post(`${A}/devices/${id['SW-01']}/outlets/bulk`, body)).status, 400, 'a switch has no wall outlets');
  assert.equal((await c.viewer.post(`${A}/devices/${id['PP-A']}/outlets/bulk`, body)).status, 403);
});

test('maintenance for a room: one window for everything linked to monitoring, and ending it', async () => {
  const fgb = (await c.admin.post('/api/routers', { name: 'FG-B', brand: 'fortigate', ip_address: '10.10.0.2' })).body.device;
  const ap = (await c.admin.post('/api/access-points', { name: 'AP-Hall', brand: 'other', ip_address: '10.10.0.60' })).body.device;
  await mk(c.operator, '/devices/from-linked', { kind: 'router', id: fgb.id, room_id: id.r1 });
  await mk(c.operator, '/devices/from-linked', { kind: 'access_point', id: ap.id, room_id: id.r1 });
  let room = (await c.viewer.get(`${A}/rooms/${id.r1}`)).body;
  assert.equal(room.maintenance.linked, 3); assert.equal(room.maintenance.covered, 0); assert.equal(room.maintenance.room_windows, 0);

  assert.equal((await c.viewer.post(`${A}/rooms/${id.r1}/maintenance`, { minutes: 30 })).status, 403);
  assert.equal((await c.operator.post(`${A}/rooms/${id.r1}/maintenance`, { minutes: 0 })).status, 400);
  assert.equal((await c.operator.post(`${A}/rooms/${id.r1}/maintenance`, { minutes: 99999999 })).status, 400);
  assert.equal((await c.operator.post(`${A}/rooms/99999/maintenance`, { minutes: 30 })).status, 404);

  const r = await c.operator.post(`${A}/rooms/${id.r1}/maintenance`, { minutes: 30, reason: 'rack work' });
  assert.equal(r.status, 201); assert.equal(r.body.created, 3); assert.deepEqual(r.body.skipped, []);
  const list = JSON.stringify((await c.admin.get('/api/maintenance')).body);
  assert.ok(list.includes('Work in TS-1: rack work') && list.includes('FG-100F') && list.includes('AP-Hall'), 'the windows are in the Maintenance module');
  room = (await c.viewer.get(`${A}/rooms/${id.r1}`)).body;
  assert.equal(room.maintenance.covered, 3); assert.equal(room.maintenance.room_windows, 3); assert.ok(room.maintenance.room_window_ends_at);
  assert.ok(room.devices.filter((d) => d.linked_kind).every((d) => d.live.maintenance === true), 'every linked device shows it is in maintenance');

  const second = await c.operator.post(`${A}/rooms/${id.r1}/maintenance`, { minutes: 30 });
  assert.equal(second.body.created, 0); assert.equal(second.body.skipped.length, 3); assert.match(second.body.skipped[0].reason, /already in a maintenance window/);
  assert.equal((await c.viewer.del(`${A}/rooms/${id.r1}/maintenance`)).status, 403);
  const end = await c.operator.del(`${A}/rooms/${id.r1}/maintenance`);
  assert.equal(end.status, 200); assert.equal(end.body.ended, 3);
  room = (await c.viewer.get(`${A}/rooms/${id.r1}`)).body;
  assert.equal(room.maintenance.room_windows, 0); assert.equal(room.maintenance.covered, 0);
  assert.equal((await c.operator.del(`${A}/rooms/${id.r1}/maintenance`)).body.ended, 0);
});

test('audit log: bulk work and room maintenance are recorded', async () => {
  const log = JSON.stringify((await c.admin.get('/api/audit-log?limit=500')).body);
  for (const a of ['cabling.link.bulk', 'cabling.outlets.bulk', 'cabling.room.maintenance', 'cabling.room.maintenance.end']) assert.ok(log.includes(a), a);
});
