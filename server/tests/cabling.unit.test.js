'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { tempEnv } = require('./_helpers');

// The database module reads its location and key from the environment: point it at a throw-away file first.
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'infraloom-unit-'));
Object.assign(process.env, tempEnv(dir));
const { normalizeGroups, expandPortGroups, assertNoDuplicateNames, InputError } = require('../src/services/cabling/ports');
const { buildMatcher, parseNetworks, normalizeIp } = require('../src/services/cabling/networks');
const cat = require('../src/services/cabling/catalog');
const db = require('../src/db/database');
test.after(() => { db.close(); fs.rmSync(dir, { recursive: true, force: true }); });

const group = (o = {}) => ({ prefix: 'Gi1/0/', start_no: 1, end_no: 24, port_type: 'rj45', speed: '1G', poe: true, role: 'lan', ...o });

test('port groups: valid groups are normalised', () => {
  const [g] = normalizeGroups([group({ prefix: ' Gi1/0/ ', speed: '', role: '', poe: 1 })]);
  assert.deepEqual(g, { prefix: 'Gi1/0/', start_no: 1, end_no: 24, port_type: 'rj45', speed: null, poe: 1, role: null, connector: null });
});

test('port groups: every bad input is refused with a message that names the group', () => {
  const bad = [
    [group({ end_no: 0 }), /Group 1: "to" cannot be smaller/],
    [group({ start_no: 'a' }), /whole numbers/],
    [group({ end_no: 10000 }), /between 0 and 9999/],
    [group({ port_type: 'usb' }), /unknown port type "usb"/],
    [group({ speed: '7G' }), /unknown speed/],
    [group({ role: 'boss' }), /unknown role/],
    [group({ connector: 'XX' }), /unknown connector/],
    [group({ prefix: 'x'.repeat(21) }), /at most 20 characters/],
  ];
  for (const [g, re] of bad) assert.throws(() => normalizeGroups([g]), (e) => e instanceof InputError && e.status === 400 && re.test(e.message), re.source);
  assert.throws(() => normalizeGroups('nope'), /must be a list/);
  assert.throws(() => normalizeGroups([group(), group({ end_no: 5 }), group({ port_type: 'bad' })]), /Group 3:/);
});

test('port groups: more than 512 ports per device is refused', () => {
  assert.throws(() => normalizeGroups([group({ start_no: 1, end_no: 400 }), group({ prefix: 'B', start_no: 1, end_no: 200 })]), /at most 512/);
  assert.doesNotThrow(() => normalizeGroups([group({ start_no: 1, end_no: 512 })]));
});

test('port expansion: names, order and attributes (the FortiSwitch 124F example)', () => {
  const ports = expandPortGroups(normalizeGroups([group(), group({ prefix: 'Te1/1/', start_no: 1, end_no: 4, port_type: 'sfp_plus', speed: '10G', poe: false, role: 'uplink' })]));
  assert.equal(ports.length, 28);
  assert.equal(ports[0].name, 'Gi1/0/1'); assert.equal(ports[23].name, 'Gi1/0/24'); assert.equal(ports[24].name, 'Te1/1/1'); assert.equal(ports[27].name, 'Te1/1/4');
  assert.deepEqual(ports.map((p) => p.sort_order), Array.from({ length: 28 }, (_, i) => i + 1));
  assert.equal(ports[0].poe, 1); assert.equal(ports[24].poe, 0); assert.equal(ports[24].role, 'uplink');
});

test('port expansion: ports added later sort after the earlier ones; an empty prefix gives plain numbers', () => {
  const later = expandPortGroups(normalizeGroups([group({ prefix: '', start_no: 25, end_no: 26 })]), 24);
  assert.deepEqual(later.map((p) => [p.name, p.sort_order]), [['25', 25], ['26', 26]]);
});

test('duplicate names are refused (inside the request, and against ports the device already has)', () => {
  const dup = expandPortGroups(normalizeGroups([group({ end_no: 3 }), group({ start_no: 3, end_no: 4 })]));
  assert.throws(() => assertNoDuplicateNames(dup), (e) => e.status === 409 && /Gi1\/0\/3/.test(e.message));
  assert.throws(() => assertNoDuplicateNames(expandPortGroups(normalizeGroups([group({ end_no: 2 })])), ['gi1/0/2']), /already used: Gi1\/0\/2/);
  assert.doesNotThrow(() => assertNoDuplicateNames(expandPortGroups(normalizeGroups([group({ end_no: 2 })])), ['Other1']));
});

test('allowed networks: matching, parsing and loopback', () => {
  const m = buildMatcher(parseNetworks('10.0.0.0/8, 192.168.1.15\n172.16.0.0/12'));
  for (const ip of ['10.200.1.1', '192.168.1.15', '172.20.1.1', '::ffff:10.0.0.5', '::1']) assert.equal(m(ip), true, ip);
  // regression: networks above 128.0.0.0 (the usual 192.168 / 172.16 LAN ranges) must match too
  const lan = buildMatcher(['192.168.0.0/16', '172.16.0.0/12', '200.1.2.0/24']);
  assert.ok(lan('192.168.5.9') && lan('172.31.255.254') && lan('200.1.2.200') && !lan('192.169.0.1') && !lan('200.1.3.1'));
  for (const ip of ['192.168.1.16', '8.8.8.8', '172.32.0.1', '', undefined]) assert.equal(m(ip), false, String(ip));
  assert.equal(buildMatcher(['0.0.0.0/0'])('1.2.3.4'), true);
  assert.throws(() => buildMatcher(['10.0.0.0/33']), /Invalid network/);
  assert.throws(() => buildMatcher(['not-a-network']), /Invalid network/);
  assert.equal(normalizeIp('::ffff:1.2.3.4'), '1.2.3.4');
});

test('catalog: lists are complete and consistent', () => {
  assert.ok(cat.oneOf(cat.DEVICE_TYPES, 'patch_panel') && cat.oneOf(cat.PORT_TYPES, 'lc_duplex') && !cat.oneOf(cat.PORT_TYPES, 'usb'));
  for (const t of cat.PANEL_TYPES) assert.ok(cat.oneOf(cat.DEVICE_TYPES, t));
  assert.equal(cat.DEVICE_TYPES.length, 13);
});

test('schema: migration applied once, tables prefixed, nothing collides with InfraLoom tables', () => {
  assert.deepEqual(db.prepare('SELECT version FROM cab_migrations').all().map((r) => r.version), ['001_cabling', '002_permanent_cable']);
  const tables = db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name LIKE 'cab_%'").all().map((r) => r.name);
  for (const t of ['cab_rooms', 'cab_offices', 'cab_racks', 'cab_device_templates', 'cab_template_port_groups', 'cab_devices', 'cab_ports', 'cab_trunk_cables', 'cab_links']) assert.ok(tables.includes(t), t);
  assert.equal(db.prepare("SELECT COUNT(*) c FROM sqlite_master WHERE name IN ('devices','ports','connections','rooms')").get().c, 0);
  require('../src/db/cabling').migrate(db); // running it again changes nothing
  assert.equal(db.prepare('SELECT COUNT(*) c FROM cab_migrations').get().c, 2);
});

test('schema: a port side takes part in at most one link, whichever end it is on (triggers)', () => {
  const dev = db.prepare("INSERT INTO cab_devices (name, device_type) VALUES ('T-SW', 'switch')").run().lastInsertRowid;
  const port = (n) => db.prepare("INSERT INTO cab_ports (device_id, name, port_type) VALUES (?, ?, 'rj45')").run(dev, n).lastInsertRowid;
  const [a, b, c] = [port('1'), port('2'), port('3')];
  const link = (x, sx, y, sy) => db.prepare('INSERT INTO cab_links (port_a_id, side_a, port_b_id, side_b) VALUES (?,?,?,?)').run(x, sx, y, sy);
  link(a, 'front', b, 'front');
  assert.throws(() => link(a, 'front', c, 'front'), /UNIQUE|already connected/);
  assert.throws(() => link(c, 'front', a, 'front'), /already connected/); // same side used as the other end
  assert.doesNotThrow(() => link(a, 'rear', c, 'front'));              // the rear side of the same port is free
  const d = port('4');
  assert.throws(() => db.prepare("INSERT INTO cab_links (port_a_id, side_a, port_b_id, side_b) VALUES (?, 'front', ?, 'front')").run(d, d), /CHECK|constraint/); // a side cannot link to itself
  db.prepare('DELETE FROM cab_devices WHERE id = ?').run(dev);
  assert.equal(db.prepare('SELECT COUNT(*) c FROM cab_links').get().c, 0, 'deleting a device removes its ports and their links');
});

test('schema: a device is in a room or an office, never both; a linked item is linked once', () => {
  const room = db.prepare("INSERT INTO cab_rooms (name) VALUES ('R')").run().lastInsertRowid;
  const office = db.prepare("INSERT INTO cab_offices (name) VALUES ('O')").run().lastInsertRowid;
  assert.throws(() => db.prepare("INSERT INTO cab_devices (name, device_type, room_id, office_id) VALUES ('X','other',?,?)").run(room, office), /CHECK/);
  db.prepare("INSERT INTO cab_devices (name, device_type, linked_kind, linked_id) VALUES ('L1','switch','switch',7)").run();
  assert.throws(() => db.prepare("INSERT INTO cab_devices (name, device_type, linked_kind, linked_id) VALUES ('L2','switch','switch',7)").run(), /UNIQUE/);
  assert.throws(() => db.prepare("INSERT INTO cab_devices (name, device_type) VALUES ('l1','other')").run(), /UNIQUE/, 'names are case-insensitive');
});
