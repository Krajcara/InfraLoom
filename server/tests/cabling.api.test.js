'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { startServer, clientsFor, Client } = require('./_helpers');

let srv; let c;
test.before(async () => { srv = await startServer(); c = await clientsFor(srv); });
test.after(() => srv?.stop());

const A = '/api/cabling';
const switchGroups = [
  { prefix: 'Gi1/0/', start_no: 1, end_no: 24, port_type: 'rj45', speed: '1G', poe: true, role: 'lan' },
  { prefix: 'Te1/1/', start_no: 1, end_no: 4, port_type: 'sfp_plus', speed: '10G', poe: false, role: 'uplink' },
];
const ids = {};

test('access: sign-in is required; everyone signed in can read; the catalog lists the value lists', async () => {
  assert.equal((await c.anon.get(`${A}/rooms`)).status, 401);
  assert.equal((await c.anon.get(`${A}/status`)).status, 401);
  assert.deepEqual((await c.viewer.get(`${A}/status`)).body, { enabled: true, allowed: true });
  const cat = (await c.viewer.get(`${A}/catalog`)).body;
  assert.ok(cat.device_types.some((t) => t.value === 'patch_panel') && cat.port_types.some((t) => t.label === 'SFP+') && cat.speeds.includes('10G'));
});

test('roles: viewer reads only, operator creates and edits, only an admin deletes', async () => {
  assert.equal((await c.viewer.post(`${A}/rooms`, { name: 'X' })).status, 403);
  const r = await c.operator.post(`${A}/rooms`, { name: 'TS-1', location: 'Ground floor', floor: '0' });
  assert.equal(r.status, 201); ids.room1 = r.body.room.id;
  assert.equal((await c.operator.delete?.(`${A}/rooms/${ids.room1}`))?.status ?? (await c.operator.del(`${A}/rooms/${ids.room1}`)).status, 403);
  assert.equal((await c.viewer.get(`${A}/rooms`)).body.rooms.length, 1);
  const tmp = await c.operator.post(`${A}/rooms`, { name: 'Temp' });
  assert.equal((await c.admin.del(`${A}/rooms/${tmp.body.room.id}`)).status, 200);
});

test('rooms, racks, offices: validation and unique names', async () => {
  assert.equal((await c.operator.post(`${A}/rooms`, { name: '  ' })).status, 400);
  const dup = await c.operator.post(`${A}/rooms`, { name: 'ts-1' });
  assert.equal(dup.status, 409); assert.match(dup.body.error, /already used/);
  const r2 = await c.operator.post(`${A}/rooms`, { name: 'TS-2', floor: '1' }); ids.room2 = r2.body.room.id;
  const rack = await c.operator.post(`${A}/rooms/${ids.room1}/racks`, { name: 'R1', height_u: 42 }); ids.rack1 = rack.body.rack.id;
  assert.equal(rack.status, 201);
  assert.equal((await c.operator.post(`${A}/rooms/${ids.room1}/racks`, { name: 'R1' })).status, 409);
  assert.equal((await c.operator.post(`${A}/rooms/${ids.room1}/racks`, { name: 'R9', height_u: 99 })).status, 400);
  assert.equal((await c.operator.post(`${A}/rooms/9999/racks`, { name: 'R9' })).status, 404);
  const o = await c.operator.post(`${A}/offices`, { name: 'Office 02', floor: '1' }); ids.office2 = o.body.office.id;
  assert.equal(o.status, 201);
  assert.equal((await c.operator.post(`${A}/offices`, { name: 'office 02' })).status, 409);
  assert.equal((await c.operator.get(`${A}/rooms/9999`)).status, 404);
});

test('templates: groups are validated, saved, counted and replaced', async () => {
  const bad = await c.operator.post(`${A}/templates`, { name: 'Bad', device_type: 'switch', groups: [{ ...switchGroups[0], port_type: 'usb' }] });
  assert.equal(bad.status, 400); assert.match(bad.body.error, /Group 1: unknown port type/);
  assert.equal((await c.operator.post(`${A}/templates`, { name: 'Bad', device_type: 'toaster', groups: [] })).status, 400);
  const t = await c.operator.post(`${A}/templates`, { name: 'FortiSwitch 124F-POE', device_type: 'switch', manufacturer: 'Fortinet', model: '124F-POE', groups: switchGroups });
  assert.equal(t.status, 201); ids.tpl = t.body.template.id;
  assert.equal(t.body.template.port_count, 28); assert.equal(t.body.template.groups[1].role, 'uplink');
  assert.equal((await c.operator.post(`${A}/templates`, { name: 'fortiswitch 124f-poe', device_type: 'switch', groups: [] })).status, 409);
  const up = await c.operator.put(`${A}/templates/${ids.tpl}`, { groups: [switchGroups[0]] });
  assert.equal(up.body.template.port_count, 24);
  await c.operator.put(`${A}/templates/${ids.tpl}`, { groups: switchGroups });
  assert.equal((await c.viewer.get(`${A}/templates`)).body.templates.length, 1);
});

test('devices: created with explicit groups, ports are generated, name/type/location validated', async () => {
  const d = await c.operator.post(`${A}/devices`, { name: 'SW-01', device_type: 'switch', purpose: 'production', room_id: ids.room1, rack_id: ids.rack1, rack_position: 40, ip_address: '10.10.0.11', manufacturer: 'Fortinet', model: 'FortiSwitch 124F-POE', groups: switchGroups });
  assert.equal(d.status, 201); ids.sw = d.body.device.id;
  assert.equal(d.body.device.ports.length, 28);
  assert.deepEqual(d.body.device.ports.slice(22, 26).map((p) => p.name), ['Gi1/0/23', 'Gi1/0/24', 'Te1/1/1', 'Te1/1/2']);
  assert.ok(d.body.device.ports[0].poe === true && d.body.device.ports[24].poe === false && d.body.device.ports.every((p) => p.status === 'free'));
  assert.equal(d.body.device.room_name, 'TS-1'); assert.equal(d.body.device.rack_name, 'R1');
  const bad = [
    [{ name: '', device_type: 'switch' }, /Name is required/],
    [{ name: 'a', device_type: 'toaster' }, /device type/],
    [{ name: 'a', device_type: 'switch', purpose: 'fun' }, /purpose/],
    [{ name: 'a', device_type: 'switch', room_id: ids.room1, office_id: ids.office2 }, /either in a room or in an office/],
    [{ name: 'a', device_type: 'switch', room_id: 9999 }, /Room not found/],
    [{ name: 'a', device_type: 'switch', room_id: ids.room2, rack_id: ids.rack1 }, /not in the chosen room/],
    [{ name: 'a', device_type: 'switch', room_id: ids.room1, rack_id: ids.rack1, rack_position: 50 }, /only 42 U high/],
    [{ name: 'a', device_type: 'switch', ip_address: '10.0.0.999' }, /IP address/],
    [{ name: 'a', device_type: 'switch', mac_address: 'zz' }, /MAC address/],
    [{ name: 'a', device_type: 'switch', linked_kind: 'switch', linked_id: 4242 }, /does not exist/],
    [{ name: 'a', device_type: 'switch', linked_kind: 'toaster', linked_id: 1 }, /linked to/],
    [{ name: 'a', device_type: 'switch', groups: [{ ...switchGroups[0], end_no: 0 }] }, /Group 1/],
  ];
  for (const [body, re] of bad) { const r = await c.operator.post(`${A}/devices`, body); assert.equal(r.status, r.status === 404 ? 404 : 400, JSON.stringify(body)); assert.match(r.body.error, re); }
  assert.equal((await c.operator.post(`${A}/devices`, { name: 'sw-01', device_type: 'switch' })).status, 409);
  assert.equal((await c.viewer.post(`${A}/devices`, { name: 'v', device_type: 'switch' })).status, 403);
});

test('devices: DHCP and MAC formats are accepted and normalised', async () => {
  const d = await c.operator.post(`${A}/devices`, { name: 'PC-TEST-01', device_type: 'desktop', purpose: 'testing', room_id: ids.room1, ip_address: 'DHCP', mac_address: '84-39-8F-D2-86-40' });
  assert.equal(d.status, 201); assert.equal(d.body.device.mac_address, '84:39:8f:d2:86:40'); assert.equal(d.body.device.ip_address, 'DHCP'); assert.equal(d.body.device.ports.length, 0);
  ids.pc = d.body.device.id;
});

test('devices: ports come from the template; "save as template" creates one; a name clash creates nothing at all', async () => {
  const d = await c.operator.post(`${A}/devices`, { name: 'SW-02', device_type: 'switch', room_id: ids.room1, template_id: ids.tpl });
  assert.equal(d.body.device.ports.length, 28); assert.equal(d.body.device.template_id, ids.tpl);
  const s = await c.operator.post(`${A}/devices`, { name: 'PP-A', device_type: 'patch_panel', room_id: ids.room1, rack_id: ids.rack1, rack_position: 39, groups: [{ prefix: '', start_no: 1, end_no: 24, port_type: 'rj45', speed: '1G' }], save_as_template: 'Patch panel 24 Cat6' });
  assert.equal(s.status, 201); ids.pp = s.body.device.id;
  const tpl = (await c.operator.get(`${A}/templates`)).body.templates.find((t) => t.name === 'Patch panel 24 Cat6');
  assert.equal(tpl.port_count, 24); assert.equal(s.body.device.template_id, tpl.id); ids.tplPp = tpl.id;
  const before = (await c.operator.get(`${A}/devices`)).body.devices.length;
  const clash = await c.operator.post(`${A}/devices`, { name: 'WILL-FAIL', device_type: 'switch', groups: [{ ...switchGroups[0], end_no: 3 }, { ...switchGroups[0], start_no: 3, end_no: 4 }] });
  assert.equal(clash.status, 409); assert.match(clash.body.error, /Gi1\/0\/3/);
  assert.equal((await c.operator.get(`${A}/devices`)).body.devices.length, before, 'a refused device leaves nothing behind');
  const dupTpl = await c.operator.post(`${A}/devices`, { name: 'WILL-FAIL-2', device_type: 'switch', groups: [switchGroups[0]], save_as_template: 'Patch panel 24 Cat6' });
  assert.equal(dupTpl.status, 409);
  assert.equal((await c.operator.get(`${A}/devices?q=WILL-FAIL`)).body.devices.length, 0, 'and a failed template name does not leave a half-made device');
});

test('devices: update changes only what is sent, validates, and moves between room and office', async () => {
  const u = await c.operator.put(`${A}/devices/${ids.sw}`, { ip_address: '10.10.0.12', notes: 'core' });
  assert.equal(u.status, 200); assert.equal(u.body.device.ip_address, '10.10.0.12'); assert.equal(u.body.device.rack_position, 40); assert.equal(u.body.device.ports.length, 28);
  assert.equal((await c.operator.put(`${A}/devices/${ids.sw}`, { device_type: 'toaster' })).status, 400);
  assert.equal((await c.operator.get(`${A}/devices/${ids.sw}`)).body.device.ip_address, '10.10.0.12', 'a refused update changes nothing');
  const moved = await c.operator.put(`${A}/devices/${ids.pc}`, { room_id: null, office_id: ids.office2 });
  assert.equal(moved.status, 200); assert.equal(moved.body.device.office_name, 'Office 02'); assert.equal(moved.body.device.room_id, null);
  const back = await c.operator.put(`${A}/devices/${ids.pc}`, { room_id: ids.room1, office_id: null });
  assert.equal(back.body.device.room_name, 'TS-1');
  assert.equal((await c.operator.put(`${A}/devices/9999`, { name: 'x' })).status, 404);
});

test('ports: more can be added later, names stay unique, and a port can be edited', async () => {
  const add = await c.operator.post(`${A}/devices/${ids.pc}/ports`, { groups: [{ prefix: 'eth', start_no: 0, end_no: 0, port_type: 'rj45', speed: '1G' }] });
  assert.equal(add.status, 201); assert.equal(add.body.device.ports.length, 1);
  assert.equal((await c.operator.post(`${A}/devices/${ids.pc}/ports`, { groups: [{ prefix: 'ETH', start_no: 0, end_no: 0, port_type: 'rj45' }] })).status, 409);
  const more = await c.operator.post(`${A}/devices/${ids.sw}/ports`, { groups: [{ prefix: 'Gi1/0/', start_no: 25, end_no: 26, port_type: 'rj45' }] });
  assert.deepEqual(more.body.device.ports.slice(-2).map((p) => p.name), ['Gi1/0/25', 'Gi1/0/26']);
  assert.equal((await c.operator.post(`${A}/devices/${ids.sw}/ports`, { groups: [] })).status, 400);
  assert.equal((await c.operator.post(`${A}/devices/${ids.sw}/ports`, { groups: [{ prefix: 'Big', start_no: 1, end_no: 490, port_type: 'rj45' }] })).status, 400);
  const port = more.body.device.ports[0];
  const e = await c.operator.put(`${A}/ports/${port.id}`, { notes: 'uplink to FG', role: 'uplink' });
  assert.equal(e.status, 200); assert.equal(e.body.port.role, 'uplink'); assert.equal(e.body.port.name, port.name);
  assert.equal((await c.operator.put(`${A}/ports/${port.id}`, { port_type: 'usb' })).status, 400);
  assert.equal((await c.operator.put(`${A}/ports/${port.id}`, { name: 'Gi1/0/2' })).status, 409);
  assert.equal((await c.operator.put(`${A}/ports/${port.id}`, { office_id: 9999 })).status, 404);
});

test('outlets: a patch-panel port records the office and the wall outlet; the office lists them', async () => {
  const room = (await c.viewer.get(`${A}/rooms/${ids.room1}`)).body;
  const pp = room.devices.find((d) => d.name === 'PP-A');
  for (const [i, label] of [[0, 'K-01'], [1, 'K-02/A'], [2, 'K-02/B']]) {
    const r = await c.operator.put(`${A}/ports/${pp.ports[i].id}`, { office_id: ids.office2, outlet_label: label });
    assert.equal(r.body.port.status, 'outlet'); assert.equal(r.body.port.office_name, 'Office 02');
  }
  const off = (await c.viewer.get(`${A}/offices/${ids.office2}`)).body;
  assert.deepEqual(off.outlets.map((o) => [o.outlet_label, o.port_name, o.device_name, o.room_name, o.rack_name]), [['K-01', '1', 'PP-A', 'TS-1', 'R1'], ['K-02/A', '2', 'PP-A', 'TS-1', 'R1'], ['K-02/B', '3', 'PP-A', 'TS-1', 'R1']]);
  assert.equal((await c.viewer.get(`${A}/offices`)).body.offices.find((o) => o.id === ids.office2).outlets, 3);
});

test('room view: racks, devices top-down, ports with status, and the counters', async () => {
  const v = (await c.viewer.get(`${A}/rooms/${ids.room1}`)).body;
  assert.deepEqual(v.devices.filter((d) => d.rack_id).map((d) => [d.name, d.rack_position]), [['SW-01', 40], ['PP-A', 39]], 'devices sit in the rack from the top unit down');
  assert.equal(v.summary.racks, 1); assert.equal(v.summary.panel_ports, 24); assert.equal(v.summary.outlets, 3);
  assert.equal(v.summary.devices, v.devices.length);
  assert.ok(v.devices.find((d) => d.name === 'PP-A').ports.filter((p) => p.status === 'outlet').length === 3);
  const list = (await c.viewer.get(`${A}/rooms`)).body.rooms.find((r) => r.id === ids.room1);
  assert.ok(list.racks === 1 && list.devices >= 4 && list.ports >= 28 + 24);
});

test('linking: InfraLoom items can be listed, turned into a device in one step, and shown live', async () => {
  const fg = await c.admin.post('/api/routers', { name: 'FG100F', brand: 'fortigate', ip_address: '10.10.0.1' });
  const ap = await c.admin.post('/api/access-points', { name: 'AP-Hall', brand: 'other', ip_address: '10.10.0.60' });
  assert.ok(fg.body.device?.id && ap.body.device?.id, 'test devices exist');
  const items = (await c.viewer.get(`${A}/linkable`)).body.items;
  const fgItem = items.find((i) => i.kind === 'router' && i.name === 'FG100F');
  assert.ok(fgItem && fgItem.linked === false && fgItem.address === '10.10.0.1');
  const made = await c.operator.post(`${A}/devices/from-linked`, { kind: 'router', id: fgItem.id, room_id: ids.room1, template_id: ids.tplPp });
  assert.equal(made.status, 201);
  assert.equal(made.body.device.device_type, 'firewall', 'a FortiGate is a firewall');
  assert.equal(made.body.device.ip_address, '10.10.0.1'); assert.equal(made.body.device.linked_kind, 'router'); assert.equal(made.body.device.ports.length, 24);
  assert.ok(['up', 'down', 'unknown'].includes(made.body.device.live.state) && made.body.device.live.name === 'FG100F');
  assert.equal((await c.viewer.get(`${A}/linkable`)).body.items.find((i) => i.id === fgItem.id && i.kind === 'router').linked, true);
  assert.equal((await c.operator.post(`${A}/devices/from-linked`, { kind: 'router', id: fgItem.id })).status, 409, 'one InfraLoom item is linked once');
  assert.equal((await c.operator.post(`${A}/devices/from-linked`, { kind: 'router', id: 99999 })).status, 404);
  assert.equal((await c.operator.post(`${A}/devices/from-linked`, { kind: 'toaster', id: 1 })).status, 400);
  const manual = await c.operator.put(`${A}/devices/${ids.sw}`, { linked_kind: 'access_point', linked_id: ap.body.device.id });
  assert.equal(manual.status, 200); assert.equal(manual.body.device.live.name, 'AP-Hall');
  const inRoom = (await c.viewer.get(`${A}/rooms/${ids.room1}`)).body.devices.find((d) => d.name === 'FG100F');
  assert.ok(inRoom.live, 'the room view carries the live state of linked devices');
  await c.operator.put(`${A}/devices/${ids.sw}`, { linked_kind: null, linked_id: null });
});

test('search: devices by name or address, ports by outlet label, nothing for short or wildcard input', async () => {
  const dev = (await c.viewer.get(`${A}/search?q=10.10.0.12`)).body;
  assert.deepEqual(dev.devices.map((d) => d.name), ['SW-01']);
  const outlet = (await c.viewer.get(`${A}/search?q=k-02`)).body;
  assert.deepEqual(outlet.ports.map((p) => p.outlet_label), ['K-02/A', 'K-02/B']);
  assert.ok(outlet.ports[0].device_name === 'PP-A' && outlet.ports[0].room_name === 'TS-1' && outlet.ports[0].office_name === 'Office 02');
  assert.deepEqual((await c.viewer.get(`${A}/search?q=a`)).body, { devices: [], ports: [] });
  const wild = (await c.viewer.get(`${A}/search?q=%25%25`)).body;
  assert.equal(wild.devices.length + wild.ports.length, 0, '% is searched for, not used as a wildcard');
  assert.equal((await c.viewer.get(`${A}/devices?q=sw-0`)).body.devices.length, 2);
  assert.equal((await c.viewer.get(`${A}/devices?type=patch_panel`)).body.devices.length, 1);
});

test('deleting: rooms and racks leave their devices in the inventory; templates leave their ports; devices take ports along', async () => {
  const rack2 = (await c.operator.post(`${A}/rooms/${ids.room2}/racks`, { name: 'R2', height_u: 10 })).body.rack;
  const d = (await c.operator.post(`${A}/devices`, { name: 'IN-R2', device_type: 'server', room_id: ids.room2, rack_id: rack2.id, rack_position: 9 })).body.device;
  assert.equal((await c.operator.put(`${A}/racks/${rack2.id}`, { height_u: 5 })).status, 400, 'a rack cannot shrink below a device that sits above the new top');
  assert.equal((await c.admin.del(`${A}/racks/${rack2.id}`)).status, 200);
  let after = (await c.viewer.get(`${A}/devices/${d.id}`)).body.device;
  assert.equal(after.rack_id, null); assert.equal(after.rack_position, null); assert.equal(after.room_id, ids.room2);
  assert.equal((await c.operator.del(`${A}/devices/${d.id}`)).status, 403);
  const gone = await c.admin.del(`${A}/rooms/${ids.room2}`);
  assert.equal(gone.status, 200); assert.equal(gone.body.devices_left_without_room, 1);
  after = (await c.viewer.get(`${A}/devices/${d.id}`)).body.device;
  assert.equal(after.room_id, null);
  assert.equal((await c.admin.del(`${A}/templates/${ids.tplPp}`)).status, 200);
  const pp = (await c.viewer.get(`${A}/devices/${ids.pp}`)).body.device;
  assert.equal(pp.template_id, null); assert.equal(pp.ports.length, 24);
  assert.equal((await c.admin.del(`${A}/devices/${d.id}`)).status, 200);
  assert.equal((await c.viewer.get(`${A}/devices/${d.id}`)).status, 404);
  assert.equal((await c.admin.del(`${A}/offices/${ids.office2}`)).status, 200);
  const ppPorts = (await c.viewer.get(`${A}/devices/${ids.pp}`)).body.device.ports;
  assert.equal(ppPorts.filter((p) => p.outlet_label).length, 3, 'outlet labels survive the office');
  assert.ok(ppPorts.every((p) => p.office_id === null));
});

test('audit log: every change is recorded with who and what', async () => {
  const log = JSON.stringify((await c.admin.get('/api/audit-log?limit=500')).body);
  for (const a of ['cabling.room.create', 'cabling.device.create', 'cabling.device.update', 'cabling.port.update', 'cabling.template.create', 'cabling.device.delete', 'cabling.room.delete']) assert.ok(log.includes(a), a);
  assert.ok(log.includes('t_operator'));
});

test('module switch: off hides everything (but not the status or settings), and an admin can switch it back on', async () => {
  assert.equal((await c.operator.get(`${A}/settings`)).status, 403);
  assert.equal((await c.admin.put(`${A}/settings`, { enabled: 'no' })).status, 400);
  assert.equal((await c.admin.put(`${A}/settings`, { enabled: false })).status, 200);
  assert.equal((await c.viewer.get(`${A}/rooms`)).status, 404);
  assert.equal((await c.admin.post(`${A}/rooms`, { name: 'Nope' })).status, 404);
  assert.deepEqual((await c.viewer.get(`${A}/status`)).body, { enabled: false, allowed: true });
  assert.equal((await c.admin.put(`${A}/settings`, { enabled: true })).body.enabled, true);
  assert.equal((await c.viewer.get(`${A}/rooms`)).status, 200);
});

test('allowed networks: invalid input is refused, the admin cannot lock themselves out, outsiders get 403', async () => {
  assert.equal((await c.admin.put(`${A}/settings`, { allowed_networks: ['10.0.0.0/33'] })).status, 400);
  assert.equal((await c.admin.put(`${A}/settings`, { allowed_networks: 'nope' })).status, 400);
  const lock = await c.admin.put(`${A}/settings`, { allowed_networks: ['10.0.0.0/8'] });
  assert.equal(lock.status, 400); assert.match(lock.body.error, /lock you out/);
  assert.deepEqual((await c.admin.get(`${A}/settings`)).body.allowed_networks, [], 'a refused list is not stored');
  const ok = await c.admin.put(`${A}/settings`, { allowed_networks: ['127.0.0.0/8', '192.168.0.0/16'] });
  assert.equal(ok.status, 200); assert.deepEqual(ok.body.allowed_networks, ['127.0.0.0/8', '192.168.0.0/16']);
  assert.equal((await c.viewer.get(`${A}/rooms`)).status, 200);
  // behind a reverse proxy the address comes from X-Forwarded-For (InfraLoom trusts one proxy)
  const outsider = await new Client(srv.base, { 'X-Forwarded-For': '8.8.8.8' }).login('t_viewer', 'x').catch(() => null);
  const viaProxy = (cookie, ip) => new Client(srv.base, { 'X-Forwarded-For': ip }).request('GET', `${A}/rooms`);
  const out = new Client(srv.base, { 'X-Forwarded-For': '8.8.8.8' }); out.cookie = c.viewer.cookie;
  assert.equal((await out.get(`${A}/rooms`)).status, 403);
  assert.deepEqual((await out.get(`${A}/status`)).body, { enabled: true, allowed: false });
  const inside = new Client(srv.base, { 'X-Forwarded-For': '192.168.7.7' }); inside.cookie = c.viewer.cookie;
  assert.equal((await inside.get(`${A}/rooms`)).status, 200, 'a 192.168.x.x client is let in');
  assert.equal((await c.admin.put(`${A}/settings`, { allowed_networks: [] })).status, 200);
  assert.equal((await out.get(`${A}/rooms`)).status, 200, 'an empty list means everyone who can sign in');
  void outsider; void viaProxy;
});
