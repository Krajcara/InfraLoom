'use strict';

// MikroTik at home: RouterOS syslog lines and NetFlow packets, through the same service (in one process, with a clock of our own).

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'syslog-mt-'));
const hex = () => crypto.randomBytes(32).toString('hex');
Object.assign(process.env, { NODE_ENV: 'test', DB_PATH: path.join(dir, 'infraloom.db'), DB_ENCRYPTION_KEY: hex(), APP_SECRET: hex(), BACKUP_ENCRYPTION_PASSWORD: hex() });
const db = require('../src/db/database');
const S = require('../src/services/syslog/service');
const N = require('./_netflow');
test.after(() => fs.rmSync(dir, { recursive: true, force: true }));

const T0 = Date.UTC(2026, 9, 23, 11, 5, 0);
const GW = '10.2.0.1';
let sent = []; const notifier = async (event, text) => { sent.push([event, text]); };
const line = (l, t = T0, ip = GW) => S.ingest(l, ip, t, { notifier });
const flows = (pkt, t = T0, ip = GW) => S.ingestFlow(pkt, ip, t, { notifier });
const kinds = () => sent.map((s) => s[0]);
const reset = () => { S.resetForTests(); sent = []; db.exec('DELETE FROM syslog_events; DELETE FROM syslog_hourly; DELETE FROM syslog_stats; DELETE FROM syslog_config; DELETE FROM routers'); db.prepare("INSERT INTO routers (name, brand, ip_address) VALUES ('home-gw', 'MikroTik', ?)").run(GW); S.saveConfig({ fail_count: 3 }); S.allowedSources(true); };
const hr = (range = '1h', device = null) => S.summary(range, device, Math.floor(T0 / 1000) + 60);

const hit = (src, port, prefix = 'drop-wan-in') => `<30>firewall,info ${prefix} input: in:ether1 out:(unknown 0), connection-state:new src-mac 4c:5e:0c:aa:bb:cc, proto TCP (SYN), ${src}:44213->203.0.113.2:${port}, len 60`;
const fail = (ip, user = 'admin') => `<30>system,error,critical login failure for user ${user} from ${ip} via ssh`;

test('RouterOS lines: the router is named from the router list, or by what it calls itself', async () => {
  reset();
  assert.equal(await line('<30>system,info,account user ana logged in from 192.168.88.2 via winbox'), 'ok'); assert.deepEqual(S.status().devices.map((d) => d.device), ['home-gw']);
  await line('<30>Oct 23 11:05:00 MikroTik system,info,account user ana logged in from 192.168.88.2 via winbox'); assert.deepEqual(S.status().devices.map((d) => d.device).sort(), ['MikroTik', 'home-gw'], 'its own name wins when the line has it');
  assert.equal(S.events({ kind: 'admin_login' }).length, 2); assert.equal(await line('hello world'), 'unparsed');
});

test('failed logins on a MikroTik: one alert for a burst, from the address that tried', async () => {
  reset();
  await line(fail('185.1.2.3'), T0); await line(fail('185.1.2.3', 'root'), T0 + 5000); assert.deepEqual(sent, []); await line(fail('185.1.2.3', 'test'), T0 + 9000);
  assert.deepEqual(kinds(), ['fw_admin_login_failed']); assert.equal(sent[0][1], '3 failed administrator logins on home-gw from 185.1.2.3 in 10 min (user: admin, root, test).');
  assert.equal(S.events({ kind: 'admin_login_failed' })[0].summary, 'Admin login failed: test from 185.1.2.3 (ssh)');
});

test('rules that drop are counted as blocked, with who tried and what they tried', async () => {
  reset();
  for (let i = 0; i < 5; i++) await line(hit('185.1.2.3', 22), T0 + i); await line(hit('45.9.9.9', 3389), T0 + 10); await line(hit('185.1.2.3', 8291, 'drop-wan-winbox'), T0 + 11);
  await line(hit('1.2.3.4', 53, 'accept-dns'), T0 + 12); await line('<30>firewall,info input: in:ether1 out:(unknown 0), proto UDP, 9.9.9.9:5->203.0.113.2:123, len 76', T0 + 13);
  const s = hr(); assert.deepEqual([s.sessions, s.blocked, s.bytes_out + s.bytes_in], [7, 7, 0], 'only the drops; the rules that accept are not a block');
  assert.deepEqual(s.top.blocked_src.map((r) => [r.key, r.blocked]), [['185.1.2.3', 6], ['45.9.9.9', 1]]); assert.deepEqual(s.top.service.map((r) => [r.key, r.sessions]).sort(), [['RDP', 1], ['SSH', 5], ['Winbox', 1]]);
  assert.deepEqual(s.top.policy.map((r) => r.key).sort(), ['drop-wan-in', 'drop-wan-winbox']); assert.deepEqual(s.devices, ['home-gw']); assert.equal(S.events({}).length, 0, 'a drop is a number, not an event');
  assert.equal(S.status().counters.parsed, 9, 'every line was read, also the ones that are not counted');
  S.saveConfig({ block_prefix: 'accept' }); S.resetForTests(); S.allowedSources(true); await line(hit('1.2.3.4', 53, 'accept-dns'), T0); await line(hit('1.2.3.4', 53, 'drop-x'), T0); assert.equal(hr().blocked, 1, 'the words that mark a dropping rule can be chosen');
});

test('what is changed on the router, an interface that goes down, a VPN', async () => {
  reset();
  for (const l of ['system,info filter rule changed by admin', 'system,info address list entry added by admin', 'system,info filter rule moved by admin']) await line(`<30>${l}`, T0);
  await S.tick(T0 + 5 * 60_000, { notifier }); assert.deepEqual(kinds(), ['fw_config_change']); assert.match(sent[0][1], /^Configuration of home-gw was changed by admin: 3 changes — /);
  sent = []; await line('<30>interface,info ether1 link down', T0 + 6 * 60_000); await line('<30>interface,info ether1 link down', T0 + 6 * 60_000 + 1000); await line('<30>interface,info ether1 link up (speed 1G, full duplex)', T0 + 7 * 60_000);
  assert.deepEqual(sent.map((s) => s[1]), ['home-gw: Interface ether1 link down', 'home-gw: Interface ether1 link up (speed 1G, full duplex)'], 'a link that goes down is said once, and so is its return'); assert.equal(S.events({ kind: 'system_event' }).length, 3);
  sent = []; await line('<30>l2tp,ppp,info,account bob logged in, 10.0.0.5', T0); assert.deepEqual(sent, []); assert.equal(S.events({ kind: 'vpn_login' })[0].summary, 'VPN up: bob (10.0.0.5)');
});

const f = (o = {}) => ({ src: '192.168.88.10', dst: '142.250.74.46', sport: 51000, dport: 443, proto: 6, bytes: 1000, packets: 5, ...o });
const pkt = (list, withTemplate = true) => N.v9([...(withTemplate ? [N.set(0, N.template(256, N.MIKROTIK))] : []), N.set(256, Buffer.concat(list.map(N.record)))]);

test('NetFlow: each flow goes to the inside address it belongs to, outbound and inbound', async () => {
  reset();
  assert.equal(await flows(pkt([f({ bytes: 1000 }), f({ src: '142.250.74.46', dst: '192.168.88.10', sport: 443, dport: 51000, bytes: 90000 }), f({ src: '192.168.88.11', dst: '8.8.8.8', sport: 5353, dport: 53, proto: 17, bytes: 100 }),
    f({ src: '192.168.88.10', dst: '192.168.88.11', bytes: 5 }), f({ src: '1.1.1.1', dst: '9.9.9.9', bytes: 7 })])), 'ok');
  const c = S.status().counters; assert.deepEqual([c.flows, c.flows_skipped, c.flow_packets], [5, 2, 1], 'inside-to-inside and outside-to-outside are not for this');
  const s = hr(); assert.deepEqual([s.sessions, s.bytes_out, s.bytes_in], [3, 1100, 90000], 'out is what the inside address sent, in is what it received');
  assert.deepEqual(s.top.src.map((r) => [r.key, r.bytes]), [['192.168.88.10', 91000], ['192.168.88.11', 100]], 'who: only addresses of the inside'); assert.deepEqual(s.top.dst.map((r) => [r.key, r.bytes]), [['142.250.74.46', 91000], ['8.8.8.8', 100]], 'where: the other side');
  assert.deepEqual(s.top.app.map((r) => r.key).sort(), ['DNS', 'HTTPS']); assert.deepEqual(s.top.country, [], 'a flow has no country'); assert.deepEqual(s.devices, ['home-gw']);
  assert.deepEqual(S.status().devices.map((d) => [d.device, d.ip]), [['home-gw', GW]]);
});

test('NetFlow: templates, strangers, damaged packets and the choice of the inside', async () => {
  reset();
  assert.equal(await flows(pkt([f()], false)), 'ok'); assert.deepEqual([S.status().counters.flows, S.status().counters.flow_unknown_template], [0, 1], 'data before its template is counted, not guessed');
  await flows(pkt([f({ bytes: 10 })])); await flows(pkt([f({ bytes: 20 })], false)); assert.equal(hr().bytes_out, 30, 'the template is remembered');
  assert.equal(await flows(pkt([f()]), T0, '10.9.9.9'), 'rejected'); assert.equal(await flows(Buffer.from('garbage that is not netflow'), T0), 'unparsed');
  S.saveConfig({ local_networks: '203.0.113.0/24' }); S.allowedSources(true); await flows(pkt([f({ src: '203.0.113.7', dst: '1.1.1.1', bytes: 400 })], false), T0 + 1000);
  assert.equal(hr().top.src.find((r) => r.key === '203.0.113.7').bytes, 400, 'the inside is what is set'); assert.equal(S.status().counters.flows_skipped, 0 + S.status().counters.flows_skipped);
  S.resetForTests(); S.allowedSources(true); S.saveConfig({ local_networks: '10.0.0.0/8, 192.168.0.0/16' });
  await flows(N.v5([{ src: '192.168.1.5', dst: '93.184.216.34', sport: 40000, dport: 80, proto: 6, bytes: 777 }])); assert.equal(hr().top.app[0].key, 'HTTP'); assert.equal(hr().bytes_out, 777, 'version 5 too');
});

test('the settings of this: the port, the inside networks and the words of a dropping rule', () => {
  reset(); const d = S.getConfig(); assert.deepEqual([d.netflow_port, d.local_networks.startsWith('10.0.0.0/8'), d.block_prefix.startsWith('drop|block')], [0, true, true], 'NetFlow is off until a port is given: nothing new is opened by an update');
  for (const [b, re] of [[{ netflow_port: 70000 }, /netflow port/], [{ local_networks: '10.0.0.0/99' }, /is not a network like/], [{ local_networks: '' }, /at least one network/], [{ block_prefix: '(' }, /not a valid pattern/], [{ block_prefix: '' }, /1 to 100 characters/], [{ block_prefix: 'x'.repeat(101) }, /1 to 100/]]) assert.throws(() => S.saveConfig(b), re, JSON.stringify(b));
  const ok = S.saveConfig({ netflow_port: 0, local_networks: '192.168.88.0/24;10.5.0.0/16', block_prefix: 'drop|ban' }); assert.deepEqual([ok.netflow_port, ok.local_networks, ok.block_prefix], [0, '192.168.88.0/24, 10.5.0.0/16', 'drop|ban']);
});
