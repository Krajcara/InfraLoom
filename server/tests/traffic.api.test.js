'use strict';

// The traffic API against a fake FortiGate (HTTPS, a bearer token, counters that grow with time): choosing interfaces, polling, the chart numbers, thresholds and who may do what.

const test = require('node:test');
const assert = require('node:assert/strict');
const https = require('node:https');
const { startServer, clientsFor } = require('./_helpers');
const { makeCert } = require('./_tls');

const pair = makeCert();
const needTls = { skip: !pair && 'openssl is not installed' };
const T = '/api/traffic';
const state = { mode: 'ok' };
let fake; let srv; let c; let rid; let ifaceId;

// wan1: 100 Mbps in, 10 Mbps out, as counters of the seconds since the start; port2: nothing
const t0 = Math.floor(Date.now() / 1000);
const counters = () => { const s = Math.floor(Date.now() / 1000) - t0; return { wan1: { in: 12_500_000 * s + 1_000_000, out: 1_250_000 * s + 500_000 } }; };

test.before(async () => {
  if (!pair) return;
  fake = https.createServer({ cert: pair.cert, key: pair.key }, (req, res) => {
    const json = (code, body) => { res.writeHead(code, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(body)); };
    if (req.headers.authorization !== 'Bearer tok') return json(401, { status: 'error' });
    if (!req.url.startsWith('/api/v2/monitor/system/interface')) return json(404, {});
    if (state.mode === '403') return json(403, { status: 'error', http_status: 403 });
    const k = counters().wan1;
    return json(200, { results: { wan1: { name: 'wan1', alias: 'Telekom', link: true, speed: 1000, rx_bytes: k.in, tx_bytes: k.out }, port2: { name: 'port2', link: false, speed: 1000, rx_bytes: 0, tx_bytes: 0 } } });
  });
  await new Promise((r) => fake.listen(0, '127.0.0.1', r));
  srv = await startServer(); c = await clientsFor(srv);
  const made = await c.operator.post('/api/routers', { name: 'FG-100F', brand: 'fortigate', ip_address: `127.0.0.1:${fake.address().port}`, api_token: 'tok' });
  assert.ok(made.status < 300, JSON.stringify(made.body));
  rid = (await c.operator.get(`${T}/devices`)).body.find((d) => d.name === 'FG-100F').id;
});
test.after(() => { srv?.stop(); fake?.close(); });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const list = async () => (await c.viewer.get(`${T}/interfaces`)).body;

test('everybody who is signed in sees the interfaces; the rest is for operators and administrators', needTls, async () => {
  assert.equal((await c.anon.get(`${T}/interfaces`)).status, 401);
  const l = await list(); assert.deepEqual(l.interfaces, []); assert.deepEqual([l.config.warn_pct, l.config.crit_pct, l.config.sustain_minutes], [80, 90, 10]);
  for (const [m, p, b] of [['get', '/devices'], ['get', '/discover?table=routers&id=1'], ['post', '/interfaces', { table: 'routers', id: rid, interfaces: ['wan1'] }], ['patch', '/interfaces/1', { label: 'x' }], ['delete', '/interfaces/1'], ['post', '/poll', {}]]) {
    const r = await c.viewer[m === 'delete' ? 'del' : m](`${T}${p}`, b); assert.equal(r.status, 403, `${m} ${p}`);
  }
  assert.equal((await c.operator.get(`${T}/settings`)).status, 403); assert.equal((await c.operator.get(`${T}/raw/routers/${rid}`)).status, 403);
  const d = (await c.operator.get(`${T}/devices`)).body.find((x) => x.id === rid); assert.deepEqual([d.table, d.method], ['routers', 'fortigate']);
});

test('discovering the interfaces of a device, and what goes wrong', needTls, async () => {
  assert.equal((await c.admin.get(`${T}/raw/routers/${rid}`)).status, 404, 'nothing has been read yet');
  const r = await c.operator.get(`${T}/discover?table=routers&id=${rid}`);
  assert.equal(r.status, 200); assert.equal(r.body.method, 'fortigate');
  const raw0 = await c.admin.get(`${T}/raw/routers/${rid}`); assert.equal(raw0.status, 200, 'what the device answered is kept when its interfaces are read to choose from'); assert.match(raw0.body.raw, /"Telekom"/);
  assert.deepEqual(r.body.interfaces.map((i) => [i.name, i.alias, i.status, i.speed_mbps, i.monitored]), [['wan1', 'Telekom', 'up', 1000, false], ['port2', null, 'down', 1000, false]]);
  assert.equal((await c.operator.get(`${T}/discover?table=users&id=1`)).status, 400); assert.equal((await c.operator.get(`${T}/discover?table=routers&id=99999`)).status, 404);
  state.mode = '403'; const bad = await c.operator.get(`${T}/discover?table=routers&id=${rid}`); state.mode = 'ok';
  assert.equal(bad.status, 502); assert.match(bad.body.error, /HTTP 403 — the token was rejected or its admin profile cannot read interfaces/);
});

test('choosing interfaces: only what the device lists, and once', needTls, async () => {
  const body = (interfaces) => ({ table: 'routers', id: rid, interfaces });
  assert.equal((await c.operator.post(`${T}/interfaces`, body([]))).status, 400);
  const nope = await c.operator.post(`${T}/interfaces`, body(['wan1', 'nope'])); assert.equal(nope.status, 400); assert.match(nope.body.error, /does not list: nope/);
  assert.equal((await c.operator.post(`${T}/interfaces`, body(Array.from({ length: 65 }, (_, i) => `p${i}`)))).status, 400);
  const ok = await c.operator.post(`${T}/interfaces`, body(['wan1'])); assert.deepEqual([ok.status, ok.body.added], [201, 1]);
  assert.equal((await c.operator.post(`${T}/interfaces`, body(['wan1']))).body.added, 0, 'the same interface twice is one');
  const l = (await list()).interfaces; assert.equal(l.length, 1); ifaceId = l[0].id;
  assert.deepEqual([l[0].device_name, l[0].if_name, l[0].label, l[0].speed_mbps, l[0].state, l[0].in_bps], ['FG-100F', 'wan1', 'Telekom', 1000, 'ok', null], 'the alias of the device is the name to start with');
  assert.equal((await c.operator.get(`${T}/discover?table=routers&id=${rid}`)).body.interfaces[0].monitored, true);
});

test('polling gives the rate, the chart and the summary', needTls, async () => {
  const first = await c.operator.post(`${T}/poll`, {}); assert.deepEqual([first.status, first.body.devices, first.body.sampled, first.body.errors], [200, 1, 0, 0]);
  await sleep(2300);
  const second = await c.operator.post(`${T}/poll`, {}); assert.equal(second.body.sampled, 1);
  const i = (await list()).interfaces[0];
  assert.ok(i.in_bps > 40e6 && i.in_bps < 160e6, `in ${i.in_bps}`); assert.ok(i.out_bps > 4e6 && i.out_bps < 16e6, `out ${i.out_bps}`); assert.ok(i.util_pct > 4 && i.util_pct < 16, `util ${i.util_pct}`);
  assert.deepEqual([i.oper_status, i.state, i.last_error], ['up', 'ok', null]); assert.ok(i.last_ts > 0 && (await list()).last_poll);
  const s = (await c.viewer.get(`${T}/interfaces/${ifaceId}/series?range=1h`)).body;
  assert.ok(s.points.length >= 1 && s.points[0].in > 0); assert.equal(s.summary.basis, 'the samples of the polls'); assert.ok(s.summary.avg_in > 0 && s.summary.bytes_in > 0 && s.summary.p95_in > 0);
  for (const r of ['6h', '24h', '7d', '30d', '1y']) assert.equal((await c.viewer.get(`${T}/interfaces/${ifaceId}/series?range=${r}`)).status, 200, r);
  const bad = await c.viewer.get(`${T}/interfaces/${ifaceId}/series?range=2w`); assert.equal(bad.status, 400); assert.match(bad.body.error, /Range must be one of/);
  assert.equal((await c.viewer.get(`${T}/interfaces/99999/series`)).status, 404);
});

test('the thresholds, the name and the speed of an interface', needTls, async () => {
  const p = (b, who = c.operator) => who.patch(`${T}/interfaces/${ifaceId}`, b);
  for (const [b, re] of [[{ label: 'x'.repeat(81) }, /up to 80 characters/], [{ enabled: 'yes' }, /true or false/], [{ warn_pct: 5 }, /warn pct must be a whole number from 10 to 99/], [{ crit_pct: 101 }, /crit pct/], [{ sustain_minutes: 0 }, /sustain minutes/], [{ warn_pct: 90, crit_pct: 80 }, /critical level must be above/], [{ speed_mbps: 0 }, /whole number of Mbps/], [{ crit_pct: 60 }, /critical level must be above/]]) {
    const r = await p(b); assert.equal(r.status, 400, JSON.stringify(b)); assert.match(r.body.error, re);
  }
  assert.equal((await p({ label: 'x' }, c.viewer)).status, 403); assert.equal((await c.operator.patch(`${T}/interfaces/99999`, { label: 'x' })).status, 404);
  assert.equal((await p({ label: ' WAN Telekom ', warn_pct: 70, crit_pct: 85, sustain_minutes: 5 })).status, 200);
  let i = (await list()).interfaces[0]; assert.deepEqual([i.label, i.warn_pct, i.crit_pct, i.sustain_minutes], ['WAN Telekom', 70, 85, 5]);
  await p({ warn_pct: null, crit_pct: null, sustain_minutes: null, label: null }); i = (await list()).interfaces[0]; assert.deepEqual([i.label, i.warn_pct, i.crit_pct, i.sustain_minutes], [null, null, null, null], 'empty means the default');
  await p({ speed_mbps: 500 }); i = (await list()).interfaces[0]; assert.deepEqual([i.speed_mbps, i.speed_override], [500, true]);
  await sleep(1200); await c.operator.post(`${T}/poll`, {}); i = (await list()).interfaces[0]; assert.equal(i.speed_mbps, 500, 'the speed set by hand is not replaced by the device\'s');
  await p({ speed_mbps: null }); await sleep(1200); await c.operator.post(`${T}/poll`, {}); i = (await list()).interfaces[0]; assert.deepEqual([i.speed_mbps, i.speed_override], [1000, false], 'and the device\'s speed is back when it is cleared');
});

test('an interface that is switched off is not read; a device that refuses is reported', needTls, async () => {
  await c.operator.patch(`${T}/interfaces/${ifaceId}`, { enabled: false });
  const before = (await list()).interfaces[0].last_ts; await sleep(1200);
  assert.equal((await c.operator.post(`${T}/poll`, {})).body.devices, 0); assert.equal((await list()).interfaces[0].last_ts, before);
  await c.operator.patch(`${T}/interfaces/${ifaceId}`, { enabled: true });
  state.mode = '403'; const r = await c.operator.post(`${T}/poll`, {}); state.mode = 'ok';
  assert.equal(r.body.errors, 1); assert.match((await list()).interfaces[0].last_error, /HTTP 403/);
  await sleep(1200); await c.operator.post(`${T}/poll`, {}); assert.equal((await list()).interfaces[0].last_error, null, 'and the message is gone when it answers again');
});

test('what the device answered, for an administrator; and the settings', needTls, async () => {
  const raw = await c.admin.get(`${T}/raw/routers/${rid}`); assert.equal(raw.status, 200); assert.equal(raw.body.method, 'fortigate'); assert.match(raw.body.raw, /"wan1"/); assert.equal(raw.body.interfaces, 2);
  assert.equal((await c.admin.get(`${T}/raw/routers/99999`)).status, 404);
  assert.deepEqual((await c.admin.get(`${T}/settings`)).body, { poll_minutes: 1, warn_pct: 80, crit_pct: 90, sustain_minutes: 10, raw_days: 7, hourly_days: 400 });
  for (const [b, re] of [[{ poll_minutes: 11 }, /poll minutes/], [{ warn_pct: 95 }, /critical level must be above/], [{ hourly_days: 1 }, /hourly days/]]) { const r = await c.admin.put(`${T}/settings`, b); assert.equal(r.status, 400); assert.match(r.body.error, re); }
  assert.equal((await c.operator.put(`${T}/settings`, { warn_pct: 70 })).status, 403);
  const ok = await c.admin.put(`${T}/settings`, { warn_pct: 70, crit_pct: 85, sustain_minutes: 5, poll_minutes: 2 }); assert.deepEqual([ok.status, ok.body.warn_pct, ok.body.poll_minutes], [200, 70, 2]);
  assert.equal((await list()).config.warn_pct, 70);
});

test('removing an interface removes its history; the audit log has the changes', needTls, async () => {
  assert.equal((await c.viewer.del(`${T}/interfaces/${ifaceId}`)).status, 403);
  assert.deepEqual((await c.operator.del(`${T}/interfaces/${ifaceId}`)).body, { removed: 'wan1' });
  assert.equal((await c.operator.del(`${T}/interfaces/${ifaceId}`)).status, 404); assert.equal((await c.viewer.get(`${T}/interfaces/${ifaceId}/series`)).status, 404); assert.deepEqual((await list()).interfaces, []);
  const audit = JSON.stringify((await c.admin.get('/api/audit-log?limit=200')).body);
  for (const a of ['traffic.interfaces.add', 'traffic.interface.update', 'traffic.interface.remove', 'traffic.settings']) assert.ok(audit.includes(a), a);
});
