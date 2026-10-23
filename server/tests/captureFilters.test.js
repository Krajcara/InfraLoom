'use strict';

// The capture-filter library is checked against the real tools: every capture filter has to compile in tcpdump, and every display
// filter in tshark. (The tools are skipped when they are not installed; the rest is checked anyway.)

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const has = (cmd) => spawnSync('sh', ['-c', `command -v ${cmd}`]).status === 0;
let L;
test.before(async () => { L = await import('../../client/src/lib/captureFilters.js'); });

// sample values for every field, by key
const SAMPLE = { ip: '10.1.0.5', a: '10.1.0.5', b: '10.1.0.6', net: '10.1.0.0/24', port: '443', mac: 'aa:bb:cc:dd:ee:ff', vlan: '20', name: 'example.com' };

test('what a field may hold', () => {
  const ok = (kind, v, out) => assert.equal(L.FIELD_KINDS[kind].clean(v), out ?? v, `${kind} ${v}`);
  const no = (kind, v) => assert.equal(L.FIELD_KINDS[kind].clean(v), null, `${kind} ${JSON.stringify(v)}`);
  for (const v of ['10.1.0.5', '0.0.0.0', '255.255.255.255', '::1', '2001:db8::1', 'FE80::1']) assert.notEqual(L.FIELD_KINDS.ip.clean(v), null, v);
  for (const v of ['10.1.0', '256.1.1.1', '10.1.0.5; ls', "1.1.1.1' or '1'='1", '', 'host', '10.1.0.5/24']) no('ip', v);
  ok('cidr', '10.1.0.0/24'); ok('cidr', '2001:db8::/32'); for (const v of ['10.1.0.0/33', '10.1.0.0', '10.1.0.0/', 'x/24', '2001:db8::/129']) no('cidr', v);
  ok('mac', 'AA-BB-CC-DD-EE-FF', 'aa:bb:cc:dd:ee:ff'); ok('mac', 'aa:bb:cc:dd:ee:ff'); for (const v of ['aa:bb:cc:dd:ee', 'aabb.ccdd.eeff', 'gg:bb:cc:dd:ee:ff', '']) no('mac', v);
  ok('port', '1'); ok('port', '65535'); ok('port', ' 0443 ', '443'); for (const v of ['0', '65536', '-1', '80;ls', '', '1e3']) no('port', v);
  ok('vlan', '4094'); for (const v of ['0', '4095', 'a']) no('vlan', v);
  ok('name', 'Example.COM', 'example.com'); ok('name', 'a_b.c-d.example'); for (const v of ['a b', 'a"b', "a'b", '-x', 'a;b', '$(id)', '']) no('name', v);
});

test('a template is filled in with cleaned values, and what is missing or wrong is named', () => {
  const e = L.FILTERS.find((x) => x.id === 'host-port');
  assert.deepEqual(L.fillTemplate(e.bpf, e.fields, { ip: ' 10.1.0.5 ', port: '0443' }), { text: 'host 10.1.0.5 and tcp port 443', missing: [] });
  assert.deepEqual(L.fillTemplate(e.bpf, e.fields, { ip: 'nope', port: '' }), { text: 'host {ip} and tcp port {port}', missing: ['ip', 'port'] });
  assert.deepEqual(L.fillTemplate(null, [], {}), { text: null, missing: [] });
  const mac = L.FILTERS.find((x) => x.id === 'mac'); assert.equal(L.fillTemplate(mac.display, mac.fields, { mac: 'AA-BB-CC-DD-EE-FF' }).text, 'eth.addr == aa:bb:cc:dd:ee:ff');
  assert.deepEqual(L.fillTemplate('{ip}', [], { ip: '1.1.1.1' }).missing, ['ip'], 'a placeholder that is not a field is never filled');
});

test('the library is well formed', () => {
  const ids = L.FILTERS.map((x) => x.id); assert.equal(new Set(ids).size, ids.length, 'ids are unique'); assert.ok(L.FILTERS.length >= 50);
  for (const e of L.FILTERS) {
    assert.ok(L.GROUPS.includes(e.group), `${e.id}: group`); assert.ok(e.title && e.about, `${e.id}: text`); assert.ok(e.bpf || e.display, `${e.id}: has a filter`);
    const used = [...`${e.bpf || ''} ${e.display || ''} ${JSON.stringify(e.mikrotik || {})}`.matchAll(/\{(\w+)\}/g)].map((m) => m[1]);
    for (const k of new Set(used)) assert.ok(e.fields.some((x) => x.key === k), `${e.id}: {${k}} has no field`);
    for (const fl of e.fields) { assert.ok(L.FIELD_KINDS[fl.kind], `${e.id}: kind ${fl.kind}`); assert.ok(SAMPLE[fl.key], `${e.id}: no sample value for ${fl.key}`); }
    for (const fl of e.fields) assert.ok(!/['"`$;\\]/.test(L.FIELD_KINDS[fl.kind].clean(SAMPLE[fl.key]) || '!'), `${e.id}: the sample is clean`);
  }
});

test('every capture filter compiles in tcpdump', { skip: !has('tcpdump') }, () => {
  const bad = [];
  for (const e of L.FILTERS.filter((x) => x.bpf)) {
    const { text, missing } = L.fillTemplate(e.bpf, e.fields, SAMPLE); assert.deepEqual(missing, [], e.id);
    const r = spawnSync('tcpdump', ['-d', text], { encoding: 'utf8' });
    if (r.status !== 0) bad.push(`${e.id}: ${text} → ${String(r.stderr).trim().split('\n')[0]}`);
  }
  assert.deepEqual(bad, [], 'filters tcpdump does not accept');
});

test('every display filter is valid in tshark', { skip: !has('tshark') }, () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cf-')); const pcap = path.join(dir, 'empty.pcap');
  fs.writeFileSync(pcap, Buffer.from('d4c3b2a1020004000000000000000000ffff000001000000', 'hex')); // a capture file with a header and no packets
  const bad = [];
  for (const e of L.FILTERS.filter((x) => x.display)) {
    const { text, missing } = L.fillTemplate(e.display, e.fields, SAMPLE); assert.deepEqual(missing, [], e.id);
    const r = spawnSync('tshark', ['-r', pcap, '-Y', text], { encoding: 'utf8' });
    if (r.status !== 0 || /isn't a valid display filter|is neither a field nor a protocol name|syntax error/i.test(r.stderr)) bad.push(`${e.id}: ${text} → ${String(r.stderr).trim().split('\n')[0]}`);
  }
  fs.rmSync(dir, { recursive: true, force: true });
  assert.deepEqual(bad, [], 'display filters tshark does not accept');
});

test('the commands: tcpdump, tshark, dumpcap, Wireshark, FortiGate and MikroTik', () => {
  const e = L.FILTERS.find((x) => x.id === 'host-port');
  const r = L.buildCommands(e, { ip: '10.1.0.5', port: '443' }, { iface: 'eth0', seconds: 30, file: 'web' });
  const by = Object.fromEntries(r.items.map((i) => [i.id, i]));
  assert.deepEqual(r.items.map((i) => i.id), ['tcpdump', 'tshark', 'dumpcap', 'wireshark', 'fortigate', 'mikrotik']);
  assert.equal(by.tcpdump.lines[0], "sudo timeout 30 tcpdump -i eth0 -nn -s 96 -w web.pcap 'host 10.1.0.5 and tcp port 443'");
  assert.deepEqual(by.tshark.lines, ["sudo tshark -i eth0 -f 'host 10.1.0.5 and tcp port 443' -a duration:30 -s 96 -w web.pcap", "tshark -r web.pcap -Y 'ip.addr == 10.1.0.5 && tcp.port == 443'", 'tshark -r web.pcap -q -z conv,ip']);
  assert.equal(by.dumpcap.lines[0], "sudo dumpcap -i eth0 -f 'host 10.1.0.5 and tcp port 443' -a duration:30 -s 96 -w web.pcap");
  assert.deepEqual(by.wireshark.lines, ['Capture → Capture Filters… → enter: host 10.1.0.5 and tcp port 443', 'Display filter bar: ip.addr == 10.1.0.5 && tcp.port == 443']);
  assert.equal(by.fortigate.lines[0], "diagnose sniffer packet eth0 'host 10.1.0.5 and tcp port 443' 4 100 l");
  assert.deepEqual(by.mikrotik.lines, ['/tool sniffer set filter-interface=eth0 filter-ip-address=10.1.0.5 filter-port=443 filter-ip-protocol=tcp file-name=web.pcap file-limit=10000KiB', '/tool sniffer start', '/tool sniffer stop']);
  const full = L.buildCommands(e, { ip: '10.1.0.5', port: '443' }, { snap: 'full' }); assert.match(full.items[0].lines[0], / -s 262144 /); assert.match(full.items[0].note, /Whole packets are kept/);
  assert.match(L.buildCommands(e, { ip: '10.1.0.5', port: '443' }, { iface: 'any' }).items.find((i) => i.id === 'mikrotik').lines[0], /filter-interface=all /, 'any is "all" on a MikroTik');
});

test('a filter that is only a display filter, and one the FortiGate may not take', () => {
  const disp = L.buildCommands(L.FILTERS.find((x) => x.id === 'tcp-retrans'), {}, {});
  assert.ok(disp.items.some((i) => i.id === 'tcpdump') && disp.capture === 'tcp', 'capture "tcp", then filter later');
  const none = { id: 'x', fields: [], bpf: null, display: 'dns', mikrotik: null }; const n = L.buildCommands(none, {}, {});
  assert.deepEqual(n.items.map((i) => i.id), ['wireshark', 'fortigate']); assert.match(n.items[1].lines[0], /diagnose sniffer packet any none 4 100 l/);
  const rst = L.buildCommands(L.FILTERS.find((x) => x.id === 'tcp-reset'), {}, {}); assert.match(rst.items.find((i) => i.id === 'fortigate').note, /reads bytes at an offset/);
  assert.equal(L.fortigateSimple('host 1.2.3.4 and port 53'), true); assert.equal(L.fortigateSimple('tcp[tcpflags] & tcp-rst != 0'), false);
});

test('bad options and missing fields stop the commands, and nothing is built from a half-filled filter', () => {
  const e = L.FILTERS.find((x) => x.id === 'host');
  assert.match(L.buildCommands(e, { ip: '10.1.0.5' }, { iface: 'eth0; reboot' }).error, /interface/);
  assert.match(L.buildCommands(e, { ip: '10.1.0.5' }, { file: '../x' }).error, /file name/);
  assert.match(L.buildCommands(e, { ip: '10.1.0.5' }, { seconds: 0 }).error, /seconds/); assert.match(L.buildCommands(e, { ip: '10.1.0.5' }, { seconds: 90000 }).error, /seconds/);
  const m = L.buildCommands(e, { ip: '' }, {}); assert.deepEqual([m.items.length, m.missing], [0, ['ip']]);
  const inj = L.buildCommands(e, { ip: "10.1.0.5' ; reboot ; '" }, {}); assert.deepEqual([inj.items.length, inj.missing], [0, ['ip']]);
});
