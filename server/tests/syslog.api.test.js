'use strict';

// The syslog receiver in a running server: real UDP datagrams and TCP lines from the test, the pages that read what arrived, and who may see it.

const test = require('node:test');
const assert = require('node:assert/strict');
const dgram = require('node:dgram');
const net = require('node:net');
const { startServer, clientsFor } = require('./_helpers');

const S = '/api/syslog';
let srv; let c; let udpPort; let tcpPort;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const freeUdp = () => new Promise((r) => { const s = dgram.createSocket('udp4'); s.bind(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => r(p)); }); });
const freeTcp = () => new Promise((r) => { const s = net.createServer(); s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => r(p)); }); });
const udp = (text, port = udpPort) => new Promise((r) => { const s = dgram.createSocket('udp4'); s.send(Buffer.from(text), port, '127.0.0.1', () => { s.close(); r(); }); });
const tcp = (chunks, port = tcpPort) => new Promise((r, j) => { const s = net.connect(port, '127.0.0.1', async () => { for (const ch of chunks) { s.write(ch); await sleep(30); } s.end(); r(); }); s.on('error', j); });
const status = async () => (await c.operator.get(`${S}/status`)).body;
const until = async (fn, ms = 4000) => { const t = Date.now(); for (;;) { const v = await fn(); if (v) return v; if (Date.now() - t > ms) throw new Error('timed out'); await sleep(60); } };

const HEAD = 'date=2026-10-23 time=13:05:00 devname="FG-100F" devid="FG100FTK21000001"';
const traffic = (src, out, inn, extra = '') => `<189>${HEAD} logid="0000000013" type="traffic" subtype="forward" level="notice" srcip=${src} dstip=142.250.74.46 dstcountry="United States" action="close" policyid=3 service="HTTPS" app="Google.Services" sentbyte=${out} rcvdbyte=${inn}${extra}`;
const deny = `<189>${HEAD} logid="0000000013" type="traffic" subtype="forward" level="warning" srcip=185.1.2.3 dstip=203.0.113.2 action="deny" policyid=0 service="RDP"`;
const adminFail = (user) => `<185>${HEAD} logid="0100032002" type="event" subtype="system" level="alert" logdesc="Admin login failed" user="${user}" ui="https(185.1.2.3)" srcip=185.1.2.3 dstip=10.1.0.1 action="login" status="failed" reason="name_invalid"`;

test.before(async () => { srv = await startServer(); c = await clientsFor(srv); udpPort = await freeUdp(); tcpPort = await freeTcp(); });
test.after(() => srv?.stop());

test('firewall logs are for operators and administrators; the settings for administrators', async () => {
  assert.equal((await c.anon.get(`${S}/status`)).status, 401);
  for (const p of ['/status', '/summary', '/events']) { assert.equal((await c.viewer.get(`${S}${p}`)).status, 403, p); assert.equal((await c.operator.get(`${S}${p}`)).status, 200, p); }
  assert.equal((await c.operator.get(`${S}/settings`)).status, 403); assert.equal((await c.operator.put(`${S}/settings`, { enabled: true })).status, 403);
  const d = (await c.admin.get(`${S}/settings`)).body; assert.deepEqual([d.enabled, d.udp_port, d.tcp_port, d.fail_count], [0, 5140, 0, 3]);
  for (const [b, re] of [[{ udp_port: 99999 }, /udp port/], [{ allowed_sources: 'evil.example' }, /is not an IP address/], [{ fail_count: 0 }, /fail count/], [{ enabled: 1 }, /true or false/]]) { const r = await c.admin.put(`${S}/settings`, b); assert.equal(r.status, 400, JSON.stringify(b)); assert.match(r.body.error, re); }
  const st = await status(); assert.deepEqual([st.enabled, st.udp.listening, st.tcp.listening], [false, false, false]);
});

test('a sender that is not known is turned away, and counted', async () => {
  const on = await c.admin.put(`${S}/settings`, { enabled: true, udp_port: udpPort, tcp_port: tcpPort, allowed_sources: '', fail_count: 2 }); assert.equal(on.status, 200);
  await until(async () => { const s = await status(); return s.udp.listening && s.tcp.listening; });
  await udp(traffic('10.1.0.55', 1, 2)); const st = await until(async () => { const s = await status(); return s.counters.rejected >= 1 && s; });
  assert.deepEqual([st.counters.parsed, st.devices.length, st.rejected[0].ip], [0, 0, '127.0.0.1']);
});

test('UDP and TCP: lines arrive, several in a datagram, a line cut in two, and what is not a log is counted', async () => {
  assert.equal((await c.admin.put(`${S}/settings`, { allowed_sources: '127.0.0.1' })).status, 200); await sleep(2100); // the list of senders is read afresh every two seconds
  await udp(traffic('10.1.0.55', 100, 900)); await udp(`${traffic('10.1.0.56', 50, 450)}\n${deny}\n`); await udp('this is not a firewall log');
  const line = traffic('10.1.0.55', 10, 90);
  await tcp([`${traffic('10.1.0.57', 1000, 9000)}\n`, `${line.slice(0, 40)}`, `${line.slice(40)}\n`, 'garbage line\n', `${adminFail('admin')}\n`]);
  const st = await until(async () => { const s = await status(); return s.counters.parsed >= 6 && s; });
  assert.deepEqual([st.counters.parsed, st.counters.unparsed], [6, 2], 'three by UDP and three by TCP; the two that are not logs'); assert.deepEqual(st.devices.map((d) => [d.device, d.ip, d.silent]), [['FG-100F', '127.0.0.1', false]]); assert.ok(st.devices[0].seconds_ago < 10);
});

test('what arrived is summed up, and the events are there', async () => {
  const s = (await c.operator.get(`${S}/summary?range=24h`)).body;
  assert.deepEqual([s.sessions, s.blocked, s.bytes_out, s.bytes_in], [5, 1, 1160, 10440], 'the datagrams, the lines and the denied one');
  assert.deepEqual(s.top.src.slice(0, 2).map((r) => [r.key, r.bytes]), [['10.1.0.57', 10000], ['10.1.0.55', 1100]]); assert.deepEqual(s.top.blocked_src.map((r) => r.key), ['185.1.2.3']);
  assert.deepEqual(s.top.country.map((r) => r.key), ['United States']); assert.deepEqual(s.top.service.map((r) => r.key).sort(), ['HTTPS', 'RDP']); assert.deepEqual(s.devices, ['FG-100F']); assert.equal(s.timeline.length, 1);
  assert.deepEqual(s.events, [{ kind: 'admin_login_failed', level: 'warning', n: 1 }]);
  assert.equal((await c.operator.get(`${S}/summary?range=2w`)).status, 400); assert.equal((await c.operator.get(`${S}/summary?range=24h&device=nope`)).body.sessions, 0);
  const e = (await c.operator.get(`${S}/events?kind=admin_login_failed`)).body; assert.deepEqual([e.length, e[0].user, e[0].srcip, e[0].device], [1, 'admin', '185.1.2.3', 'FG-100F']); assert.match(e[0].raw, /logdesc="Admin login failed"/);
});

test('a burst of failed logins is announced once', async () => {
  await udp(adminFail('root')); await udp(adminFail('test'));
  await until(async () => (await c.operator.get(`${S}/events?kind=admin_login_failed`)).body.length >= 3);
  const text = JSON.stringify((await c.admin.get('/api/notifications')).body);
  assert.match(text, /2 failed administrator logins on FG-100F from 185\.1\.2\.3 in 10 min \(user: admin, root\)/, 'at the second failure, as the setting says; the third is quiet'); assert.equal((text.match(/failed administrator logins on FG-100F/g) || []).length, 1);
  assert.equal((await c.operator.get(`${S}/events?q=root`)).body.length, 1);
});

test('a port that is taken is explained; switching off stops listening', async () => {
  const hog = dgram.createSocket('udp4'); const taken = await new Promise((r) => hog.bind(0, '0.0.0.0', () => r(hog.address().port)));
  assert.equal((await c.admin.put(`${S}/settings`, { udp_port: taken })).status, 200);
  const st = await until(async () => { const s = await status(); return s.udp.error && s; }); assert.match(st.udp.error, new RegExp(`UDP port ${taken} is in use by another program`)); assert.equal(st.udp.listening, false);
  hog.close(); assert.equal((await c.admin.put(`${S}/settings`, { udp_port: udpPort })).status, 200); await until(async () => (await status()).udp.listening);
  assert.equal((await c.admin.put(`${S}/settings`, { enabled: false })).status, 200); const off = await until(async () => { const s = await status(); return !s.udp.listening && !s.tcp.listening && s; });
  const before = off.counters.received; await udp(traffic('10.1.0.99', 1, 1)); await sleep(300); assert.equal((await status()).counters.received, before, 'nothing is read when it is off');
  assert.ok(JSON.stringify((await c.admin.get('/api/audit-log?limit=100')).body).includes('syslog.settings'));
});
