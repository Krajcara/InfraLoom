'use strict';

// A MikroTik's syslog and NetFlow in a running server: real UDP datagrams to two ports.

const test = require('node:test');
const assert = require('node:assert/strict');
const dgram = require('node:dgram');
const { startServer, clientsFor } = require('./_helpers');
const N = require('./_netflow');

const S = '/api/syslog';
let srv; let c; let syslogPort; let flowPort;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const freeUdp = () => new Promise((r) => { const s = dgram.createSocket('udp4'); s.bind(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => r(p)); }); });
const udp = (data, port) => new Promise((r) => { const s = dgram.createSocket('udp4'); s.send(Buffer.isBuffer(data) ? data : Buffer.from(data), port, '127.0.0.1', () => { s.close(); r(); }); });
const status = async () => (await c.operator.get(`${S}/status`)).body;
const until = async (fn, ms = 4000) => { const t = Date.now(); for (;;) { const v = await fn(); if (v) return v; if (Date.now() - t > ms) throw new Error('timed out'); await sleep(60); } };

test.before(async () => { srv = await startServer(); c = await clientsFor(srv); syslogPort = await freeUdp(); flowPort = await freeUdp(); });
test.after(() => srv?.stop());

test('the settings for NetFlow and for MikroTik, and the two ports listening', async () => {
  const d = (await c.admin.get(`${S}/settings`)).body; assert.deepEqual([d.netflow_port, d.local_networks.startsWith('10.0.0.0/8'), d.block_prefix.startsWith('drop|')], [0, true, true]); assert.equal((await c.operator.get(`${S}/status`)).body.netflow.port, 0);
  for (const [b, re] of [[{ netflow_port: 70000 }, /netflow port/], [{ local_networks: 'office' }, /is not a network like/], [{ block_prefix: '[' }, /not a valid pattern/]]) { const r = await c.admin.put(`${S}/settings`, b); assert.equal(r.status, 400, JSON.stringify(b)); assert.match(r.body.error, re); }
  assert.equal((await c.admin.put(`${S}/settings`, { enabled: true, udp_port: syslogPort, netflow_port: flowPort, allowed_sources: '127.0.0.1', local_networks: '192.168.88.0/24' })).status, 200);
  const st = await until(async () => { const s = await status(); return s.udp.listening && s.netflow.listening && s; }); assert.equal(st.netflow.port, flowPort);
});

test('RouterOS lines and NetFlow packets arrive and are summed up', async () => {
  await sleep(2100);
  for (const l of ['<30>system,error,critical login failure for user admin from 185.1.2.3 via ssh', '<30>system,error,critical login failure for user root from 185.1.2.3 via ssh', '<30>system,error,critical login failure for user test from 185.1.2.3 via ssh',
    '<30>firewall,info drop-wan-in input: in:ether1 out:(unknown 0), proto TCP (SYN), 185.1.2.3:44213->203.0.113.2:22, len 60', '<30>firewall,info drop-wan-in input: in:ether1 out:(unknown 0), proto TCP (SYN), 45.9.9.9:1->203.0.113.2:3389, len 60', '<30>interface,info ether1 link down']) await udp(l, syslogPort);
  const tpl = N.set(0, N.template(256, N.MIKROTIK)); const rec = (o) => N.record({ proto: 6, packets: 3, sport: 51000, dport: 443, ...o });
  await udp(N.v9([tpl, N.set(256, Buffer.concat([rec({ src: '192.168.88.10', dst: '142.250.74.46', bytes: 5000 }), rec({ src: '142.250.74.46', dst: '192.168.88.10', sport: 443, dport: 51000, bytes: 400000 }), rec({ src: '192.168.88.11', dst: '8.8.8.8', bytes: 1200, dport: 53, proto: 17 })]))]), flowPort);
  const st = await until(async () => { const s = await status(); return s.counters.flows >= 3 && s.counters.parsed >= 6 && s; });
  assert.deepEqual([st.counters.flows, st.counters.flow_packets, st.counters.parsed], [3, 1, 6]); assert.deepEqual(st.devices.map((d) => d.device), ['127.0.0.1'], 'no router of that address in the list: it is named by its address');
  const s = (await c.operator.get(`${S}/summary?range=24h`)).body;
  assert.deepEqual([s.sessions, s.blocked, s.bytes_out, s.bytes_in], [5, 2, 6200, 400000]);
  assert.deepEqual(s.top.src.slice(0, 2).map((r) => [r.key, r.bytes]), [['192.168.88.10', 405000], ['192.168.88.11', 1200]]); assert.deepEqual(s.top.blocked_src.map((r) => [r.key, r.blocked]), [['185.1.2.3', 1], ['45.9.9.9', 1]]);
  assert.deepEqual(s.top.service.map((r) => r.key).sort(), ['DNS', 'HTTPS', 'RDP', 'SSH']);
  const e = (await c.operator.get(`${S}/events`)).body; assert.deepEqual(e.map((x) => x.kind).sort(), ['admin_login_failed', 'admin_login_failed', 'admin_login_failed', 'system_event']);
  const text = JSON.stringify((await c.admin.get('/api/notifications')).body);
  assert.match(text, /3 failed administrator logins on 127\.0\.0\.1 from 185\.1\.2\.3 in 10 min \(user: admin, root, test\)/); assert.match(text, /127\.0\.0\.1: Interface ether1 link down/);
});

test('a NetFlow port that is taken is explained, and 0 switches it off', async () => {
  const hog = dgram.createSocket('udp4'); const taken = await new Promise((r) => hog.bind(0, '0.0.0.0', () => r(hog.address().port)));
  assert.equal((await c.admin.put(`${S}/settings`, { netflow_port: taken })).status, 200);
  const st = await until(async () => { const s = await status(); return s.netflow.error && s; }); assert.match(st.netflow.error, new RegExp(`UDP port ${taken} \\(NetFlow\\) is in use by another program`)); assert.equal(st.netflow.listening, false);
  hog.close(); assert.equal((await c.admin.put(`${S}/settings`, { netflow_port: 0 })).status, 200); const off = await until(async () => { const s = await status(); return !s.netflow.listening && !s.netflow.error && s; }); assert.equal(off.udp.listening, true, 'the syslog goes on');
});
