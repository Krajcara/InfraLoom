'use strict';

// The syslog service in one process, with a clock of our own and a notifier that writes things down.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'syslog-'));
const hex = () => crypto.randomBytes(32).toString('hex');
Object.assign(process.env, { NODE_ENV: 'test', DB_PATH: path.join(dir, 'infraloom.db'), DB_ENCRYPTION_KEY: hex(), APP_SECRET: hex(), BACKUP_ENCRYPTION_PASSWORD: hex() });
const db = require('../src/db/database');
const S = require('../src/services/syslog/service');
test.after(() => fs.rmSync(dir, { recursive: true, force: true }));

const T0 = Date.UTC(2026, 9, 23, 11, 5, 0);   // 11:05:00 UTC
const HEAD = (dev = 'FG-100F') => `date=2026-10-23 time=13:05:00 devname="${dev}" devid="FG100FTK21000001" tz="+0200"`;
const traffic = (o = {}) => `<189>${HEAD(o.dev)} logid="0000000013" type="traffic" subtype="forward" level="notice" srcip=${o.src || '10.1.0.55'} dstip=${o.dst || '142.250.74.46'} dstcountry="${o.country || 'United States'}" action="${o.action || 'close'}" policyid=3 service="${o.service || 'HTTPS'}" app="${o.app || 'Google.Services'}"${o.deny ? '' : ` sentbyte=${o.out ?? 100} rcvdbyte=${o.in ?? 900}`}`;
const adminFail = (ip = '185.1.2.3', user = 'admin', dev) => `${HEAD(dev)} logid="0100032002" type="event" subtype="system" level="alert" logdesc="Admin login failed" user="${user}" ui="https(${ip})" srcip=${ip} action="login" status="failed" reason="name_invalid"`;
const config = (i, user = 'sasa') => `${HEAD()} logid="0100044546" type="event" subtype="system" level="information" logdesc="Attribute configured" user="${user}" ui="GUI(10.1.0.5)" action="Edit" cfgpath="firewall.policy" cfgobj="${i}" cfgattr="status[enable->disable]"`;
const ips = (attack, sev = 'high', src = '185.1.2.3') => `${HEAD()} logid="0419016384" type="utm" subtype="ips" level="alert" severity="${sev}" srcip=${src} dstip=10.1.0.20 action="dropped" attack="${attack}"`;
const vpnFail = (ip = '45.9.9.9') => `${HEAD()} type="event" subtype="vpn" level="alert" logdesc="SSL VPN login fail" action="ssl-login-fail" remip=${ip} user="bob" reason="denied"`;

let sent = []; const notifier = async (event, text) => { sent.push([event, text]); };
const send = (line, t = T0, ip = '10.1.0.1') => S.ingest(line, ip, t, { notifier });
const reset = () => { S.resetForTests(); sent = []; db.exec('DELETE FROM syslog_events; DELETE FROM syslog_hourly; DELETE FROM syslog_stats; DELETE FROM syslog_config'); S.saveConfig({ allowed_sources: '10.1.0.1' }); };
const kinds = () => sent.map((s) => s[0]);

test('the settings are kept and checked', () => {
  reset(); db.exec('DELETE FROM syslog_config');
  const d = S.getConfig(); assert.deepEqual([d.enabled, d.udp_port, d.tcp_port, d.fail_count, d.silent_minutes, d.notify_config_change, d.notify_admin_login, d.allowed_sources], [0, 5140, 0, 3, 15, 1, 0, '']);
  for (const [b, re] of [[{ udp_port: 70000 }, /udp port must be a whole number from 1 to 65535/], [{ fail_count: 1 }, /fail count/], [{ silent_minutes: 'x' }, /silent minutes/], [{ enabled: 'yes' }, /enabled must be true or false/], [{ allowed_sources: '10.1.0.1, nope' }, /“nope” is not an IP address/], [{ event_days: 3 }, /event days/], [{ udp_port: 0 }, /udp port/]]) assert.throws(() => S.saveConfig(b), re, JSON.stringify(b));
  const ok = S.saveConfig({ enabled: true, udp_port: 5514, allowed_sources: '10.1.0.1  10.1.0.1;2001:db8::1', notify_admin_login: true }); assert.deepEqual([ok.enabled, ok.udp_port, ok.allowed_sources, ok.notify_admin_login], [1, 5514, '10.1.0.1, 2001:db8::1', 1]);
  assert.equal(S.getConfig().udp_port, 5514); assert.throws(() => S.saveConfig({ enabled: true, udp_port: 5514, tcp_port: 0 }) && S.saveConfig({ udp_port: 0 }), /udp port/);
});

test('only the firewalls that are known may send', async () => {
  reset();
  assert.equal(await send(traffic(), T0, '10.9.9.9'), 'rejected'); assert.equal(S.status().counters.rejected, 1); assert.deepEqual(S.status().rejected, [{ ip: '10.9.9.9', n: 1 }]);
  assert.equal(await send(traffic()), 'ok'); assert.equal(await send(traffic(), T0, '::ffff:10.1.0.1'), 'ok', 'an IPv4 address that came as IPv6');
  db.prepare("INSERT INTO routers (name, brand, ip_address, api_token) VALUES ('FG2', 'FortiGate', '10.1.0.2:8443', 'x')").run(); db.prepare("INSERT INTO routers (name, brand, ip_address) VALUES ('MT', 'mikrotik', '10.1.0.3')").run(); S.allowedSources(true);
  assert.equal(await send(traffic({ dev: 'FG2' }), T0, '10.1.0.2'), 'ok', 'a FortiGate of the router list is allowed without being typed again'); assert.equal(await send(traffic(), T0, '10.1.0.3'), 'rejected', 'another brand is not');
  assert.equal(await send('hello, this is not a log', T0), 'unparsed'); assert.deepEqual([S.status().counters.received, S.status().counters.parsed, S.status().counters.unparsed], [4, 3, 1]);
});

test('what is only in memory is written when the service stops', async () => {
  reset(); await send(traffic({ out: 11, in: 22 })); await send('not a log');
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM syslog_hourly').get().n, 0, 'nothing is written yet');
  S.flushNow();
  const r = db.prepare('SELECT sessions, bytes_out, bytes_in FROM syslog_hourly').get(); assert.deepEqual(r, { sessions: 1, bytes_out: 11, bytes_in: 22 });
  assert.equal(db.prepare('SELECT SUM(received) AS n FROM syslog_stats').get().n, 1); assert.equal(db.prepare('SELECT SUM(unparsed) AS n FROM syslog_stats').get().n, 1);
  S.flushNow(); assert.equal(db.prepare('SELECT sessions FROM syslog_hourly').get().sessions, 1, 'and writing twice does not count twice');
});

test('traffic is summed up by the hour; a restart in the middle of an hour goes on from what was written', async () => {
  reset();
  await send(traffic({ out: 100, in: 900 })); await send(traffic({ out: 50, in: 450, src: '10.1.0.56', app: 'Teams' })); await send(traffic({ deny: true, action: 'deny', src: '185.1.2.3', service: 'RDP', app: 'RDP', country: 'Russian Federation' }));
  await send(traffic({ out: 1, in: 1 }).replace('action="close"', 'action="start"').replace(' sentbyte=1 rcvdbyte=1', ''));
  let s = S.summary('1h', null, Math.floor(T0 / 1000) + 60); assert.deepEqual([s.sessions, s.blocked, s.bytes_out, s.bytes_in], [3, 1, 150, 1350], 'the start of a session is not counted');
  assert.deepEqual(s.top.src.map((r) => [r.key, r.bytes]), [['10.1.0.55', 1000], ['10.1.0.56', 500], ['185.1.2.3', 0]]); assert.deepEqual(s.top.blocked_src.map((r) => r.key), ['185.1.2.3']); assert.deepEqual(s.top.country.map((r) => r.key), ['United States', 'Russian Federation'], 'a blocked session counts for its country too');
  await S.tick(T0 + 60_000, { notifier }); assert.equal(db.prepare('SELECT COUNT(*) AS n FROM syslog_hourly').get().n, 1, 'the hour that goes on is written too');
  s = S.summary('1h', null, Math.floor(T0 / 1000) + 60); assert.equal(s.sessions, 3, 'and not counted twice, in memory and in the database');
  S.resetForTests(); S.saveConfig({ allowed_sources: '10.1.0.1' });             // the service starts again
  await send(traffic({ out: 10, in: 90 }), T0 + 120_000);
  s = S.summary('1h', null, Math.floor(T0 / 1000) + 180); assert.deepEqual([s.sessions, s.bytes_in, s.top.src[0].key, s.top.src[0].bytes], [4, 1440, '10.1.0.55', 1100], 'the hour went on from what was stored');
  await send(traffic({ out: 5, in: 5 }), T0 + 3600_000 * 2); await S.tick(T0 + 3600_000 * 2 + 1000, { notifier });
  assert.deepEqual(db.prepare('SELECT hour, sessions FROM syslog_hourly ORDER BY hour').all().map((r) => r.sessions), [4, 1], 'one row for each hour');
  const day = S.summary('24h', null, Math.floor(T0 / 1000) + 7200 + 60); assert.deepEqual([day.sessions, day.timeline.length], [5, 2]);
  await send(traffic({ dev: 'FG2', out: 7, in: 7 }), T0, '10.1.0.1'); assert.deepEqual(S.summary('24h', null, Math.floor(T0 / 1000) + 7260).devices, ['FG-100F', 'FG2']); assert.equal(S.summary('24h', 'FG2', Math.floor(T0 / 1000) + 7260).sessions, 1, 'one firewall at a time');
  assert.throws(() => S.summary('2w'), /Range must be one of/);
});

test('failed logins: one alert for a burst, not one for every attempt, and not for a few spread out', async () => {
  reset(); S.saveConfig({ allowed_sources: '10.1.0.1', fail_count: 3, fail_window_minutes: 10 });
  await send(adminFail(), T0); await send(adminFail(), T0 + 60_000); assert.deepEqual(sent, [], 'two are not a burst');
  await send(adminFail('185.1.2.3', 'root'), T0 + 120_000); assert.deepEqual(kinds(), ['fw_admin_login_failed']); assert.equal(sent[0][1], '3 failed administrator logins on FG-100F from 185.1.2.3 in 10 min (user: admin, root).');
  for (let i = 3; i < 9; i++) await send(adminFail(), T0 + i * 60_000); assert.equal(sent.length, 1, 'the rest of the attack is quiet for half an hour');
  await send(adminFail(), T0 + 40 * 60_000); await send(adminFail(), T0 + 41 * 60_000); await send(adminFail(), T0 + 42 * 60_000); assert.equal(sent.length, 2, 'and said again when it goes on');
  await send(adminFail('185.9.9.9'), T0); await send(adminFail('185.9.9.9'), T0 + 11 * 60_000); await send(adminFail('185.9.9.9'), T0 + 22 * 60_000); assert.equal(sent.length, 2, 'three in 22 minutes is not a burst of 10');
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM syslog_events WHERE kind = 'admin_login_failed'").get().n, 15, 'but every one is kept as an event');
  sent = []; await send(vpnFail(), T0); await send(vpnFail(), T0 + 1000); await send(vpnFail(), T0 + 2000); assert.deepEqual(kinds(), ['fw_vpn_login_failed']);
  sent = []; S.saveConfig({ notify_vpn_failed: false }); S.resetForTests(); S.saveConfig({ allowed_sources: '10.1.0.1' }); for (let i = 0; i < 4; i++) await send(vpnFail('1.1.1.1'), T0 + i); assert.deepEqual(sent, [], 'switched off');
});

test('a change of the configuration is said once, when it is over, with what was changed', async () => {
  reset();
  for (let i = 1; i <= 5; i++) await send(config(i), T0 + i * 1000); await send(config(9, 'ana'), T0 + 7000);
  assert.deepEqual(sent, [], 'not while it goes on');
  await S.tick(T0 + 30_000, { notifier }); assert.deepEqual(sent, [], 'not 25 seconds after the last change');
  await S.tick(T0 + 5 * 60_000, { notifier });
  assert.deepEqual(kinds(), ['fw_config_change', 'fw_config_change']);
  const t = sent.map((s) => s[1]).sort(); assert.match(t[1], /^Configuration of FG-100F was changed by sasa \(GUI\(10\.1\.0\.5\)\): 5 changes — firewall\.policy 1 \(status\[enable->disable\]\); firewall\.policy 2/); assert.match(t[0], /by ana .*1 change — firewall\.policy 9/);
  await S.tick(T0 + 10 * 60_000, { notifier }); assert.equal(sent.length, 2, 'and once');
  sent = []; S.saveConfig({ notify_config_change: false }); await send(config(1), T0 + 20 * 60_000); await S.tick(T0 + 30 * 60_000, { notifier }); assert.deepEqual(sent, []); assert.equal(db.prepare("SELECT COUNT(*) AS n FROM syslog_events WHERE kind = 'config_change'").get().n, 7, 'it is in the events all the same');
});

test('an attack that was stopped: once for each attack, never a flood', async () => {
  reset();
  await send(ips('Apache.Log4j.RCE')); await send(ips('Apache.Log4j.RCE', 'high', '5.5.5.5')); assert.deepEqual(kinds(), ['fw_ips']); assert.match(sent[0][1], /^IPS: Apache\.Log4j\.RCE from 185\.1\.2\.3 to 10\.1\.0\.20, severity high, dropped \(FG-100F\)\.$/);
  await send(ips('Other.Attack')); assert.equal(sent.length, 2); await send(ips('Low.Thing', 'low').replace('level="alert"', 'level="notice"')); assert.equal(sent.length, 2, 'low severity is only an event');
  await send(ips('Apache.Log4j.RCE'), T0 + 3600_000 + 1); assert.equal(sent.length, 3, 'the same attack again an hour later');
  sent = []; S.resetForTests(); S.saveConfig({ allowed_sources: '10.1.0.1' }); for (let i = 0; i < 30; i++) await send(ips(`Attack.${i}`), T0 + i); assert.equal(sent.length, 10, 'ten an hour for a firewall');
  sent = []; S.resetForTests(); S.saveConfig({ allowed_sources: '10.1.0.1', notify_ips: false }); await send(ips('X.Y')); assert.deepEqual(sent, []);
  sent = []; S.resetForTests(); S.saveConfig({ allowed_sources: '10.1.0.1', notify_ips: true });
  await send(`${HEAD()} type="utm" subtype="virus" level="warning" action="blocked" srcip=10.1.0.77 dstip=93.184.216.34 virus="EICAR_TEST_FILE"`); assert.deepEqual(kinds(), ['fw_ips']); assert.match(sent[0][1], /^Malware: EICAR_TEST_FILE 10\.1\.0\.77 → 93\.184\.216\.34, blocked/);
});

test('system events are said (not too often), a login only when it is asked for', async () => {
  reset();
  const sys = `${HEAD()} type="event" subtype="system" level="warning" logdesc="Memory conserve mode entered" msg="memory 88%"`;
  await send(sys, T0); await send(sys, T0 + 60_000); assert.deepEqual(kinds(), ['fw_system']); await send(sys, T0 + 11 * 60_000); assert.equal(sent.length, 2, 'again after ten minutes');
  const login = `${HEAD()} type="event" subtype="system" level="information" logdesc="Admin login successful" user="sasa" ui="GUI(10.1.0.5)" srcip=10.1.0.5 action="login" status="success"`;
  sent = []; await send(login); assert.deepEqual(sent, [], 'off by default'); S.saveConfig({ notify_admin_login: true }); await send(login); await send(login, T0 + 1000); assert.deepEqual(kinds(), ['fw_admin_login']); assert.match(sent[0][1], /^Admin sasa logged in from 10\.1\.0\.5 \(GUI\(10\.1\.0\.5\)\) on FG-100F\.$/);
});

test('the events table is protected against a flood of one kind', async () => {
  reset(); const login = (i) => `${HEAD()} type="event" subtype="system" level="information" logdesc="Admin login successful" user="u${i}" srcip=10.1.0.5 status="success"`;
  for (let i = 0; i < 250; i++) await send(login(i), T0 + i);
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM syslog_events WHERE kind = 'admin_login'").get().n, 200); assert.equal(S.status().counters.events_dropped, 50);
  await send(adminFail(), T0 + 1000); assert.equal(db.prepare("SELECT COUNT(*) AS n FROM syslog_events WHERE kind = 'admin_login_failed'").get().n, 1, 'the others are not affected'); await send(login(1), T0 + 61_000); assert.equal(db.prepare("SELECT COUNT(*) AS n FROM syslog_events WHERE kind = 'admin_login'").get().n, 201, 'and the next minute starts again');
});

test('a firewall that goes quiet is noticed, and its return', async () => {
  reset(); S.saveConfig({ allowed_sources: '10.1.0.1', silent_minutes: 15 });
  const base = Date.now() + 3 * 3600_000;                         // the service has been running for a while
  await send(traffic(), base); await S.tick(base + 60_000, { notifier }); await S.tick(base + 10 * 60_000, { notifier }); assert.deepEqual(sent, [], 'ten minutes is not silence');
  await S.tick(base + 16 * 60_000, { notifier }); assert.deepEqual(kinds(), ['fw_log_silent']); assert.match(sent[0][1], /^No logs from FG-100F for 16 min \(the last one came at .*\)\. Check that the firewall still sends syslog/);
  await S.tick(base + 17 * 60_000 + 60_000, { notifier }); await S.tick(base + 30 * 60_000, { notifier }); assert.equal(sent.length, 1, 'said once');
  assert.equal(S.status().devices[0].silent, true);
  await send(traffic(), base + 31 * 60_000); assert.deepEqual(kinds(), ['fw_log_silent', 'fw_log_resumed']); assert.equal(S.status().devices[0].silent, false);
  assert.ok(db.prepare("SELECT value FROM syslog_config WHERE key = 'seen:FG-100F'").get(), 'when it was last heard is kept, to survive a restart');
});

test('what is shown: the events can be filtered and paged, the counters of what arrived are kept, old things are removed', async () => {
  reset();
  for (let i = 0; i < 6; i++) await send(i % 2 ? adminFail(`185.1.2.${i}`, `user${i}`) : config(i), T0 + i * 1000);
  await send(ips('100%_Attack\\X'), T0 + 7000);
  assert.equal(S.events({}).length, 7); assert.equal(S.events({})[0].kind, 'ips', 'the newest first');
  assert.deepEqual(S.events({ kind: 'admin_login_failed' }).map((e) => e.srcip), ['185.1.2.5', '185.1.2.3', '185.1.2.1']); assert.equal(S.events({ level: 'warning' }).length, 4);
  assert.equal(S.events({ q: 'user3' }).length, 1); assert.equal(S.events({ q: '185.1.2' }).length, 4, 'three failed logins and the attack'); assert.equal(S.events({ q: '100%_' }).length, 1, 'a % or _ in the search is itself'); assert.equal(S.events({ q: '%' }).length, 1);
  const page = S.events({ limit: 3 }); assert.equal(page.length, 3); assert.equal(S.events({ limit: 3, before: page[2].id }).length, 3); assert.equal(S.events({ limit: 99999 }).length, 7); assert.equal(S.events({ device: 'nope' }).length, 0);
  assert.match(S.events({ kind: 'config_change' })[0].raw, /logdesc="Attribute configured"/);
  await S.tick(T0 + 10_000, { notifier }); const st = db.prepare('SELECT SUM(received) AS r, SUM(unparsed) AS u FROM syslog_stats').get(); assert.equal(st.r, 7);
  db.prepare('INSERT INTO syslog_events (ts, device, kind, level, summary) VALUES (?, ?, ?, ?, ?)').run(Math.floor(T0 / 1000) - 100 * 86400, 'FG', 'old', 'info', 'old'); db.prepare('INSERT INTO syslog_hourly (device, hour) VALUES (?, ?)').run('FG', Math.floor(T0 / 1000) - 500 * 86400);
  assert.deepEqual(S.purge(Math.floor(T0 / 1000)), { events: 1, hourly: 1, stats: 0 });
});
