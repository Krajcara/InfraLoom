'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const net = require('node:net');
const http = require('node:http');
const https = require('node:https');
const tlsLib = require('node:tls');
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const os = require('node:os');
const crypto = require('node:crypto');
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'diag-'));
const hex = () => crypto.randomBytes(32).toString('hex');
Object.assign(process.env, { NODE_ENV: 'test', DB_PATH: path.join(dir, 'infraloom.db'), DB_ENCRYPTION_KEY: hex(), APP_SECRET: hex(), BACKUP_ENCRYPTION_PASSWORD: hex() });
test.after(() => fs.rmSync(dir, { recursive: true, force: true }));
const D = require('../src/services/diagnostics'); // (it uses the settings of the DNS servers, so it needs a database)
const { startFakeDns } = require('./_fakeDns');

const has = (cmd) => spawnSync('sh', ['-c', `command -v ${cmd}`]).status === 0;
const pair = require('./_tls').makeCert(); // null without openssl: the tests that need a certificate are skipped
const { cert, key } = pair || {};
const needTls = { skip: !pair && 'openssl is not installed' };
const listen = (server) => new Promise((r) => server.listen(0, '127.0.0.1', () => r(server.address().port)));
const rejects = (p, status, re) => assert.rejects(p, (e) => e instanceof D.DiagError && e.status === status && re.test(e.message));

test('what ping, traceroute and tracepath really print is understood', () => {
  const ping = `PING 127.0.0.1 (127.0.0.1) 56(84) bytes of data.
64 bytes from 127.0.0.1: icmp_seq=1 ttl=64 time=0.025 ms
64 bytes from 127.0.0.1: icmp_seq=2 ttl=64 time=0.040 ms
64 bytes from 127.0.0.1: icmp_seq=3 ttl=64 time=0.038 ms

--- 127.0.0.1 ping statistics ---
3 packets transmitted, 3 received, 0% packet loss, time 2051ms
rtt min/avg/max/mdev = 0.025/0.034/0.040/0.006 ms`;
  assert.deepEqual(D.parsePing(ping), { resolved: '127.0.0.1', size: 56, replies: [{ seq: 1, ttl: 64, time: 0.025 }, { seq: 2, ttl: 64, time: 0.04 }, { seq: 3, ttl: 64, time: 0.038 }], sent: 3, received: 3, loss: 0, rtt: { min: 0.025, avg: 0.034, max: 0.04, mdev: 0.006 }, hints: [], error: null });
  const lost = D.parsePing('PING 203.0.113.9 (203.0.113.9) 56(84) bytes of data.\n\n--- 203.0.113.9 ping statistics ---\n1 packets transmitted, 0 received, 100% packet loss, time 0ms\n');
  assert.deepEqual([lost.sent, lost.received, lost.loss, lost.rtt], [1, 0, 100, null]);
  assert.equal(D.parsePing('ping: nosuchhost.invalid: Name or service not known\n').error, 'nosuchhost.invalid: Name or service not known');
  const frag = D.parsePing('PING 10.9.9.9 (10.9.9.9) 1472(1500) bytes of data.\nFrom 192.168.1.1 icmp_seq=1 Frag needed and DF set (mtu = 1400)\n\n--- 10.9.9.9 ping statistics ---\n1 packets transmitted, 0 received, +1 errors, 100% packet loss, time 0ms\n');
  assert.deepEqual([frag.hints, frag.loss, frag.received], [['192.168.1.1: Frag needed and DF set (mtu = 1400)'], 100, 0]);
  const unreach = D.parsePing('PING 10.9.9.9 (10.9.9.9) 56(84) bytes of data.\nFrom 10.0.0.1 icmp_seq=1 Destination Host Unreachable\n');
  assert.deepEqual(unreach.hints, ['10.0.0.1: Destination Host Unreachable']);

  assert.deepEqual(D.parseTraceroute('traceroute to 10.9.9.9 (10.9.9.9), 5 hops max, 60 byte packets\n 1  192.168.1.1  0.321 ms\n 2  *\n 3  10.1.1.1  12.5 ms !H\n 4  2001:db8::1  3.1 ms\n'),
    [{ hop: 1, address: '192.168.1.1', rtt: 0.321, note: null }, { hop: 2, address: null, rtt: null, note: 'no answer' }, { hop: 3, address: '10.1.1.1', rtt: 12.5, note: '!H' }, { hop: 4, address: '2001:db8::1', rtt: 3.1, note: null }]);
  assert.deepEqual(D.parseTracepath(' 1?: [LOCALHOST]                      pmtu 1500\n 1:  192.168.1.1                                           0.433ms \n 2:  no reply\n 3:  10.1.1.1                                              9.130ms reached\n     Resume: pmtu 1500 hops 3 back 3 \n'),
    { hops: [{ hop: 1, address: '192.168.1.1', rtt: 0.433, note: null }, { hop: 2, address: null, rtt: null, note: 'no answer' }, { hop: 3, address: '10.1.1.1', rtt: 9.13, note: 'reached' }], pmtu: 1500 });
});

test('a target can only be a host name or an address — never an option, a shell phrase or something odd', () => {
  for (const ok of ['127.0.0.1', '::1', '[2001:db8::1]', 'host_name.local', 'nas', 'a-b.example.com', '10.0.0.1', 'fe80::1%eth0']) assert.doesNotThrow(() => D.validateHost(ok), ok);
  for (const bad of ['', '   ', '-c', '--help', 'a b', '$(id)', '`id`', 'a;ls', 'a|b', 'a&b', 'a\nb', '../etc', 'host/path', 'a'.repeat(254), '-oProxyCommand=x', '::1%a b', '::1%$(id)', '::1%eth0%x', 'fe80::1%']) assert.throws(() => D.validateHost(bad), D.DiagError, JSON.stringify(bad));
});

test('the inputs of each tool are checked before anything runs', async () => {
  await rejects(D.runTool('ping', { host: '-c' }), 400, /not a host name/);
  await rejects(D.runTool('ping', { host: '127.0.0.1', count: 11 }), 400, /Count must be a whole number from 1 to 10/);
  await rejects(D.runTool('ping', { host: '127.0.0.1', size: 9001 }), 400, /Size must be/);
  await rejects(D.runTool('traceroute', { host: '127.0.0.1', maxHops: 31 }), 400, /Maximum hops/);
  await rejects(D.runTool('port', { host: '127.0.0.1', ports: '' }), 400, /at least one port/);
  await rejects(D.runTool('port', { host: '127.0.0.1', ports: '1,2,3,4,5,6,7,8,9,10,11' }), 400, /At most ten/);
  await rejects(D.runTool('port', { host: '127.0.0.1', ports: '70000' }), 400, /A port must be/);
  await rejects(D.runTool('dns', { name: 'x.example', type: 'ANY' }), 400, /Type must be one of/);
  await rejects(D.runTool('dns', { name: 'x.example', servers: ['not-an-ip'] }), 400, /“not-an-ip” is not an IP address/);
  await rejects(D.runTool('dns', { name: '8.8.8.8', type: 'A' }), 400, /only be looked up as PTR/);
  await rejects(D.runTool('dns', { name: 'x.example', servers: ['1.1.1.1', '8.8.8.8', '9.9.9.9', '1.0.0.1', '8.8.4.4'] }), 400, /At most four/);
  await rejects(D.runTool('http', { url: 'ftp://x.example' }), 400, /Only http and https/);
  await rejects(D.runTool('http', { url: 'http://a b' }), 400, /valid address/);
  await rejects(D.runTool('http', { url: 'http://127.0.0.1', method: 'POST' }), 400, /GET or HEAD/);
  await rejects(D.runTool('nope', {}), 404, /Unknown tool/);
});

test('ping, traceroute and the path MTU on this machine', { skip: !has('ping') }, async () => {
  const p = await D.runTool('ping', { host: '127.0.0.1', count: 3 });
  assert.deepEqual([p.tool, p.sent, p.received, p.loss, p.replies.length], ['ping', 3, 3, 0, 3]); assert.ok(p.rtt.avg >= 0 && p.raw.includes('127.0.0.1'));
  const df = await D.runTool('ping', { host: '127.0.0.1', count: 1, size: 1472, dontFragment: true }); assert.equal(df.received, 1); assert.equal(df.size, 1472);
  const bad = await D.runTool('ping', { host: 'nosuchhost.invalid', count: 1 }); assert.match(bad.error, /Name or service not known|Temporary failure/);
  const m = await D.runTool('mtu', { host: '127.0.0.1' }); assert.deepEqual([m.mtu, m.payload], [9000, 8972]); assert.ok(m.steps.length === 2 && m.steps.every((s) => s.ok));
  if (has('traceroute') || has('tracepath')) { const t = await D.runTool('traceroute', { host: '127.0.0.1', maxHops: 3 }); assert.equal(t.hops[0].address, '127.0.0.1'); assert.ok(['traceroute', 'tracepath'].includes(t.method)); }
});

test('TCP ports: open, closed, and the same port twice counts once', async () => {
  const srv = net.createServer((s) => s.end()); const open = await listen(srv);
  const gone = net.createServer(); const closed = await listen(gone); await new Promise((r) => gone.close(r));
  const r = await D.runTool('port', { host: '127.0.0.1', ports: [open, closed, open] });
  assert.deepEqual(r.results.map((x) => [x.port, x.status]).sort((a, b) => a[0] - b[0]), [[Math.min(open, closed), open < closed ? 'open' : 'closed'], [Math.max(open, closed), open < closed ? 'closed' : 'open']]);
  assert.ok(r.results.every((x) => x.ms >= 0));
  const str = await D.runTool('port', { host: '127.0.0.1', ports: `${open}, ${closed}` }); assert.equal(str.results.length, 2, 'a comma separated text is accepted');
  srv.close();
});

test('the TLS certificate: who it is for, who made it, until when, whether it is trusted and the name matches', needTls, async () => {
  const srv = tlsLib.createServer({ cert, key }, (s) => s.end()); const port = await listen(srv);
  const t = await D.runTool('tls', { host: '127.0.0.1', port, servername: 'localhost' });
  assert.deepEqual([t.subject, t.issuer, t.expired, t.trusted, t.nameMatches], ['localhost', 'localhost', false, false, true]);
  assert.match(t.trustError, /SELF_SIGNED|self.signed/i); assert.ok(t.sans.includes('localhost') && t.sans.includes('127.0.0.1'));
  assert.ok(t.daysLeft > 3000 && t.protocol.startsWith('TLSv1') && t.cipher && t.fingerprint256); assert.deepEqual(t.chain, [{ subject: 'localhost', issuer: 'localhost' }]);
  const wrong = await D.runTool('tls', { host: '127.0.0.1', port, servername: 'other.example' }); assert.equal(wrong.nameMatches, false);
  srv.close();
  await rejects(D.runTool('tls', { host: '127.0.0.1', port }), 502, /failed: ECONNREFUSED/);
});

test('HTTP: redirects are followed with timings, and certificate errors are reported unless asked to be ignored', needTls, async () => {
  const srv = http.createServer((req, res) => {
    if (req.url === '/a') { res.writeHead(301, { Location: '/b' }); return res.end(); }
    if (req.url === '/b') { res.writeHead(200, { 'Content-Type': 'text/plain', Server: 'test/1' }); return res.end(req.method === 'HEAD' ? undefined : 'hello'); }
    res.writeHead(404); return res.end('no');
  });
  const port = await listen(srv);
  const r = await D.runTool('http', { url: `http://127.0.0.1:${port}/a` });
  assert.deepEqual([r.redirects, r.steps.map((s) => s.status), r.final.headers.server, r.final.headers['content-type']], [1, [301, 200], 'test/1', 'text/plain']);
  assert.ok(r.final.timings.firstByte >= 0 && r.final.timings.total >= r.final.timings.firstByte && r.final.timings.connect >= 0);
  const stay = await D.runTool('http', { url: `http://127.0.0.1:${port}/a`, followRedirects: false }); assert.deepEqual([stay.redirects, stay.final.status, stay.final.headers.location], [0, 301, '/b']);
  assert.equal((await D.runTool('http', { url: `127.0.0.1:${port}/nothing`.replace(/^/, 'http://'), method: 'HEAD' })).final.status, 404);
  srv.close();
  const secure = https.createServer({ cert, key }, (req, res) => res.end('ok')); const sp = await listen(secure);
  await rejects(D.runTool('http', { url: `https://127.0.0.1:${sp}/` }), 502, /SELF_SIGNED|self.signed/i);
  const ignored = await D.runTool('http', { url: `https://127.0.0.1:${sp}/`, ignoreCertErrors: true }); assert.equal(ignored.final.status, 200); assert.ok(ignored.final.timings.tls >= 0);
  secure.close();
});

test('DNS: several servers side by side, and what differs between them', async () => {
  const inside = await startFakeDns({ 'bizcentar.com': { MX: [] , A: ['10.0.0.5'], TXT: ['v=spf1 -all'] } });
  const outside = await startFakeDns({
    'bizcentar.com': { A: ['203.0.113.7'], MX: [{ pref: 10, host: 'mx2.example.net' }, { pref: 0, host: 'mx1.example.net' }], TXT: ['v=spf1 include:spf.protection.outlook.com ~all', 'MS=ms1'] },
    '7.113.0.203.in-addr.arpa': { PTR: ['host7.example.net'] },
  });
  try {
    const a = await D.runTool('dns', { name: 'bizcentar.com', type: 'MX', servers: [inside.address, outside.address] });
    assert.deepEqual(a.results.map((r) => [r.status, r.answers]), [['nodata', []], ['ok', ['0 mx1.example.net', '10 mx2.example.net']]]); assert.equal(a.differs, true, 'the inside copy of the zone has no MX');
    const b = await D.runTool('dns', { name: 'bizcentar.com', type: 'TXT', servers: [outside.address] }); assert.deepEqual(b.results[0].answers, ['MS=ms1', 'v=spf1 include:spf.protection.outlook.com ~all']); assert.equal(b.differs, false);
    const c = await D.runTool('dns', { name: 'nothing.example', type: 'A', servers: [inside.address, outside.address] }); assert.deepEqual(c.results.map((r) => r.status), ['nxdomain', 'nxdomain']); assert.equal(c.differs, false, 'the same answer is no difference');
    const d = await D.runTool('dns', { name: 'bizcentar.com', type: 'A', servers: [inside.address, outside.address] }); assert.deepEqual(d.results.map((r) => r.answers), [['10.0.0.5'], ['203.0.113.7']]); assert.equal(d.differs, true);
    const e = await D.runTool('dns', { name: '203.0.113.7', type: 'PTR', servers: [outside.address] }); assert.deepEqual(e.results[0].answers, ['host7.example.net']);
    assert.ok(a.results.every((r) => r.ms >= 0));
  } finally { inside.close(); outside.close(); }
});

test('only four run at once; the fifth is turned away at once', async () => {
  const silent = net.createServer(() => {}); const port = await listen(silent);   // accepts, never answers the handshake
  const slow = Array.from({ length: D.MAX_RUNNING }, () => D.runTool('tls', { host: '127.0.0.1', port }).catch((e) => e));
  await new Promise((r) => setTimeout(r, 100));
  await rejects(D.runTool('tls', { host: '127.0.0.1', port }), 429, /Too many diagnostics/);
  const done = await Promise.all(slow); assert.ok(done.every((e) => e instanceof D.DiagError && e.status === 504), 'the four ended with the handshake time-out');
  silent.close();
  const fine = await D.runTool('port', { host: '127.0.0.1', ports: [port] }); assert.equal(fine.results.length, 1, 'and there is room again');
});
