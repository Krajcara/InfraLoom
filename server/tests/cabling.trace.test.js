'use strict';

// The trace engine is pure: these tests need no database and no server.
const test = require('node:test');
const assert = require('node:assert/strict');
const { buildGraph, trace, classify, connections, gapsOf, MAX_HOPS } = require('../src/services/cabling/trace');

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


test('telephone lines: a port marked telephone, a telephone cable or an exchange on the path makes the whole path "voice"', () => {
  linkId = 0;
  const g = buildGraph({
    devices: [dev(1, 'PBX-1', 'pbx'), dev(2, 'PP-T', 'patch_panel'), dev(3, 'SW-01', 'switch'), dev(4, 'PP-D', 'patch_panel')],
    ports: [
      port(1, 1, 'ext1', { port_type: 'rj11' }), port(2, 1, 'ext2'),
      port(11, 2, '5', { office_id: 2, office_name: 'Office 02', outlet_label: 'T-5', service: 'voice', rear_cable_type: 'Telephone', rear_length_m: 20 }), port(12, 2, '6', { office_id: 2, office_name: 'Office 02', outlet_label: 'T-6', service: 'voice' }),
      port(21, 3, 'Gi1', {}), port(22, 3, 'Gi2', {}), port(23, 3, 'Gi3', {}),
      port(31, 4, '1', { office_id: 2, office_name: 'Office 02', outlet_label: 'D-1' }), port(32, 4, '2', { service: 'voice' }),
    ],
    links: [
      link(1, 'front', 11, 'front', { cable_type: 'Telephone', length_m: 2 }),   // exchange -> panel port marked telephone
      link(21, 'front', 31, 'front', { cable_type: 'Telephone' }),                // a data port patched with a telephone cable
      link(22, 'front', 32, 'front'),                                             // a switch patched to a panel port marked telephone (a mistake, made visible)
    ],
  });
  const t = trace(g, 1);
  assert.deepEqual(shape(t), ['PBX-1:ext1', 'link', 'PP-T:5', 'installation', 'outlet T-5']);
  assert.equal(t.steps[1].cable_type, 'Telephone'); assert.equal(t.steps[3].cable_type, 'Telephone'); assert.equal(t.steps[3].length_m, 20);
  assert.equal(t.steps[4].service, 'voice', 'the outlet is a telephone socket'); assert.equal(t.steps[2].service, 'voice');
  assert.equal(classify(g, 1), 'voice', 'the exchange port'); assert.equal(classify(g, 11), 'voice', 'the panel port');
  assert.equal(classify(g, 12), 'outlet', 'a telephone outlet nobody has patched yet keeps the dashed outlet state (its service shows in the port itself)');
  assert.equal(classify(g, 2), 'free', 'an exchange port with nothing on it');
  assert.equal(classify(g, 21), 'voice', 'a telephone cable makes it a telephone line even on data ports');
  assert.equal(classify(g, 22), 'incomplete', 'a telephone port with no office and outlet label that is patched is something to fix first');
  assert.equal(classify(g, 23), 'free');
});

test('telephone wins over fibre and office; ordinary paths are untouched', () => {
  linkId = 0;
  const g = buildGraph({
    devices: [dev(1, 'SW-A', 'switch'), dev(2, 'ODF-1', 'fiber_panel'), dev(3, 'ODF-2', 'fiber_panel', { room_id: 2, room_name: 'TS-2' }), dev(4, 'PBX-2', 'pbx', { room_id: 2, room_name: 'TS-2' }), dev(5, 'SW-B', 'switch')],
    ports: [port(1, 1, '1', { port_type: 'sfp_plus' }), port(2, 2, '1', { port_type: 'lc_duplex' }), port(3, 3, '1', { port_type: 'lc_duplex' }), port(4, 4, 'x', { port_type: 'lsa' }), port(5, 5, '1')],
    links: [link(1, 'front', 2, 'front'), link(2, 'rear', 3, 'rear', { trunk_cable_id: 9, trunk_name: 'T' }), link(3, 'front', 4, 'front')],
  });
  assert.equal(classify(g, 1), 'voice', 'a fibre path that ends at an exchange is a telephone line');
  assert.equal(classify(g, 5), 'free');
  const plain = fixture();
  assert.equal(classify(plain, 1), 'office'); assert.equal(classify(plain, 2), 'device'); assert.equal(classify(plain, 3), 'fiber');
});


test('incomplete: a patched patch-panel port that lacks its office or outlet label turns the whole path red', () => {
  linkId = 0;
  const g = buildGraph({
    devices: [dev(1, 'SW', 'switch'), dev(2, 'PP', 'patch_panel'), dev(3, 'PP2', 'patch_panel'), dev(4, 'FP', 'fiber_panel')],
    ports: [
      port(1, 1, 'p1'), port(2, 1, 'p2'), port(3, 1, 'p3'), port(4, 1, 'p4'), port(8, 1, 'p8'), port(9, 1, 'p9', { port_type: 'sfp_plus' }),
      port(11, 2, '1', { office_id: 2, office_name: 'O', outlet_label: 'K-1' }),   // complete
      port(12, 2, '2'),                                                          // patched, nothing recorded
      port(13, 2, '3', { office_id: 2, office_name: 'O' }),                      // patched, office only
      port(14, 2, '4', { outlet_label: 'K-4' }),                                 // patched, label only
      port(15, 2, '5', { outlet_label: 'K-5' }),                                 // not patched, label only (half a record)
      port(16, 2, '6'),                                                          // not patched, nothing: simply unused
      port(17, 2, '7', { office_id: 2, office_name: 'O', outlet_label: 'K-7' }), // not patched, complete: a spare outlet
      port(18, 2, '8'),                                                          // patched, rear runs to another panel (a trunk, not an outlet)
      port(21, 3, '1'),
      port(31, 4, '1', { port_type: 'lc_duplex' }),                              // a fibre panel needs no outlet
    ],
    links: [link(1, 'front', 11, 'front'), link(2, 'front', 12, 'front'), link(3, 'front', 13, 'front'), link(4, 'front', 14, 'front'), link(8, 'front', 18, 'front'), link(18, 'rear', 21, 'rear'), link(9, 'front', 31, 'front')],
  });
  assert.deepEqual([gapsOf(g, 11), gapsOf(g, 12), gapsOf(g, 13), gapsOf(g, 14), gapsOf(g, 16)], [[], ['office', 'outlet label'], ['outlet label'], ['office'], ['office', 'outlet label']]);
  assert.deepEqual(gapsOf(g, 18), [], 'a rear cabled to another panel is not an outlet'); assert.deepEqual(gapsOf(g, 31), [], 'nor is a fibre panel'); assert.deepEqual(gapsOf(g, 1), [], 'nor a switch port');
  assert.equal(classify(g, 1), 'office'); assert.equal(classify(g, 11), 'office', 'a complete record stays blue');
  for (const p of [2, 12, 3, 13, 4, 14]) assert.equal(classify(g, p), 'incomplete', `port ${p}: the switch port and the panel port are both flagged`);
  assert.equal(classify(g, 15), 'incomplete', 'half a record is a mistake even when nothing is patched'); assert.equal(classify(g, 16), 'free'); assert.equal(classify(g, 17), 'outlet');
  assert.equal(classify(g, 8), 'device', 'a trunk-side panel port is not flagged'); assert.equal(classify(g, 9), 'fiber', 'a fibre panel is not flagged');
  const t = trace(g, 2);
  assert.deepEqual(t.steps.filter((s) => s.type === 'port').map((s) => [s.port_name, s.gaps]), [['p2', []], ['2', ['office', 'outlet label']]], 'the trace says which step is missing what');
});

test('incomplete wins over telephone, fibre and office', () => {
  linkId = 0;
  const g = buildGraph({
    devices: [dev(1, 'PBX', 'pbx'), dev(2, 'PP', 'patch_panel')],
    ports: [port(1, 1, 'ext1', { port_type: 'rj11' }), port(11, 2, '1', { service: 'voice', office_id: 2, office_name: 'O' })],
    links: [link(1, 'front', 11, 'front', { cable_type: 'Telephone' })],
  });
  assert.equal(classify(g, 1), 'incomplete');
});
