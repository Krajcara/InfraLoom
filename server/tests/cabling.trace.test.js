'use strict';

// The trace engine is pure: these tests need no database and no server.
const test = require('node:test');
const assert = require('node:assert/strict');
const { buildGraph, trace, classify, connections, MAX_HOPS } = require('../src/services/cabling/trace');

const dev = (id, name, device_type, extra = {}) => ({ id, name, device_type, model: null, room_id: 1, room_name: 'TS-1', rack_name: 'R1', rack_position: null, office_id: null, office_name: null, ...extra });
const port = (id, device_id, name, extra = {}) => ({ id, device_id, name, port_type: 'rj45', speed: '1G', poe: 0, office_id: null, office_name: null, outlet_label: null, rear_cable_type: null, rear_length_m: null, ...extra });
let linkId = 0;
const link = (a, sa, b, sb, extra = {}) => ({ id: ++linkId, port_a_id: a, side_a: sa, port_b_id: b, side_b: sb, kind: sa === 'rear' && sb === 'rear' ? 'permanent' : 'patch', cable_type: null, color: null, length_m: null, strands: null, notes: null, trunk_cable_id: null, ...extra });
const shape = (t) => t.steps.map((s) => (s.type === 'port' ? `${s.device_name}:${s.port_name}` : s.type === 'outlet' ? `outlet ${s.label}` : s.type));

// The design's example, plus a fibre path to the second room and a direct patch.
function fixture() {
  linkId = 0;
  const devices = [
    dev(1, 'SW-01', 'switch'), dev(2, 'PP-A', 'patch_panel'), dev(3, 'PC-K02-A', 'desktop', { room_id: null, room_name: null, rack_name: null, office_id: 2, office_name: 'Office 02' }),
    dev(4, 'HV-01', 'hypervisor'), dev(5, 'ODF-1', 'fiber_panel'), dev(6, 'ODF-2', 'fiber_panel', { room_id: 2, room_name: 'TS-2' }), dev(7, 'SW-10', 'switch', { room_id: 2, room_name: 'TS-2' }),
  ];
  const ports = [
    port(1, 1, 'Gi1/0/3'), port(2, 1, 'Gi1/0/17'), port(3, 1, 'Te1/1/1', { port_type: 'sfp_plus', speed: '10G' }), port(4, 1, 'Gi1/0/9'),
    port(11, 2, '1', { office_id: 1, office_name: 'Office 01', outlet_label: 'K-01' }), port(12, 2, '2'), port(13, 2, '3', { office_id: 2, office_name: 'Office 02', outlet_label: 'K-02/A', rear_cable_type: 'Cat6', rear_length_m: 12 }),
    port(21, 3, 'eth0'), port(22, 4, 'eth0'),
    port(31, 5, '1', { port_type: 'lc_duplex' }), port(41, 6, '1', { port_type: 'lc_duplex' }), port(43, 7, 'S1', { port_type: 'sfp_plus', speed: '10G' }),
  ];
  const links = [
    link(1, 'front', 13, 'front', { cable_type: 'Cat6', length_m: 1 }),                       // SW-01 Gi1/0/3 -> PP-A 3
    link(13, 'rear', 21, 'front', { cable_type: 'Cat6', length_m: 3 }),                       // outlet K-02/A -> PC
    link(2, 'front', 22, 'front'),                                                           // SW-01 Gi1/0/17 -> HV-01 (direct)
    link(3, 'front', 31, 'front'),                                                           // SW-01 Te1/1/1 -> ODF-1 1
    link(31, 'rear', 41, 'rear', { trunk_cable_id: 7, trunk_name: 'TS-1 to TS-2', trunk_medium: 'fiber', trunk_fiber_type: 'OS2', strands: '1-2' }), // trunk
    link(41, 'front', 43, 'front'),                                                          // ODF-2 1 -> SW-10
  ];
  return buildGraph({ ports, devices, links });
}

test('the design example: switch -> panel -> wall outlet -> desktop, in order, with cable details', () => {
  const g = fixture();
  const t = trace(g, 1);
  assert.deepEqual(shape(t), ['SW-01:Gi1/0/3', 'link', 'PP-A:3', 'installation', 'outlet K-02/A', 'link', 'PC-K02-A:eth0']);
  assert.equal(t.steps[1].cable_type, 'Cat6'); assert.equal(t.steps[1].length_m, 1);
  assert.equal(t.steps[3].cable_type, 'Cat6'); assert.equal(t.steps[3].length_m, 12);
  assert.equal(t.steps[4].office_name, 'Office 02'); assert.equal(t.steps[5].length_m, 3);
  assert.deepEqual(t.ends, ['device', 'device']); assert.equal(t.complete, true);
  assert.equal(t.steps[0].is_start, true); assert.equal(t.steps[0].rack_name, 'R1'); assert.equal(t.steps[2].panel, true);
  assert.equal(t.steps[6].office_name, 'Office 02');
});

test('the same chain from the other end, and from the panel in the middle', () => {
  const g = fixture();
  const fwd = shape(trace(g, 1));
  assert.deepEqual(shape(trace(g, 21)), [...fwd].reverse());
  const mid = trace(g, 13);
  assert.deepEqual(shape(mid), fwd);
  assert.equal(mid.steps.find((s) => s.is_start).device_name, 'PP-A', 'the panel port is the marked start');
  assert.equal(mid.complete, true);
});

test('a direct patch between two devices has no panel and no outlet', () => {
  const g = fixture();
  assert.deepEqual(shape(trace(g, 2)), ['SW-01:Gi1/0/17', 'link', 'HV-01:eth0']);
});

test('the fibre path to the other room goes over the trunk and out of the far panel', () => {
  const g = fixture();
  const t = trace(g, 3);
  assert.deepEqual(shape(t), ['SW-01:Te1/1/1', 'link', 'ODF-1:1', 'link', 'ODF-2:1', 'link', 'SW-10:S1']);
  assert.equal(t.steps[3].kind, 'permanent'); assert.equal(t.steps[3].trunk.name, 'TS-1 to TS-2'); assert.equal(t.steps[3].strands, '1-2');
  assert.equal(t.steps[4].room_name, 'TS-2'); assert.equal(t.complete, true);
  assert.deepEqual(shape(trace(g, 43)), [...shape(t)].reverse(), 'and back from the other room');
});

test('an outlet with no patch cord on the front: the trace ends at the outlet', () => {
  const g = fixture();
  const t = trace(g, 11);
  assert.deepEqual(shape(t), ['PP-A:1', 'installation', 'outlet K-01']);
  assert.deepEqual(t.ends, ['open', 'outlet']); assert.equal(t.complete, false, 'the front is open');
});

test('a free port is just itself', () => {
  const g = fixture();
  const t = trace(g, 4);
  assert.deepEqual(shape(t), ['SW-01:Gi1/0/9']); assert.deepEqual(t.ends, ['device', 'open']); assert.equal(t.complete, false);
  assert.equal(trace(g, 12).steps.length, 1, 'an empty panel port too');
  assert.equal(trace(g, 9999), null, 'a port that does not exist');
});

test('colours: free, outlet without cord, to office, direct to device, fibre', () => {
  const g = fixture();
  const s = (id) => classify(g, id);
  assert.equal(s(4), 'free'); assert.equal(s(12), 'free');
  assert.equal(s(11), 'outlet', 'a wall outlet is recorded but no cord is plugged in');
  assert.equal(s(1), 'office'); assert.equal(s(13), 'office'); assert.equal(s(21), 'office', 'the desktop at the far end of the same path');
  assert.equal(s(2), 'device'); assert.equal(s(22), 'device');
  assert.equal(s(3), 'fiber'); assert.equal(s(31), 'fiber'); assert.equal(s(43), 'fiber');
  assert.equal(s(9999), null);
  assert.equal(classify(g, 1), 'office', 'and it is stable when asked again');
});

test('what is plugged into each side of a port', () => {
  const g = fixture();
  const c = connections(g, 13);
  assert.equal(c.front.other_device_name, 'SW-01'); assert.equal(c.front.other_port_name, 'Gi1/0/3'); assert.equal(c.front.kind, 'patch');
  assert.equal(c.rear.other_device_name, 'PC-K02-A'); assert.equal(c.rear.other_side, 'front');
  assert.deepEqual(connections(g, 4), { front: null, rear: null });
  assert.equal(connections(g, 31).rear.kind, 'permanent');
});

test('a ring of cables ends the trace with "loop" instead of running forever', () => {
  linkId = 0;
  const g = buildGraph({
    devices: [dev(1, 'PA', 'patch_panel'), dev(2, 'PB', 'patch_panel')],
    ports: [port(1, 1, '1'), port(2, 2, '1')],
    links: [link(1, 'front', 2, 'front'), link(1, 'rear', 2, 'rear')],
  });
  const t = trace(g, 1);
  assert.equal(t.loop, true); assert.equal(t.complete, false); assert.ok(t.steps.length < 12);
  assert.equal(classify(g, 1), 'device'); // classifying a looped path does not hang either
});

test('a chain longer than the limit is cut off and says so', () => {
  linkId = 0;
  const n = MAX_HOPS + 20;
  const devices = [], ports = [], links = [];
  for (let i = 0; i < n; i++) { devices.push(dev(i + 1, `P${i}`, 'patch_panel')); ports.push(port(i + 1, i + 1, '1')); }
  for (let i = 0; i < n - 1; i++) links.push(link(i + 1, 'rear', i + 2, 'front', { kind: 'patch' }));
  const t = trace(buildGraph({ devices, ports, links }), 1);
  assert.equal(t.truncated, true); assert.equal(t.complete, false);
  assert.ok(t.steps.length <= MAX_HOPS * 4 + 4, `bounded, got ${t.steps.length}`);
});

test('two links claiming the same side (impossible in the database) do not break the engine', () => {
  linkId = 0;
  const g = buildGraph({
    devices: [dev(1, 'A', 'switch'), dev(2, 'B', 'switch'), dev(3, 'C', 'switch')],
    ports: [port(1, 1, '1'), port(2, 2, '1'), port(3, 3, '1')],
    links: [link(1, 'front', 2, 'front'), link(1, 'front', 3, 'front')],
  });
  assert.deepEqual(shape(trace(g, 1)), ['A:1', 'link', 'B:1']);
});

test('a port whose device is missing from the data still traces', () => {
  linkId = 0;
  const g = buildGraph({ devices: [dev(1, 'A', 'switch')], ports: [port(1, 1, '1'), port(2, 99, '1')], links: [link(1, 'front', 2, 'front')] });
  const t = trace(g, 1);
  assert.equal(t.steps.length, 3); assert.equal(t.steps[2].device_name, null);
});

test('an outlet-side cord that arrives at the rear of a panel shows the outlet before the panel', () => {
  linkId = 0;
  const g = buildGraph({
    devices: [dev(1, 'PP', 'patch_panel'), dev(2, 'PC', 'desktop'), dev(3, 'SW', 'switch')],
    ports: [port(1, 1, '5', { office_id: 1, office_name: 'O', outlet_label: 'K-5' }), port(2, 2, 'eth0'), port(3, 3, '1')],
    links: [link(2, 'front', 1, 'rear'), link(1, 'front', 3, 'front')],
  });
  assert.deepEqual(shape(trace(g, 2)), ['PC:eth0', 'link', 'outlet K-5', 'installation', 'PP:5', 'link', 'SW:1']);
});
