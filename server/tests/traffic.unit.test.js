'use strict';

// Traffic history: counters → rates, the alert state, what a FortiGate and an SNMP device answer, polling with alerts, the hourly summary, the chart numbers.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'traffic-'));
const hex = () => crypto.randomBytes(32).toString('hex');
Object.assign(process.env, { NODE_ENV: 'test', DB_PATH: path.join(dir, 'infraloom.db'), DB_ENCRYPTION_KEY: hex(), APP_SECRET: hex(), BACKUP_ENCRYPTION_PASSWORD: hex() });
const db = require('../src/db/database');
const R = require('../src/services/traffic/rates');
const C = require('../src/services/traffic/collect');
const S = require('../src/services/traffic/service');
const { series, spark } = require('../src/services/traffic/series');
test.after(() => fs.rmSync(dir, { recursive: true, force: true }));

test('counters become rates; a restart, a wrap and a glitch are told apart', () => {
  assert.equal(R.toBig(Buffer.from([0, 0, 0, 1, 0, 0, 0, 0])), 4294967296n); assert.equal(R.toBig('18446744073709551615'), 18446744073709551615n); assert.equal(R.toBig(12.9), 12n);
  for (const bad of [null, undefined, 'x', -1, NaN, '1.5']) assert.equal(R.toBig(bad), null, String(bad));
  assert.deepEqual(R.counterRate(1000, 13_500_000_000, 60), { bps: (13_499_999_000 * 8) / 60 });
  assert.equal(R.counterRate(1_000_000, 7_500_000, 60).bps, 866666.6666666666 + 0 * 0 || undefined); // 6,500,000 bytes in 60 s
  assert.deepEqual(R.counterRate(null, 5, 60), { skip: 'first' }); assert.deepEqual(R.counterRate(5, 9, 0), { skip: 'first' });
  assert.deepEqual(R.counterRate(500, 100, 60), { skip: 'reset' }, 'a 64-bit counter that goes down: the device restarted');
  const big = 2n ** 63n; assert.equal(R.counterRate(big, big + 125_000_000n, 1).bps, 1_000_000_000, 'a counter beyond 2^53 is exact');
  const wrap = R.counterRate(4_294_000_000n, 1_000_000n, 60, { bits: 32, maxBps: 1e9 }); assert.equal(wrap.bps, ((4_294_967_296 + 1_000_000 - 4_294_000_000) * 8) / 60, 'a 32-bit counter that wrapped once');
  assert.deepEqual(R.counterRate(4_000_000_000n, 1_000_000n, 1, { bits: 32, maxBps: 1e6 }), { skip: 'reset' }, 'a wrap that would mean an impossible rate is a restart');
  assert.deepEqual(R.counterRate(0, 10_000_000_000n, 1, { maxBps: 1e9 }), { skip: 'glitch' }, 'faster than the link can be');
});

test('the alert state: a level is entered after it lasted, left after the load stayed low, and a dip does not end it', () => {
  const cfg = { warn: 80, crit: 90, sustainSec: 600, clearSec: 180 };
  let row = { state: 'ok' }; let t = 1_000_000; const step = (u, dt = 60) => { t += dt; const r = R.nextState(row, u, t, cfg); row = { ...row, state: r.state, ...r.patch }; return r; };
  // keeps feeding one load until the state changes; says after how many minutes (counted from the first reading at that load)
  const until = (u) => { for (let i = 0; i < 40; i++) { const r = step(u); if (r.changed) return { changed: r.changed, minutes: i }; } return { changed: null }; };
  assert.deepEqual(until(85), { changed: 'warning', minutes: 10 }, 'ten minutes at 85%');
  assert.equal(step(78).changed, null, 'a dip below 80% does not end it'); assert.equal(step(77).changed, null);
  assert.deepEqual(until(95), { changed: 'critical', minutes: 10 }, 'ten minutes at 95%');
  assert.deepEqual(until(60), { changed: 'ok', minutes: 3 }, 'three minutes below 75%');
  assert.equal(step(88).changed, null, 'it starts counting again'); assert.deepEqual(R.nextState(row, null, t + 60, cfg), { state: 'ok', changed: null, patch: {} }, 'an unknown speed gives no verdict');
  let spike = { state: 'ok' }; for (let i = 0; i < 5; i++) { const r = R.nextState(spike, i === 2 ? 40 : 95, 2_000_000 + i * 60, cfg); spike = { ...spike, state: r.state, ...r.patch }; }
  assert.equal(spike.state, 'ok', 'a short burst, or one that was interrupted, is not an alert');
});

test('percentile and the way a speed is written', () => {
  assert.equal(R.percentile([], 95), null); assert.equal(R.percentile([5], 95), 5); assert.equal(R.percentile(Array.from({ length: 100 }, (_, i) => i + 1), 95), 95); assert.equal(R.percentile([3, 1, 2], 50), 2);
  for (const [v, t] of [[null, '—'], [0, '0 bps'], [999, '999 bps'], [1500, '1.5 kbps'], [920_000_000, '920 Mbps'], [1_000_000_000, '1 Gbps'], [2_345_000_000, '2.3 Gbps'], [12_000_000_000, '12 Gbps']]) assert.equal(R.fmtBps(v), t, String(v));
});

test('a FortiGate answer is read whatever its shape: an object by name or a list, flags and numbers as text', () => {
  const byName = { wan1: { name: 'wan1', alias: 'Telekom', link: true, speed: 1000, rx_bytes: 5000, tx_bytes: '7000' }, 'lan': { id: 'lan', link: 'down', speed: 0, rx_bytes: 1, tx_bytes: 2 }, junk: null, x: { alias: 'no name' } };
  const a = C.parseFortigateInterfaces(byName);
  assert.deepEqual(a.map((i) => [i.name, i.alias, i.status, i.speedMbps, i.inOctets, i.outOctets, i.bits]), [['wan1', 'Telekom', 'up', 1000, 5000n, 7000n, 64], ['lan', null, 'down', null, 1n, 2n, 64]]);
  assert.equal(C.parseFortigateInterfaces([{ name: 'port1', link: 'up', rx_bytes: 9, tx_bytes: 9 }])[0].status, 'up'); assert.deepEqual(C.parseFortigateInterfaces(undefined), []);
  assert.equal(C.parseFortigateInterfaces([{ name: 'p', rx_bytes: 1 }])[0].status, 'unknown'); assert.equal(C.parseFortigateInterfaces([{ name: 'p' }])[0].inOctets, null);
});

// a fake net-snmp session: subtree(root, maxRepetitions, feed, done) with the rows of a table
const fakeSession = (tables, { fail = [] } = {}) => ({
  closed: false, close() { this.closed = true; },
  subtree(root, _max, feed, done) {
    if (fail.includes(root)) return done(Object.assign(new Error('Request timed out'), {}));
    const rows = (tables[root] || []).map(([idx, value]) => ({ oid: `${root}.${idx}`, value, type: 2 }));
    feed(rows); return done();
  },
});
const u64 = (n) => { const b = Buffer.alloc(8); b.writeBigUInt64BE(BigInt(n)); return b; };

test('an SNMP device: 64-bit counters when it has them, 32-bit when it does not, names, speeds and states', async () => {
  const O = C.OID;
  const hc = fakeSession({
    [O.ifName]: [['1', Buffer.from('ether1')], ['2', Buffer.from('sfp-sfpplus1')], ['9', Buffer.from('bridge')]], [O.ifAlias]: [['1', Buffer.from('uplink')]], [O.ifHighSpeed]: [['1', 1000], ['2', 10000], ['9', 0]],
    [O.ifOper]: [['1', 1], ['2', 2], ['9', 1]], [O.ifHCIn]: [['1', u64(5_000_000_000)], ['2', u64(0)], ['9', u64(7)]], [O.ifHCOut]: [['1', u64(2 ** 40)], ['2', u64(1)], ['9', u64(8)]],
  });
  const r = await C.readSnmp({}, { session: hc });
  assert.equal(hc.closed, true); assert.equal(r.method, 'snmp');
  assert.deepEqual(r.interfaces.map((i) => [i.name, i.alias, i.status, i.speedMbps, i.inOctets, i.outOctets, i.bits]), [['ether1', 'uplink', 'up', 1000, 5_000_000_000n, 2n ** 40n, 64], ['sfp-sfpplus1', null, 'down', 10000, 0n, 1n, 64], ['bridge', null, 'up', null, 7n, 8n, 64]]);
  assert.match(r.raw, /ether1\tup\t1000 Mbps\t64-bit/);
  const old = fakeSession({ [O.ifDescr]: [['1', Buffer.from('eth0')]], [O.ifSpeed]: [['1', 100_000_000]], [O.ifOper]: [['1', 1]], [O.ifIn]: [['1', 123456]], [O.ifOut]: [['1', 654321]] }, { fail: [O.ifName] });
  const o = await C.readSnmp({}, { session: old });
  assert.deepEqual(o.interfaces.map((i) => [i.name, i.speedMbps, i.inOctets, i.outOctets, i.bits]), [['eth0', 100, 123456n, 654321n, 32]], 'no ifName and no HC counters: ifDescr, ifSpeed and the 32-bit counters');
  await assert.rejects(C.readSnmp({}, { session: fakeSession({}, { fail: [O.ifName] }) }), /SNMP timeout — check the community/);
});

test('which way a device is read', () => {
  assert.equal(C.methodFor('routers', { brand: 'FortiGate', api_token: 't', ip_address: '10.0.0.1' }), 'fortigate');
  assert.equal(C.methodFor('routers', { brand: 'fortigate', api_token: '', ip_address: '10.0.0.1', snmp_community: 'public' }), 'snmp');
  assert.equal(C.methodFor('switches', { brand: 'mikrotik', ip_address: '10.0.0.2', snmp_version: '2c', snmp_community: 'x' }), 'snmp');
  assert.equal(C.methodFor('switches', { brand: 'mikrotik', ip_address: '10.0.0.2', snmp_version: '3', snmp_username: '' }), null); assert.equal(C.methodFor('switches', { ip_address: '', snmp_community: 'x' }), null);
});

// ── polling ────────────────────────────────────────────────────────────

const router = () => Number(db.prepare("INSERT INTO routers (name, brand, ip_address, api_token) VALUES ('FG', 'fortigate', '10.0.0.1', 'tok')").run().lastInsertRowid);
const iface = (devId, name, extra = {}) => Number(db.prepare('INSERT INTO traffic_interfaces (device_table, device_id, if_name, speed_mbps) VALUES (?, ?, ?, ?)').run('routers', devId, name, 'speed' in extra ? extra.speed : 1000).lastInsertRowid);
const reader = (script) => ({ readFortigate: async () => { const r = script.shift(); if (r instanceof Error) throw r; return { method: 'fortigate', endpoint: '/x', raw: JSON.stringify(r), interfaces: r.map((i) => ({ bits: 64, status: 'up', alias: null, speedMbps: i.speedMbps === undefined ? 1000 : i.speedMbps, name: i.name, inOctets: BigInt(i.in), outOctets: BigInt(i.out) })) }; } });
const row = (id) => db.prepare('SELECT * FROM traffic_interfaces WHERE id = ?').get(id);

test('polling: the first reading only keeps the counters, the next one gives the rate, a restart is skipped', async () => {
  const dev = router(); const id = iface(dev, 'wan1'); const sent = [];
  const notifier = async (e, m) => sent.push([e, m]);
  const script = [[{ name: 'wan1', in: 1_000, out: 2_000 }], [{ name: 'wan1', in: 1_000 + 750_000_000, out: 2_000 + 75_000_000 }], [{ name: 'wan1', in: 5, out: 5 }], [{ name: 'wan1', in: 5 + 12_500_000, out: 5 }]];
  const poll = (t) => S.pollDevice('routers', dev, { now: t, hooks: reader(script), notifier });
  assert.deepEqual(await poll(1_000_000), { sampled: 0, skipped: 1, alerts: 0, missing: 0 }); assert.equal(row(id).in_bps, null);
  assert.deepEqual(await poll(1_000_060), { sampled: 1, skipped: 0, alerts: 0, missing: 0 });
  assert.deepEqual([row(id).in_bps, row(id).out_bps], [100_000_000, 10_000_000], '750 MB in 60 s = 100 Mbps'); assert.equal(row(id).oper_status, 'up');
  assert.deepEqual(db.prepare('SELECT ts, dt, in_bps FROM traffic_samples WHERE interface_id = ?').all(id), [{ ts: 1_000_060, dt: 60, in_bps: 100_000_000 }]);
  assert.deepEqual((await poll(1_000_120)).skipped, 1, 'the counter went down: the device restarted, so no rate for that minute');
  assert.equal((await poll(1_000_180)).sampled, 1); assert.equal(row(id).in_bps, (12_500_000 * 8) / 60);
  assert.equal(S.rawOf('routers', dev).method, 'fortigate'); assert.match(S.rawOf('routers', dev).raw, /wan1/); assert.deepEqual(sent, []);
});

test('an interface that stays loaded raises one alert, and one when it is back to normal', async () => {
  const dev = router(); const id = iface(dev, 'wan1', { speed: 100 }); const sent = [];
  db.prepare('UPDATE traffic_interfaces SET sustain_minutes = 2 WHERE id = ?').run(id); db.prepare("INSERT INTO traffic_config (key, value) VALUES ('poll_minutes', '1') ON CONFLICT(key) DO UPDATE SET value = '1'").run();
  let bytes = 0; const at = (t, mbps) => { bytes += (mbps * 1e6 / 8) * 60; return S.pollDevice('routers', dev, { now: t, hooks: reader([[{ name: 'wan1', speedMbps: 100, in: bytes, out: 0 }]]), notifier: async (e, m) => sent.push([e, m]) }); };
  let t = 3_000_000; await at(t, 5);
  for (const mbps of [92, 93, 94]) await at(t += 60, mbps);     // 92% for 2 minutes: critical needs 90%
  assert.deepEqual(sent.map((s) => s[0]), ['traffic_high_critical'], 'at 90% or more for 2 minutes it is critical at once');
  assert.match(sent[0][1], /^Traffic on FG wan1 is very high: 94% of 100 Mbps \(in 94 Mbps, out 0 bps\), for 2 min\.$/); assert.equal(row(id).state, 'critical');
  await at(t += 60, 95); assert.equal(sent.length, 1, 'once, not every minute');
  for (const mbps of [20, 20, 20, 20]) await at(t += 60, mbps); // below 75% for three minutes ends it
  assert.deepEqual(sent.map((s) => s[0]), ['traffic_high_critical', 'traffic_normal']); assert.match(sent[1][1], /^Traffic on FG wan1 is back to normal: 20% of 100 Mbps/); assert.equal(row(id).state, 'ok');
  const w = iface(dev, 'wan2', { speed: 100 }); db.prepare('UPDATE traffic_interfaces SET sustain_minutes = 1, warn_pct = 50, crit_pct = 99 WHERE id = ?').run(w);
  let b2 = 0; const sent2 = []; let t2 = 4_000_000;
  const at2 = (mbps) => { b2 += (mbps * 1e6 / 8) * 60; t2 += 60; return S.pollDevice('routers', dev, { now: t2, hooks: reader([[{ name: 'wan1', speedMbps: 100, in: 0, out: 0 }, { name: 'wan2', speedMbps: 100, in: b2, out: 0 }]]), notifier: async (e, m) => sent2.push([e, m]) }); };
  await at2(10); await at2(60); await at2(60); assert.deepEqual(sent2.map((s) => s[0]), ['traffic_high_warning'], 'the thresholds of one interface are its own');
});

test('what is not an alert: an unknown speed, a missing interface, a device that does not answer, an interface that is switched off', async () => {
  const dev = router(); const noSpeed = iface(dev, 'p1', { speed: null }); const gone = iface(dev, 'p2'); const off = iface(dev, 'p3'); db.prepare('UPDATE traffic_interfaces SET enabled = 0 WHERE id = ?').run(off);
  const sent = []; const n = async (e) => sent.push(e); let b = 0; let t = 5_000_000;
  const at = () => S.pollDevice('routers', dev, { now: (t += 60), notifier: n, hooks: reader([[{ name: 'p1', speedMbps: null, in: (b += 900_000_000_000), out: 0 }, { name: 'p3', in: 1, out: 1 }]]) });
  await at(); const r = await at();
  assert.equal(r.missing, 1); assert.equal(row(noSpeed).util, undefined); assert.ok(row(noSpeed).in_bps > 1e9 * 100 / 100 && row(noSpeed).state === 'ok', 'a rate is kept, but with no speed there is no percentage and no alert'); assert.deepEqual(sent, []);
  assert.match(row(gone).last_error, /does not list this interface/); assert.equal(row(off).last_ts, null, 'a switched-off interface is not read');
  const bad = await S.pollDevice('routers', dev, { now: t + 60, notifier: n, hooks: reader([new Error('HTTP 403 — the token was rejected or its admin profile cannot read interfaces')]) });
  assert.match(bad.error, /HTTP 403/); assert.match(row(noSpeed).last_error, /HTTP 403/); assert.equal((await S.pollDevice('routers', 99999, { hooks: {} })).skipped, 'nothing to read');
  await assert.rejects(S.pollDevice('users', 1, {}), /Unknown device table/);
});

test('an hour is summed up once it is over: average, peak, 95th percentile and the bytes; and old data goes', () => {
  const dev = router(); const id = iface(dev, 'wan1'); const hour = 6_000_000 - (6_000_000 % 3600); const ins = db.prepare('INSERT INTO traffic_samples (interface_id, ts, dt, in_bps, out_bps) VALUES (?, ?, 60, ?, ?)');
  for (let i = 0; i < 60; i++) ins.run(id, hour + i * 60, (i + 1) * 1_000_000, 1_000_000);                // in: 1..60 Mbps, out: 1 Mbps
  for (let i = 0; i < 30; i++) ins.run(id, hour + 3600 + i * 60, 50_000_000, 0);                            // the next hour, still going on
  const now = hour + 3600 + 31 * 60;
  const r = S.rollup(now); assert.ok(r.hours >= 1);
  const h = db.prepare('SELECT * FROM traffic_hourly WHERE interface_id = ?').all(id); assert.equal(h.length, 1, 'only the hour that is over, not the one that is going on');
  assert.deepEqual([h[0].hour, h[0].samples, h[0].avg_in, h[0].max_in, h[0].p95_in, h[0].avg_out], [hour, 60, 30_500_000, 60_000_000, 57_000_000, 1_000_000]);
  assert.equal(h[0].bytes_in, (30_500_000 * 60 * 60) / 8); assert.equal(S.rollup(now).hours, 0, 'and not again');
  db.prepare('INSERT INTO traffic_samples (interface_id, ts, dt, in_bps, out_bps) VALUES (?, ?, 60, 1, 1)').run(id, now - 9 * 86400);
  assert.equal(S.rollup(now).purged.samples, 1, 'samples older than the 7 days are removed');
});

test('the numbers of a chart: short ranges from the samples, long ones from the hourly summaries and the hour that is going on', () => {
  const dev = router(); const id = iface(dev, 'wan1'); const now = 9_000_000 - (9_000_000 % 3600) + 1800;
  const ins = db.prepare('INSERT INTO traffic_samples (interface_id, ts, dt, in_bps, out_bps) VALUES (?, ?, 60, ?, ?)');
  for (let i = 0; i < 30; i++) ins.run(id, now - i * 60, 8_000_000, 800_000);
  const s1 = series(id, '1h', now); assert.equal(s1.points.length, 30); assert.deepEqual([s1.points[0].in, s1.points[0].out, s1.bucket], [8_000_000, 800_000, 60]);
  assert.deepEqual([s1.summary.avg_in, s1.summary.max_in, s1.summary.p95_in, s1.summary.samples], [8_000_000, 8_000_000, 8_000_000, 30]); assert.equal(s1.summary.bytes_in, (8_000_000 * 60 * 30) / 8); assert.equal(s1.summary.basis, 'the samples of the polls');
  const day = 8_000_000 - (8_000_000 % 86400);
  db.prepare('INSERT INTO traffic_hourly (interface_id, hour, samples, avg_in, avg_out, max_in, max_out, p95_in, p95_out, bytes_in, bytes_out) VALUES (?, ?, 60, 2000000, 100000, 9000000, 500000, 3000000, 200000, ?, ?)').run(id, day, (2_000_000 * 3600) / 8, (100_000 * 3600) / 8);
  const s30 = series(id, '30d', now); assert.equal(s30.summary.basis, 'the hourly averages'); assert.ok(s30.points.some((p) => p.max_in === 9_000_000), 'the peak of the old hour is kept'); assert.ok(s30.points.length >= 2, 'the old hour and the current one');
  assert.equal(s30.summary.max_in, 9_000_000); assert.equal(s30.summary.bytes_in, (2_000_000 * 3600) / 8 + (8_000_000 * 60 * 30) / 8);
  assert.throws(() => series(id, '2w', now), /Range must be one of/);
  assert.equal(spark(id, now).length, 7, 'the last half hour as 5-minute points'); assert.deepEqual(series(iface(dev, 'empty'), '24h', now).points, []);
});

test('the settings are kept, and checked', () => {
  const d = S.getConfig(); assert.deepEqual([d.poll_minutes, d.warn_pct, d.crit_pct, d.sustain_minutes, d.raw_days, d.hourly_days], [1, 80, 90, 10, 7, 400]);
  for (const [b, re] of [[{ poll_minutes: 0 }, /poll minutes must be a whole number from 1 to 10/], [{ warn_pct: 100 }, /from 10 to 99/], [{ warn_pct: 95, crit_pct: 90 }, /critical level must be above/], [{ raw_days: 'x' }, /raw days/], [{ hourly_days: 5000 }, /hourly days/]]) assert.throws(() => S.saveConfig(b), re, JSON.stringify(b));
  assert.deepEqual(S.getConfig(), d, 'nothing changed by a refused save');
  const ok = S.saveConfig({ warn_pct: 70, crit_pct: 85, sustain_minutes: 5 }); assert.deepEqual([ok.warn_pct, ok.crit_pct, ok.sustain_minutes, ok.poll_minutes], [70, 85, 5, 1]); assert.equal(S.getConfig().warn_pct, 70);
});
