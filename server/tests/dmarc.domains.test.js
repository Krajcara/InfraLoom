'use strict';

// The DMARC record of a domain (what it says, what it means), the DKIM/SPF breakdown, and refreshing the domains from Cloudflare.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dmarc-dom-'));
const hex = () => crypto.randomBytes(32).toString('hex');
Object.assign(process.env, { NODE_ENV: 'test', DB_PATH: path.join(dir, 'infraloom.db'), DB_ENCRYPTION_KEY: hex(), APP_SECRET: hex(), BACKUP_ENCRYPTION_PASSWORD: hex(), DMARC_PTR_LOOKUP: 'false', DMARC_DNS_LOOKUP: 'false' });

const db = require('../src/db/database');
const { createStore } = require('../src/services/dmarc/store');
const { createIngestor } = require('../src/services/dmarc/ingest');
const { createCloudflareClient } = require('../src/services/dmarc/cloudflare');
const D = require('../src/services/dmarc/domains');
const { startFakeCloudflare, txt, TOKEN } = require('./_fakeCloudflare');
const { reportXml } = require('./_dmarcSamples');

let cf;
test.before(async () => { cf = await startFakeCloudflare(); });
test.after(() => { cf?.close(); fs.rmSync(dir, { recursive: true, force: true }); });

test('a DMARC record is read into its tags', () => {
  const r = D.parseDmarcRecord('"v=DMARC1; p=Quarantine; sp=reject; pct=50; adkim=s; aspf=R; rua=mailto:Dmarc@Comdata.rs!10m, mailto:other@x.example; ruf=mailto:f@x.example"');
  assert.deepEqual(r, { ok: true, p: 'quarantine', sp: 'reject', pct: 50, adkim: 's', aspf: 'r', rua: ['dmarc@comdata.rs', 'other@x.example'], ruf: ['f@x.example'] });
  const d = D.parseDmarcRecord('v=DMARC1;p=none'); assert.deepEqual([d.ok, d.p, d.pct, d.adkim, d.rua], [true, 'none', 100, 'r', []]);
  assert.equal(D.txtText('"v=DMARC1; p=none; ru" "a=mailto:a@b.rs"'), 'v=DMARC1; p=none; rua=mailto:a@b.rs', 'a record split in pieces is put together');
  for (const [text, re] of [['', /empty/], ['p=none', /does not start with v=DMARC1/], ['v=DMARC1', /p= tag is missing/], ['v=DMARC1; p=maybe', /Unknown policy p=maybe/], ['v=DMARC1; p=none; pct=200', /Bad pct/], ['v=DMARC1; p=none; junk', /not a tag=value pair/]]) {
    const x = D.parseDmarcRecord(text); assert.equal(x.ok, false, text); assert.match(x.error, re, text);
  }
});

test('what the records at _dmarc add up to', () => {
  const h = (rec) => D.classifyRecords(rec).health;
  assert.equal(h({ txt: [] }), 'no_record');
  assert.equal(h({ txt: ['"v=spf1 -all"'] }), 'no_record', 'a TXT record that is not DMARC is no DMARC record');
  assert.equal(h({ txt: ['v=DMARC1; p=none'] }), 'monitor');
  assert.equal(h({ txt: ['"v=DMARC1; p=quarantine; pct=100"'] }), 'protected'); assert.equal(h({ txt: ['v=DMARC1; p=reject'] }), 'protected');
  assert.equal(h({ txt: ['v=DMARC1; p=reject; pct=25'] }), 'partial');
  assert.equal(h({ txt: ['v=DMARC1; p=none', 'v=DMARC1; p=reject'] }), 'multiple');
  assert.equal(h({ txt: ['v=DMARC1; p=bogus'] }), 'invalid'); assert.match(D.classifyRecords({ txt: ['v=DMARC1; p=bogus'] }).error, /Unknown policy/);
  const c = D.classifyRecords({ txt: [], cname: 'dmarc.hosted.example' }); assert.deepEqual([c.health, /CNAME to dmarc\.hosted\.example/.test(c.error)], ['unchecked', true]);
  const ok = D.classifyRecords({ txt: ['"v=DMARC1; p=quarantine; rua=mailto:dmarc@comdata.rs"'] }); assert.deepEqual([ok.p, ok.pct, ok.rua, ok.count], ['quarantine', 100, ['dmarc@comdata.rs'], 1]);
  assert.equal(D.isDomain('comdata.rs'), true); assert.equal(D.isDomain('xn--bcher-kva.example'), true); for (const bad of ['', 'nodot', 'a b.rs', '-x.rs', 'x..rs', 'http://x.rs', `${'a'.repeat(64)}.rs`]) assert.equal(D.isDomain(bad), false, bad);
  assert.equal(D.normalizeDomain('  ComData.RS. '), 'comdata.rs');
});

test('which domains need a look: a record that is missing or broken, or one that does not send the reports to this mailbox', () => {
  const row = (o) => ({ ignored: 0, health: 'protected', rua: 'dmarc@comdata.rs', ...o });
  const mb = 'dmarc@comdata.rs';
  assert.equal(D.hasIssue(row({}), mb), false);
  for (const health of ['no_record', 'multiple', 'invalid']) assert.equal(D.hasIssue(row({ health }), mb), true, health);
  assert.equal(D.hasIssue(row({ health: 'monitor' }), mb), false, 'p=none is a weak policy, not a broken record');
  assert.equal(D.hasIssue(row({ rua: 'someone@else.example' }), mb), true, 'the reports go somewhere else'); assert.equal(D.hasIssue(row({ rua: '' }), mb), true, 'no rua at all');
  assert.equal(D.hasIssue(row({ rua: 'x@y.z' }), ''), false, 'with no mailbox set there is nothing to compare with');
  assert.equal(D.hasIssue(row({ health: 'no_record', ignored: 1 }), mb), false, 'a muted domain is left alone'); assert.equal(D.hasIssue(row({ health: 'unchecked', rua: '' }), mb), false);
});

const mkIng = () => createIngestor({ store: createStore(db), graph: null, config: { trustedGroups: [], alertOnNewSources: false, alertOnOverrides: false, storeRawXml: false, initialLookbackDays: 30 }, notify: async () => {}, logger: { info() {}, warn() {}, error() {} }, reverse: async () => null });

test('DKIM and SPF: aligned, passed without being aligned, and failed — counted in messages', async () => {
  const store = createStore(db); const ing = mkIng();
  const rec = (ip, count, o) => ({ ip, count, ...o });
  const xml = reportXml({ id: 'st1', domain: 'stats.example', records: [
    rec('192.0.2.1', 100),                                                                                                  // both aligned and passed
    rec('192.0.2.2', 40, { dkim: 'fail', spf: 'pass', dkimAuth: [{ domain: 'esp.example', selector: 's', result: 'pass' }] }), // DKIM passed, but for the ESP's domain: not aligned; SPF aligned
    rec('192.0.2.3', 25, { dkim: 'pass', spf: 'fail', spfAuth: [{ domain: 'bounce.esp.example', result: 'pass' }] }),       // SPF passed for another domain: not aligned
    rec('192.0.2.4', 10, { dkim: 'fail', spf: 'fail', dkimAuth: [], spfAuth: [{ domain: 'x.example', result: 'fail' }] }),   // everything failed
    rec('192.0.2.5', 5, { dkim: 'fail', spf: 'pass', dkimAuth: [{ domain: 'stats.example', selector: 's', result: 'temperror' }] }), // DKIM could not be checked: counts as failed
  ] });
  const r = await ing.ingestBuffer(Buffer.from(xml), 'x.xml', { origin: 'upload' }, { quiet: true }); assert.equal(r.reports, 1);
  const since = Math.floor(Date.now() / 1000) - 7 * 86400;
  const [s] = store.domainStats(since, 'stats.example');
  assert.deepEqual({ ...s }, { domain: 'stats.example', reports: 1, total: 180, pass: 170, dkim_aligned: 125, dkim_unaligned_pass: 40, spf_aligned: 145, spf_unaligned_pass: 25 });
  const sum = store.summary(since, 'stats.example');
  assert.deepEqual(sum.auth, { total: 180, dmarc: { pass: 170, fail: 10 }, dkim: { aligned: 125, notAligned: 40, failed: 15 }, spf: { aligned: 145, notAligned: 25, failed: 10 } });
  const table = D.buildTable({ registry: [], stats: store.domainStats(since), policies: store.policyByDomain(since), mailbox: '' }).find((d) => d.name === 'stats.example');
  assert.deepEqual([table.total, table.pass, table.fail, table.source], [180, 170, 10, 'reports']);
  assert.deepEqual(table.dkim, { aligned: 125, notAligned: 40, failed: 15 }); assert.deepEqual(table.spf, { aligned: 145, notAligned: 25, failed: 10 });
  assert.deepEqual(table.policy, { p: 'quarantine', sp: 'quarantine', pct: 100, from: 'reports' }); assert.equal(table.record, null);
});

test('the Cloudflare client: zones page by page, records, and the reasons it can fail', async () => {
  cf.state.zones = Array.from({ length: 120 }, (_, i) => ({ id: `z${i}`, name: `d${i}.example` }));
  cf.state.records['d0.example'] = [txt('"v=DMARC1; p=reject; rua=mailto:dmarc@comdata.rs"')];
  cf.state.records['d1.example'] = [txt('"v=DMARC1; p=none"'), txt('"v=DMARC1; p=reject"'), { type: 'TXT', content: '"v=spf1 -all"' }];
  cf.state.records['d2.example'] = [{ type: 'CNAME', content: 'dmarc.hosted.example' }];
  const c = createCloudflareClient({ token: TOKEN, baseUrl: cf.url, logger: { warn() {} } });
  const zones = await c.listZones(); assert.equal(zones.length, 120); assert.deepEqual(zones[0], { id: 'z0', name: 'd0.example' });
  assert.equal(cf.log.filter((l) => l.path === '/zones').length, 3, 'three pages of 50');
  assert.deepEqual(await c.getDmarcRecords('z0', 'd0.example'), { txt: ['"v=DMARC1; p=reject; rua=mailto:dmarc@comdata.rs"'], cname: null });
  assert.equal((await c.getDmarcRecords('z1', 'd1.example')).txt.length, 3);
  assert.deepEqual(await c.getDmarcRecords('z2', 'd2.example'), { txt: [], cname: 'dmarc.hosted.example' });
  assert.deepEqual(await c.getDmarcRecords('z3', 'd3.example'), { txt: [], cname: null });
  assert.deepEqual(await c.test(), { ok: true, zones: 120 });
  cf.state.noDns = true;
  await assert.rejects(c.getDmarcRecords('z0', 'd0.example'), (e) => e.permission === true && /^Cloudflare 403: Unauthorized to access requested resource \(code 9109\)/.test(e.message) && e.status === 403);
  cf.state.noDns = false;
  await assert.rejects(createCloudflareClient({ token: 'wrong', baseUrl: cf.url }).listZones(), /Cloudflare 401: Invalid API Token \(code 1000\)/);
  cf.state.throttleOnce = true; assert.equal((await c.test()).zones, 120); assert.equal(cf.state.throttled, 1, 'a 429 is waited out and the request repeated');
  assert.throws(() => createCloudflareClient({ token: '' }), /token is needed/);
  const other = cf.log.filter((l) => l.method !== 'GET'); assert.equal(other.length, 0, 'only reads');
});

const mkSvc = (over = {}) => {
  const sent = []; const store = createStore(db);
  const cloudflare = over.noCloudflare ? null : createCloudflareClient({ token: TOKEN, baseUrl: cf.url, logger: { warn() {} } });
  const svc = D.createDomainService({ store, cloudflare, config: { cfCheckRecords: true, mailbox: 'dmarc@comdata.rs', ...over.config }, notify: async (event, message) => { sent.push({ event, message }); }, resolveTxt: over.resolveTxt, logger: { error() {}, warn() {}, info() {} } });
  return { store, svc, sent };
};
const reg = (store, name) => store.getRegistry(name);

test('refreshing the domains: the first look is a baseline, and then only a change for the worse is news', async () => {
  db.prepare('DELETE FROM dmarc_domains').run();
  cf.state.zones = [{ id: 'za', name: 'a.example' }, { id: 'zb', name: 'b.example' }, { id: 'zc', name: 'c.example' }, { id: 'zd', name: 'd.example' }];
  cf.state.records = {
    'a.example': [txt('"v=DMARC1; p=quarantine; rua=mailto:dmarc@comdata.rs"')], 'b.example': [txt('"v=DMARC1; p=reject; rua=mailto:dmarc@comdata.rs"')],
    'c.example': [txt('"v=DMARC1; p=quarantine; rua=mailto:dmarc@comdata.rs"')], 'd.example': [],
  };
  const m = mkSvc(); m.store.addManual('manual.example');
  const first = await m.svc.refresh();
  assert.deepEqual([first.zones, first.domains, first.checked, first.alerts], [4, 5, 5, 0]);
  assert.deepEqual(['a', 'b', 'c', 'd'].map((x) => reg(m.store, `${x}.example`).health), ['protected', 'protected', 'protected', 'no_record'], 'the record of each zone was read through the API');
  assert.equal(reg(m.store, 'a.example').rua, 'dmarc@comdata.rs'); assert.equal(reg(m.store, 'a.example').zone_id, 'za'); assert.equal(reg(m.store, 'manual.example').health, 'unchecked', 'a manual domain is looked up in public DNS (switched off in the tests)');
  assert.equal(m.sent.length, 0, 'nothing is announced the first time: d.example has no record, but that is the starting point');
  assert.equal(first.problems, 1, 'one domain needs a look: d.example'); assert.ok(m.store.getState('domains_refreshed')); assert.equal(m.store.getState('domains_error'), '');

  cf.state.records['a.example'] = [txt('"v=DMARC1; p=none; rua=mailto:dmarc@comdata.rs"')];            // weaker
  cf.state.records['b.example'] = [];                                                                    // gone
  cf.state.records['c.example'] = [txt('"v=DMARC1; p=quarantine; rua=mailto:somebody@else.example"')]; // reports go elsewhere
  cf.state.records['d.example'] = [txt('"v=DMARC1; p=reject; rua=mailto:dmarc@comdata.rs"')];         // better
  const second = await m.svc.refresh();
  assert.equal(second.alerts, 3);
  const msgs = m.sent.map((s) => s.message).sort();
  assert.ok(msgs.every((x, i) => m.sent[i].event === 'dmarc_domain_issue' || m.sent.every((s) => s.event === 'dmarc_domain_issue')));
  assert.match(msgs.find((x) => x.includes('a.example')), /^DMARC: the record of a\.example changed for the worse — its policy is now p=none \(monitoring only\)\.$/);
  assert.match(msgs.find((x) => x.includes('b.example')), /its DMARC record is gone/);
  assert.match(msgs.find((x) => x.includes('c.example')), /its rua no longer includes dmarc@comdata\.rs/);
  assert.ok(!msgs.some((x) => x.includes('d.example')), 'an improvement is not announced');
  const third = await m.svc.refresh(); assert.equal(third.alerts, 0, 'and a change is announced once');
});

test('a muted domain raises nothing, and a zone that left Cloudflare leaves the list (a domain added by hand stays)', async () => {
  const m = mkSvc();
  m.store.setIgnored('c.example', true);
  cf.state.records['c.example'] = [];
  await m.svc.refresh(); assert.equal(m.sent.length, 0, 'c.example lost its record, but it is muted'); assert.equal(reg(m.store, 'c.example').health, 'no_record');
  cf.state.zones = cf.state.zones.filter((z) => z.name !== 'd.example');
  const r = await m.svc.refresh(); assert.equal(r.zones, 3);
  assert.equal(reg(m.store, 'd.example'), undefined); assert.equal(reg(m.store, 'manual.example').source, 'manual'); assert.equal(reg(m.store, 'c.example').ignored, 1, 'the mute is kept');
});

test('a token that may list zones but not read DNS: the domains are listed and say why they are not checked', async () => {
  db.prepare('DELETE FROM dmarc_domains').run(); cf.state.noDns = true;
  const m = mkSvc(); const r = await m.svc.refresh();
  assert.ok(r.domains >= 3); const row = reg(m.store, 'a.example');
  assert.equal(row.health, 'unchecked'); assert.match(row.record_error, /needs Zone → DNS → Read/);
  cf.state.noDns = false;
  const off = mkSvc({ config: { cfCheckRecords: false } }); await off.svc.refresh();
  assert.equal(reg(off.store, 'a.example').health, 'unchecked', 'with the record check switched off it goes to public DNS instead (off in the tests)');
});

test('public DNS is used for a domain added by hand, and for a Cloudflare token that is not allowed to read records', async () => {
  db.prepare('DELETE FROM dmarc_domains').run();
  const lookups = [];
  const m = mkSvc({ noCloudflare: true, resolveTxt: async (name) => { lookups.push(name); if (name === '_dmarc.good.example') return ['v=DMARC1; p=reject; rua=mailto:dmarc@comdata.rs']; if (name === '_dmarc.none.example') { throw Object.assign(new Error('x'), { code: 'ENODATA' }); } if (name === '_dmarc.slow.example') throw Object.assign(new Error('x'), { code: 'ETIMEOUT' }); return []; } });
  for (const n of ['good.example', 'none.example', 'slow.example']) m.store.addManual(n);
  const r = await m.svc.refresh(); assert.deepEqual([r.zones, r.checked], [null, 3]);
  assert.deepEqual(lookups.sort(), ['_dmarc.good.example', '_dmarc.none.example', '_dmarc.slow.example']);
  assert.equal(reg(m.store, 'good.example').health, 'protected'); assert.equal(reg(m.store, 'none.example').health, 'no_record');
  assert.equal(reg(m.store, 'slow.example').health, 'unchecked'); assert.match(reg(m.store, 'slow.example').record_error, /DNS lookup failed: ETIMEOUT/);
});

test('a failing Cloudflare is reported, and keeps what was known', async () => {
  const m = mkSvc(); const before = m.store.listRegistry().length;
  cf.state.token = 'revoked';
  await assert.rejects(m.svc.refresh(), /Cloudflare 401: Invalid API Token/);
  assert.match(m.store.getState('domains_error'), /Invalid API Token/); assert.equal(m.store.listRegistry().length, before, 'the list is not emptied');
  cf.state.token = TOKEN;
  await m.svc.refresh(); assert.equal(m.store.getState('domains_error'), '');
});

test('more than ten domains that got worse: ten are announced, and one more says how many were left', async () => {
  db.prepare('DELETE FROM dmarc_domains').run();
  cf.state.zones = Array.from({ length: 13 }, (_, i) => ({ id: `y${i}`, name: `many${i}.example` }));
  cf.state.records = Object.fromEntries(cf.state.zones.map((z) => [z.name, [txt('"v=DMARC1; p=reject; rua=mailto:dmarc@comdata.rs"')]]));
  const m = mkSvc(); await m.svc.refresh();
  cf.state.records = Object.fromEntries(cf.state.zones.map((z) => [z.name, []]));
  const r = await m.svc.refresh(); assert.equal(r.alerts, 10);
  assert.equal(m.sent.length, 11); assert.match(m.sent[10].message, /3 more domains changed for the worse/);
});
