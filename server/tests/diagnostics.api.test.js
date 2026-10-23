'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const net = require('node:net');
const { startServer, clientsFor } = require('./_helpers');
const { startFakeDns } = require('./_fakeDns');

let srv; let c; let tcp; let dnsd; let port;
test.before(async () => {
  srv = await startServer(); c = await clientsFor(srv);
  tcp = net.createServer((s) => s.end()); await new Promise((r) => tcp.listen(0, '127.0.0.1', r)); port = tcp.address().port;
  dnsd = await startFakeDns({ 'nas.example': { A: ['10.0.0.9'] } });
});
test.after(() => { srv?.stop(); tcp?.close(); dnsd?.close(); });

const D = '/api/diagnostics';

test('only operators and administrators run diagnostics, and a run is in the audit log', async () => {
  assert.equal((await c.anon.post(`${D}/port`, { host: '127.0.0.1', ports: [port] })).status, 401);
  assert.equal((await c.viewer.post(`${D}/port`, { host: '127.0.0.1', ports: [port] })).status, 403);
  assert.equal((await c.viewer.get(`${D}/dns-servers`)).status, 403);
  for (const who of [c.operator, c.admin]) {
    const r = await who.post(`${D}/port`, { host: '127.0.0.1', ports: [port] });
    assert.equal(r.status, 200); assert.deepEqual([r.body.tool, r.body.results[0].port, r.body.results[0].status], ['port', port, 'open']);
  }
  const audit = JSON.stringify((await c.admin.get('/api/audit-log?limit=50')).body);
  assert.ok(audit.includes('diagnostics.port') && audit.includes('127.0.0.1'));
});

test('bad input is answered with the reason, and an unknown tool is not found', async () => {
  const bad = await c.operator.post(`${D}/ping`, { host: '-c 1 evil' }); assert.equal(bad.status, 400); assert.match(bad.body.error, /not a host name or an IP address/);
  const many = await c.operator.post(`${D}/port`, { host: '127.0.0.1', ports: '1,2,3,4,5,6,7,8,9,10,11' }); assert.equal(many.status, 400); assert.match(many.body.error, /At most ten ports/);
  assert.equal((await c.operator.post(`${D}/format-disk`, {})).status, 404);
});

test('DNS through the API: the names of the servers to ask are checked, and the answers come side by side', async () => {
  const ok = await c.operator.post(`${D}/dns`, { name: 'nas.example', type: 'A', servers: [dnsd.address] });
  assert.equal(ok.status, 200); assert.deepEqual([ok.body.results[0].status, ok.body.results[0].answers, ok.body.differs], ['ok', ['10.0.0.9'], false]);
  const bad = await c.operator.post(`${D}/dns`, { name: 'nas.example', servers: ['evil.example'] }); assert.equal(bad.status, 400); assert.match(bad.body.error, /is not an IP address/);
  assert.deepEqual((await c.operator.get(`${D}/dns-servers`)).body, [], 'no local DNS server is set up in this test');
});
