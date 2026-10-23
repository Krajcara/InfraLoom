'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { parseRouterOs, parseFirewallHit, classifyRouterOs } = require('../src/services/syslog/routeros');
const { parseNetworks, contains } = require('../src/services/syslog/cidr');
const { decode } = require('../src/services/syslog/netflow');
const N = require('./_netflow');

const cls = (line) => { const p = parseRouterOs(line); return p && classifyRouterOs(p); };

test('a RouterOS line: with the time and the name of the router, with the time only, or bare', () => {
  const a = parseRouterOs('<30>Oct 23 11:02:03 MikroTik system,info,account user admin logged in from 192.168.88.2 via winbox');
  assert.deepEqual([a.pri, a.host, a.topics, a.message], [30, 'MikroTik', ['system', 'info', 'account'], 'user admin logged in from 192.168.88.2 via winbox']);
  assert.deepEqual(parseRouterOs('<30>system,info,account user admin logged in from 192.168.88.2 via winbox').host, null, 'the default: no time and no name');
  assert.equal(parseRouterOs('<30>2026-10-23T11:02:03+0200 home-gw firewall,info drop-ssh input: in:ether1 out:(unknown 0), proto TCP (SYN), 1.2.3.4:5->6.7.8.9:22, len 60').host, 'home-gw');
  assert.deepEqual(parseRouterOs('interface,info ether1 link down').topics, ['interface', 'info']); assert.equal(parseRouterOs('<30>wireguard,debug wg1: peer connected').message, 'wg1: peer connected');
  for (const no of ['', '   ', 'hello world', 'kernel: something happened', '<13>sshd[123]: Accepted password for root', 'date=2026-10-23 time=1:1:1 type="traffic"', '<30>MikroTik']) assert.equal(parseRouterOs(no), null, JSON.stringify(no));
});

test('a firewall rule that logged', () => {
  const h = parseFirewallHit('drop-ssh input: in:ether1 out:(unknown 0), connection-state:new src-mac 4c:5e:0c:aa:bb:cc, proto TCP (SYN), 185.1.2.3:44213->203.0.113.2:22, len 60');
  assert.deepEqual([h.prefix, h.chain, h.inIf, h.proto, h.src, h.sport, h.dst, h.dport, h.service], ['drop-ssh', 'input', 'ether1', 'TCP', '185.1.2.3', 44213, '203.0.113.2', 22, 'SSH']);
  const n = parseFirewallHit('drop-bad forward: in:bridge out:ether1, src-mac 4c:5e:0c:aa:bb:cc, proto TCP (ACK,PSH), 192.168.88.10:51000->1.1.1.1:443, NAT 192.168.88.10:51000->(203.0.113.2:51000)->1.1.1.1:443, len 60');
  assert.deepEqual([n.chain, n.src, n.dst, n.dport, n.service], ['forward', '192.168.88.10', '1.1.1.1', 443, 'HTTPS'], 'the connection as it was, not as it was translated');
  const i = parseFirewallHit('input: in:ether1 out:(unknown 0), proto ICMP (type 8, code 0), 1.2.3.4->5.6.7.8, len 84'); assert.deepEqual([i.prefix, i.service, i.dport, i.src], [null, 'ICMP', null, '1.2.3.4']);
  assert.equal(parseFirewallHit('something else'), null); assert.equal(parseFirewallHit('input: in:ether1 out:x, proto TCP, not an address'), null);
  assert.equal(parseFirewallHit('drop-x input: in:ether1 out:(unknown 0), proto UDP, 1.2.3.4:5->6.7.8.9:51820, len 70').service, 'WireGuard'); assert.equal(parseFirewallHit('x input: in:e out:f, proto UDP, 1.2.3.4:5->6.7.8.9:40000, len 70').service, 'UDP/40000');
});

test('what a RouterOS line means', () => {
  let c = cls('<30>system,error,critical login failure for user admin from 185.1.2.3 via ssh'); assert.deepEqual([c.finding.kind, c.finding.level, c.finding.user, c.finding.srcip], ['admin_login_failed', 'warning', 'admin', '185.1.2.3']); assert.equal(c.finding.summary, 'Admin login failed: admin from 185.1.2.3 (ssh)');
  c = cls('system,info,account user ana logged in from 192.168.88.2 via winbox'); assert.deepEqual([c.finding.kind, c.finding.level, c.finding.user, c.finding.srcip], ['admin_login', 'info', 'ana', '192.168.88.2']);
  c = cls('system,info filter rule changed by winbox-3.40:admin(192.168.88.2)'); assert.deepEqual([c.finding.kind, c.finding.user], ['config_change', 'winbox-3.40:admin(192.168.88.2)']); assert.match(c.finding.summary, /^Changed filter rule by winbox-3\.40:admin/);
  assert.equal(cls('system,info address list entry added by admin').finding.kind, 'config_change');
  c = cls('interface,info ether1 link down'); assert.deepEqual([c.finding.kind, c.finding.level, c.finding.summary], ['system_event', 'warning', 'Interface ether1 link down']);
  c = cls('interface,info ether1 link up (speed 1G, full duplex)'); assert.deepEqual([c.finding.level, c.finding.summary], ['info', 'Interface ether1 link up (speed 1G, full duplex)']);
  assert.equal(cls('system,info,critical router rebooted because of power loss').finding.kind, 'system_event'); assert.equal(cls('system,error,critical something is wrong with the disk').finding.level, 'warning');
  c = cls('l2tp,ppp,info,account bob logged in, 10.0.0.5'); assert.deepEqual([c.finding.kind, c.finding.user, c.finding.srcip], ['vpn_login', 'bob', null]); assert.equal(c.finding.summary, 'VPN up: bob (10.0.0.5)');
  assert.equal(cls('ppp,info,account bob logged out, 3600 120000 450000').finding.kind, 'vpn_logout');
  c = cls('ppp,error,account l2tp-in: authentication failed for user bob from 45.9.9.9'); assert.deepEqual([c.finding.kind, c.finding.srcip], ['vpn_login_failed', '45.9.9.9']);
  for (const none of ['dhcp,info dhcp1 assigned 192.168.88.50 to AA:BB:CC:DD:EE:FF', 'system,info item rebuilt', 'wireguard,debug wg1: peer connected', 'script,info hello']) assert.equal(cls(none), null, none);
});

test('a firewall hit counts only when the rule is one that drops', () => {
  const hit = 'firewall,info drop-ssh input: in:ether1 out:(unknown 0), proto TCP (SYN), 185.1.2.3:44213->203.0.113.2:22, len 60';
  assert.equal(cls(hit).hit.src, '185.1.2.3'); assert.equal(cls(hit.replace('drop-ssh', 'accept-dns')), null, 'a rule that accepts and logs is not a block'); assert.equal(cls(hit.replace('drop-ssh ', '')), null, 'and one with no prefix is not known to be one');
  for (const p of ['Drop-WAN', 'block-in', 'deny:', 'bad-tcp', 'brute-force', 'SCAN', 'ban-list', 'blacklist']) assert.ok(cls(hit.replace('drop-ssh', p)).hit, p);
  assert.ok(classifyRouterOs(parseRouterOs(hit.replace('drop-ssh', 'my-rule')), /my-rule/).hit, 'the pattern can be chosen');
});

test('which networks are "inside"', () => {
  const nets = parseNetworks('10.0.0.0/8, 192.168.0.0/16;fc00::/7 172.16.0.0/12 8.8.8.8');
  for (const ip of ['10.1.2.3', '192.168.88.10', '172.31.255.255', 'fd12:3456::1', '8.8.8.8']) assert.equal(contains(nets, ip), true, ip);
  for (const ip of ['172.32.0.1', '8.8.4.4', '1.1.1.1', '2001:db8::1', 'not an ip', '::ffff:10.1.2.3'.replace('::ffff:', '')]) if (ip !== '10.1.2.3') assert.equal(contains(nets, ip), false, ip);
  assert.equal(contains(parseNetworks('0.0.0.0/0'), '5.5.5.5'), true); assert.equal(contains(parseNetworks('::1'), '::1'), true); assert.equal(contains(parseNetworks('10.0.0.1'), '10.0.0.2'), false);
  for (const bad of ['10.0.0.0/33', 'x/8', '10.0.0.0/', '300.1.1.1/8', '10.0.0.0/-1', '10.0.0.0/8/8']) assert.throws(() => parseNetworks(bad), /is not a network/, bad);
  assert.deepEqual(parseNetworks(''), []);
});

const flow = (o = {}) => ({ src: '192.168.88.10', dst: '142.250.74.46', sport: 51000, dport: 443, proto: 6, bytes: 123456, packets: 90, ...o });

test('NetFlow v5', () => {
  const r = decode(N.v5([flow(), flow({ src: '10.0.0.5', dst: '8.8.8.8', sport: 5353, dport: 53, proto: 17, bytes: 99, packets: 1 })]), '10.9.0.1', new Map());
  assert.equal(r.version, 5); assert.deepEqual(r.flows.map((f) => [f.src, f.dst, f.sport, f.dport, f.proto, f.bytes, f.packets]), [['192.168.88.10', '142.250.74.46', 51000, 443, 6, 123456, 90], ['10.0.0.5', '8.8.8.8', 5353, 53, 17, 99, 1]]);
});

test('NetFlow v9: the template comes first, then the data, which may come in a packet of its own', () => {
  const cache = new Map(); const tpl = N.set(0, N.template(256, N.MIKROTIK));
  const a = decode(N.v9([tpl, N.set(256, Buffer.concat([N.record(flow()), N.record(flow({ dst: '1.1.1.1', dport: 53, proto: 17, bytes: 70 }))]))]), '10.9.0.1', cache);
  assert.equal(a.version, 9); assert.deepEqual(a.flows.map((f) => [f.dst, f.dport, f.proto, f.bytes, f.inIf, f.outIf]), [['142.250.74.46', 443, 6, 123456, 1, 2], ['1.1.1.1', 53, 17, 70, 1, 2]], 'including the padding at the end of the flowset');
  const b = decode(N.v9([N.set(256, N.record(flow({ bytes: 5 })))]), '10.9.0.1', cache); assert.deepEqual(b.flows.map((f) => f.bytes), [5], 'the template is remembered');
  const other = decode(N.v9([N.set(256, N.record(flow()))]), '10.9.0.2', cache); assert.deepEqual([other.flows.length, other.unknownTemplate], [0, 1], 'for each exporter');
  const dom = decode(N.v9([N.set(256, N.record(flow()))], { sourceId: 7 }), '10.9.0.1', cache); assert.equal(dom.unknownTemplate, 1, 'and each source id');
  const again = decode(N.v9([N.set(0, N.template(256, [[8, 4], [12, 4], [1, 8]])), N.set(256, Buffer.concat([N.ip4('1.1.1.1'), N.ip4('2.2.2.2'), N.u(5_000_000_000, 8)]))]), '10.9.0.1', cache); assert.deepEqual(again.flows.map((f) => f.bytes), [5_000_000_000], 'a template can be replaced; 8-byte counters');
  const opt = decode(N.v9([N.set(1, Buffer.alloc(12)), tpl, N.set(256, N.record(flow()))]), '10.9.0.3', new Map()); assert.equal(opt.flows.length, 1, 'an options template is passed over');
});

test('NetFlow v9 with IPv6, and fields that do not matter', () => {
  const t = N.set(0, N.template(300, [[27, 16], [28, 16], [1, 4], [4, 1], [7, 2], [11, 2], [152, 8], [10, 2]]));
  const d = N.set(300, Buffer.concat([N.ip6('fd00::5'), N.ip6('2606:4700::1111'), N.u(777, 4), N.u(6, 1), N.u(40000, 2), N.u(443, 2), N.u(0, 8), N.u(3, 2)]));
  const r = decode(N.v9([t, d]), '10.9.0.1', new Map()); assert.deepEqual(r.flows.map((f) => [f.src, f.dst, f.bytes, f.dport, f.inIf]), [['fd00::5', '2606:4700::1111', 777, 443, 3]]);
});

test('IPFIX: enterprise fields and variable-length fields are stepped over', () => {
  const fields = [[8, 4], [12, 4], [85, 8], [86, 8], [4, 1], [7, 2], [11, 2], [999, 4, 12345], [96, 65535]];
  const rec = (f, name, ext) => Buffer.concat([N.ip4(f.src), N.ip4(f.dst), N.u(f.bytes, 8), N.u(f.packets, 8), N.u(f.proto, 1), N.u(f.sport, 2), N.u(f.dport, 2), N.u(0xdeadbeef, 4), ext ? Buffer.concat([N.u(255, 1), N.u(name.length, 2), Buffer.from(name)]) : Buffer.concat([N.u(name.length, 1), Buffer.from(name)])]);
  const a = decode(N.ipfix([N.set(2, N.template(400, fields, true)), N.set(400, Buffer.concat([rec(flow({ bytes: 1000 }), 'chrome'), rec(flow({ bytes: 2000 }), 'x'.repeat(300), true)]))]), '10.9.0.1', new Map());
  assert.equal(a.version, 10); assert.deepEqual(a.flows.map((f) => [f.src, f.bytes, f.packets, f.dport]), [['192.168.88.10', 1000, 90, 443], ['192.168.88.10', 2000, 90, 443]]);
});

test('a packet that cannot be read is dropped without harm', () => {
  const cache = new Map();
  for (const bad of [Buffer.alloc(0), Buffer.from('hello'), Buffer.alloc(30), N.v5([flow()]).slice(0, 30), N.v9([N.set(0, N.template(256, N.MIKROTIK))]).slice(0, 26), Buffer.concat([N.u(9, 2), Buffer.alloc(40, 0xff)]), Buffer.concat([N.u(10, 2), Buffer.alloc(40, 0xff)])]) {
    const r = decode(bad, '10.9.0.1', cache); assert.ok(Array.isArray(r.flows)); assert.ok(r.flows.length <= 1);
  }
  const trunc = N.v9([N.set(0, N.template(256, N.MIKROTIK)), N.set(256, N.record(flow()))]); assert.equal(decode(trunc.slice(0, trunc.length - 7), '10.9.0.1', new Map()).flows.length, 0, 'a record cut short is not guessed at');
  for (let i = 0; i < 300; i++) { const noise = Buffer.alloc(80); for (let j = 0; j < 80; j++) noise[j] = (i * 31 + j * 17) & 255; noise.writeUInt16BE(i % 2 ? 9 : 10, 0); assert.doesNotThrow(() => decode(noise, '10.9.0.9', cache)); }
});
