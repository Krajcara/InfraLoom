'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { parseLine, eventSeconds } = require('../src/services/syslog/parser');
const { classify, trafficOf } = require('../src/services/syslog/rules');
const { Aggregator, toRow, combine, MAX_KEYS, OTHER } = require('../src/services/syslog/aggregate');

// lines the way a FortiGate 7.4 writes them
const HEAD = 'date=2026-10-23 time=11:02:03 devname="FG-100F" devid="FG100FTK21000001" eventtime=1798020123456789012 tz="+0200"';
const TRAFFIC = `<189>${HEAD} logid="0000000013" type="traffic" subtype="forward" level="notice" vd="root" srcip=10.1.0.55 srcport=51234 srcintf="lan" srcintfrole="lan" dstip=142.250.74.46 dstport=443 dstintf="wan1" dstintfrole="wan" srccountry="Reserved" dstcountry="United States" sessionid=123456 proto=6 action="close" policyid=3 policytype="policy" policyname="LAN to WAN" service="HTTPS" trandisp="snat" appid=41469 app="Google.Services" appcat="Web.Client" duration=12 sentbyte=1234 rcvdbyte=56789 sentpkt=10 rcvdpkt=12 utmaction="allow"`;
const DENY = `<189>${HEAD} logid="0000000013" type="traffic" subtype="forward" level="warning" vd="root" srcip=185.1.2.3 srcport=4444 srcintf="wan1" dstip=203.0.113.2 dstport=3389 dstintf="lan" srccountry="Russian Federation" action="deny" policyid=0 service="RDP"`;
const ADMIN_FAIL = `${HEAD} logid="0100032002" type="event" subtype="system" level="alert" vd="root" logdesc="Admin login failed" sn="0" user="admin" ui="https(185.1.2.3)" method="https" srcip=185.1.2.3 dstip=10.1.0.1 action="login" status="failed" reason="name_invalid" msg="Administrator admin login failed from https(185.1.2.3) because of invalid user name"`;
const ADMIN_OK = `${HEAD} logid="0100032001" type="event" subtype="system" level="information" vd="root" logdesc="Admin login successful" user="sasa" ui="GUI(10.1.0.5)" method="https" srcip=10.1.0.5 dstip=10.1.0.1 action="login" status="success" reason="none"`;
const CONFIG = `${HEAD} logid="0100044546" type="event" subtype="system" level="information" vd="root" logdesc="Attribute configured" user="sasa" ui="GUI(10.1.0.5)" action="Edit" cfgtid=123 cfgpath="firewall.policy" cfgobj="3" cfgattr="status[enable->disable]" msg="Edit firewall.policy 3"`;
const VPN_FAIL = `${HEAD} logid="0101039426" type="event" subtype="vpn" level="alert" vd="root" logdesc="SSL VPN login fail" action="ssl-login-fail" tunneltype="ssl-web" remip=45.9.9.9 user="bob" group="N/A" reason="sslvpn_login_permission_denied"`;
const VPN_UP = `${HEAD} logid="0101039947" type="event" subtype="vpn" level="notice" vd="root" logdesc="SSL VPN tunnel up" action="tunnel-up" tunneltype="ssl-tunnel" remip=82.1.1.1 user="marko" group="vpn-users" tunnelid=1234`;
const IPS = `${HEAD} logid="0419016384" type="utm" subtype="ips" eventtype="signature" level="alert" vd="root" severity="high" srcip=185.1.2.3 dstip=10.1.0.20 action="dropped" proto=6 service="HTTPS" attack="Apache.Log4j.Error.Log.Remote.Code.Execution" attackid=51006`;
const VIRUS = `${HEAD} logid="0211008192" type="utm" subtype="virus" eventtype="infected" level="warning" vd="root" action="blocked" srcip=10.1.0.77 dstip=93.184.216.34 virus="EICAR_TEST_FILE" service="HTTP"`;

test('a FortiOS line: the pairs, the quotes, the priority and what comes before them', () => {
  const p = parseLine(TRAFFIC);
  assert.equal(p.pri, 189); assert.deepEqual([p.fields.devname, p.fields.type, p.fields.srcip, p.fields.sentbyte, p.fields.policyname, p.fields.dstcountry], ['FG-100F', 'traffic', '10.1.0.55', '1234', 'LAN to WAN', 'United States']);
  assert.equal(parseLine(Buffer.from(ADMIN_FAIL)).pri, null); assert.match(parseLine(ADMIN_FAIL).fields.msg, /invalid user name$/);
  assert.equal(parseLine(`Oct 23 11:02:03 FG-100F ${ADMIN_OK}`).fields.logdesc, 'Admin login successful', 'a syslog header in front is skipped');
  assert.equal(parseLine('<14>date=2026-10-23 time=1:1:1 type="event" msg="He said \\"no\\" twice" user="x"').fields.msg, 'He said "no" twice');
  assert.equal(parseLine('date=2026-10-23 time=1:1:1 devname="a b c" type="traffic" empty="" last=1').fields.empty, '');
  for (const bad of ['', '   ', 'hello world', '{"type":"traffic"}', '<13>some other daemon: started', 'a=b c=d']) assert.equal(parseLine(bad), null, JSON.stringify(bad));
  const huge = parseLine(`type="traffic" ${Array.from({ length: 500 }, (_, i) => `k${i}=v`).join(' ')}`); assert.ok(Object.keys(huge.fields).length <= 200, 'a line with hundreds of keys is cut');
});

test('the time of an event: the firewall\'s own when it is believable, else when it arrived', () => {
  const now = 1798020200;
  assert.equal(eventSeconds({ eventtime: '1798020123456789012' }, now), 1798020123, 'nanoseconds'); assert.equal(eventSeconds({ eventtime: '1798020123' }, now), 1798020123, 'seconds'); assert.equal(eventSeconds({ eventtime: '1798020123456' }, now), 1798020123, 'milliseconds');
  assert.equal(eventSeconds({ eventtime: '1500000000' }, now), now, 'a clock that is years off'); assert.equal(eventSeconds({}, now), now); assert.equal(eventSeconds({ eventtime: 'x' }, now), now);
});

test('what an event means', () => {
  const k = (line) => { const c = classify(parseLine(line).fields); return c && [c.kind, c.level]; };
  assert.deepEqual(k(ADMIN_FAIL), ['admin_login_failed', 'warning']); assert.deepEqual(k(ADMIN_OK), ['admin_login', 'info']); assert.deepEqual(k(CONFIG), ['config_change', 'info']);
  assert.deepEqual(k(VPN_FAIL), ['vpn_login_failed', 'warning']); assert.deepEqual(k(VPN_UP), ['vpn_login', 'info']); assert.deepEqual(k(IPS), ['ips', 'warning']); assert.deepEqual(k(VIRUS), ['malware', 'warning']);
  const f = classify(parseLine(ADMIN_FAIL).fields); assert.deepEqual([f.user, f.srcip], ['admin', '185.1.2.3']); assert.equal(f.summary, 'Admin login failed: admin from 185.1.2.3 (https(185.1.2.3)), name_invalid');
  assert.equal(classify(parseLine(CONFIG).fields).summary, 'Edit firewall.policy 3 (status[enable->disable]) by sasa via GUI(10.1.0.5)');
  const v = classify(parseLine(VPN_FAIL).fields); assert.deepEqual([v.srcip, v.user], ['45.9.9.9', 'bob'], 'the client of a VPN is in remip');
  assert.equal(classify(parseLine(IPS).fields).summary, 'IPS: Apache.Log4j.Error.Log.Remote.Code.Execution from 185.1.2.3 to 10.1.0.20, severity high, dropped');
  assert.equal(classify(parseLine(IPS.replace('severity="high"', 'severity="critical"')).fields).level, 'critical'); assert.equal(classify(parseLine(IPS.replace('severity="high"', 'severity="low"').replace('level="alert"', 'level="notice"')).fields).level, 'info');
  assert.equal(classify(parseLine(`${HEAD} type="event" subtype="system" level="warning" logdesc="Memory conserve mode entered" msg="mem 88%"`).fields).kind, 'system_event');
  assert.equal(classify(parseLine(`${HEAD} type="event" subtype="ha" level="notice" logdesc="HA state changed" msg="member is now primary"`).fields).kind, 'system_event');
  assert.equal(classify(parseLine(`${HEAD} type="utm" subtype="webfilter" level="warning" action="blocked" hostname="bad.example" catdesc="Malicious Websites" srcip=10.1.0.9`).fields).kind, 'web_blocked');
  for (const none of [TRAFFIC, `${HEAD} type="event" subtype="system" level="information" logdesc="DHCP statistics"`, `${HEAD} type="utm" subtype="webfilter" action="passthrough"`, `${HEAD} type="event" subtype="router" level="notice" logdesc="Routing log"`]) assert.equal(classify(parseLine(none).fields), null);
});

test('the numbers of a traffic log: only a session that ended, or one that was stopped', () => {
  const t = trafficOf(parseLine(TRAFFIC).fields);
  assert.deepEqual([t.blocked, t.out, t.in, t.src, t.dst, t.app, t.country, t.service, t.policy], [false, 1234, 56789, '10.1.0.55', '142.250.74.46', 'Google.Services', 'United States', 'HTTPS', '3 LAN to WAN']);
  const d = trafficOf(parseLine(DENY).fields); assert.deepEqual([d.blocked, d.out, d.in, d.src, d.country, d.app], [true, 0, 0, '185.1.2.3', null, 'RDP']);
  assert.equal(trafficOf(parseLine(TRAFFIC.replace(' sentbyte=1234 rcvdbyte=56789', '').replace('action="close"', 'action="start"')).fields), null, 'the start of a session is counted when it ends');
  assert.equal(trafficOf(parseLine(ADMIN_FAIL).fields), null);
  assert.equal(trafficOf(parseLine(TRAFFIC.replace('utmaction="allow"', 'utmaction="block"')).fields).blocked, true, 'stopped by a security profile');
  assert.equal(trafficOf(parseLine(TRAFFIC.replace('dstip=142.250.74.46', 'dstip=142.250.74.46 hostname="www.google.com"')).fields).dst, 'www.google.com');
});

test('the hours are summed up by who, to where and which application; the biggest are kept', () => {
  const a = new Aggregator(); const H = 1798020000 - (1798020000 % 3600);
  const t = (o) => ({ blocked: false, out: 0, in: 0, src: '10.1.0.55', srcName: null, dst: 'a.example', app: 'Web', country: 'Serbia', service: 'HTTPS', policy: '3', user: null, ...o });
  a.add('FG', H + 10, t({ out: 100, in: 900 })); a.add('FG', H + 20, t({ out: 50, in: 450, src: '10.1.0.56', srcName: 'laptop-ana' })); a.add('FG', H + 30, t({ blocked: true, src: '185.1.2.3', app: 'RDP', service: 'RDP', dst: '203.0.113.2', country: null }));
  a.add('FG', H + 3700, t({ out: 1, in: 1 }));
  const live = a.live('FG'); assert.equal(live.length, 2);
  const c = combine(live.filter((b) => b.hour === H)); assert.deepEqual([c.sessions, c.blocked, c.bytes_out, c.bytes_in], [3, 1, 150, 1350]);
  assert.deepEqual(c.top.src.map((r) => [r.key, r.name, r.bytes, r.sessions, r.blocked]), [['10.1.0.55', null, 1000, 1, 0], ['10.1.0.56', 'laptop-ana', 500, 1, 0], ['185.1.2.3', null, 0, 1, 1]]);
  assert.deepEqual(c.top.blocked_src.map((r) => [r.key, r.blocked]), [['185.1.2.3', 1]]); assert.deepEqual(c.top.app.map((r) => [r.key, r.bytes]), [['Web', 1500], ['RDP', 0]]);
  const taken = a.take(H + 3700); assert.deepEqual(taken.map((b) => b.hour), [H], 'only the hour that is over'); assert.equal(a.live('FG').length, 1);
  const row = toRow(taken[0]); assert.deepEqual([row.device, row.hour, row.sessions, row.blocked], ['FG', H, 3, 1]);
  const again = combine([row, { ...row, sessions: 2, blocked: 0, bytes_out: 10, bytes_in: 20 }]); assert.deepEqual([again.sessions, again.top.src[0].bytes], [5, 2000], 'rows from the database add up, whatever the hour');
  assert.equal(JSON.parse(row.top).names['10.1.0.56'], 'laptop-ana');
  assert.equal(a.take(H + 7200, true).length, 1, 'all of them when asked');
});

test('a dimension is bounded: an attack from thousands of addresses does not grow the memory without end', () => {
  const a = new Aggregator(); const H = 1798020000;
  for (let i = 0; i < MAX_KEYS + 500; i++) a.add('FG', H, { blocked: true, out: 0, in: 0, src: `10.${i >> 8 & 255}.${i & 255}.1`, dst: 'x', app: 'a', country: null, service: 's', policy: '1', user: null, srcName: null });
  const b = a.live('FG')[0]; assert.equal(b.dims.src.size, MAX_KEYS + 1, 'the keys, and one entry for the rest'); assert.equal(b.dims.src.get(OTHER)[1], 500);
  const row = toRow(b); assert.ok(row.top.length < 20000, `what is stored stays small (${row.top.length} bytes)`); assert.equal(b.sessions, MAX_KEYS + 500, 'the totals are exact');
});
