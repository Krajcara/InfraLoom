'use strict';

// Domains through the API, against a fake Cloudflare: the token, the refresh, the table, domains added by hand, muting, and the alert.

const test = require('node:test');
const assert = require('node:assert/strict');
const { startServer, clientsFor } = require('./_helpers');
const { startFakeCloudflare, txt, TOKEN } = require('./_fakeCloudflare');
const { reportXml } = require('./_dmarcSamples');

const D = '/api/dmarc';
let cf; let srv; let c;
test.before(async () => {
  cf = await startFakeCloudflare({
    zones: [{ id: 'z1', name: 'comdata.rs' }, { id: 'z2', name: 'bizcentar.com' }, { id: 'z3', name: 'parked.example' }],
    records: { 'comdata.rs': [txt('"v=DMARC1; p=quarantine; rua=mailto:dmarc@comdata.rs"')], 'bizcentar.com': [txt('"v=DMARC1; p=none; rua=mailto:dmarc@comdata.rs"')], 'parked.example': [] },
  });
  srv = await startServer({ DMARC_CLOUDFLARE_BASE_URL: cf.url });
  c = await clientsFor(srv);
  await c.admin.put(`${D}/settings`, { enabled: true, mailbox: 'dmarc@comdata.rs' });
});
test.after(() => { srv?.stop(); cf?.close(); });

const upload = async (who, xml) => {
  const res = await fetch(`${srv.base}${D}/upload`, { method: 'POST', headers: { 'Content-Type': 'application/octet-stream', 'X-Filename': 'r.xml', Cookie: who.cookie }, body: xml });
  return { status: res.status, body: await res.json() };
};
const table = async () => (await c.viewer.get(`${D}/summary`)).body.domainTable;
const row = async (name) => (await table()).find((d) => d.name === name);

test('the Cloudflare token: write-only, checked for its shape, and tested against Cloudflare', async () => {
  assert.equal((await c.operator.put(`${D}/settings`, { cf_token: TOKEN })).status, 403);
  assert.equal((await c.viewer.post(`${D}/test-cloudflare`)).status, 403);
  const none = await c.admin.post(`${D}/test-cloudflare`); assert.equal(none.status, 400); assert.match(none.body.error, /No Cloudflare API token is saved/);
  const bad = await c.admin.put(`${D}/settings`, { cf_token: 'short' }); assert.equal(bad.status, 400); assert.match(bad.body.error, /Cloudflare API token looks wrong/);
  assert.equal((await c.admin.get(`${D}/settings`)).body.cf_token_set, false);
  const wrong = await c.admin.put(`${D}/settings`, { cf_token: 'wrongTokenWrongTokenWrongToken1234' }); assert.equal(wrong.body.cf_token_set, true);
  const w = await c.admin.post(`${D}/test-cloudflare`); assert.equal(w.status, 502); assert.match(w.body.error, /Cloudflare 401: Invalid API Token \(code 1000\)/);
  const ok = await c.admin.put(`${D}/settings`, { cf_token: TOKEN });
  assert.deepEqual([ok.status, ok.body.cf_token_set, ok.body.cf_configured, ok.body.cf_check_records], [200, true, true, true]);
  assert.ok(!JSON.stringify(ok.body).includes(TOKEN), 'not in the answer to the save'); assert.ok(!JSON.stringify((await c.admin.get(`${D}/settings`)).body).includes(TOKEN), 'not in a later read');
  assert.ok(!JSON.stringify((await c.admin.get('/api/settings')).body).includes(TOKEN), 'the general settings API does not know it');
  const audit = JSON.stringify((await c.admin.get('/api/audit-log?limit=100')).body); assert.ok(audit.includes('cf_token') && !audit.includes(TOKEN), 'the change is logged, the token is not');
  const t = await c.admin.post(`${D}/test-cloudflare`); assert.deepEqual([t.status, t.body], [200, { ok: true, zones: 3 }]);
});

test('refreshing the domains puts every zone on the page, with what its DMARC record says', async () => {
  assert.equal((await c.viewer.post(`${D}/domains/refresh`)).status, 403);
  const r = await c.operator.post(`${D}/domains/refresh`);
  assert.equal(r.status, 200); assert.deepEqual([r.body.zones, r.body.domains, r.body.checked, r.body.alerts], [3, 3, 3, 0]);
  const s = (await c.viewer.get(`${D}/summary`)).body;
  assert.deepEqual(s.cloudflare.enabled, true); assert.ok(s.cloudflare.lastRefresh); assert.equal(s.cloudflare.lastError, null);
  const byName = Object.fromEntries(s.domainTable.map((d) => [d.name, d]));
  assert.deepEqual(Object.keys(byName).sort(), ['bizcentar.com', 'comdata.rs', 'parked.example']);
  assert.deepEqual([byName['comdata.rs'].record.health, byName['comdata.rs'].record.rua, byName['comdata.rs'].record.rua_missing, byName['comdata.rs'].issue], ['protected', ['dmarc@comdata.rs'], false, false]);
  assert.deepEqual([byName['bizcentar.com'].record.health, byName['bizcentar.com'].issue], ['monitor', false]);
  assert.deepEqual([byName['parked.example'].record.health, byName['parked.example'].issue, byName['parked.example'].total], ['no_record', true, 0]);
  assert.deepEqual([byName['comdata.rs'].source, byName['comdata.rs'].ignored], ['cloudflare', false]);
  assert.equal(cf.log.filter((l) => l.method !== 'GET').length, 0, 'only reads');
  assert.ok(cf.log.every((l) => l.auth === `Bearer ${TOKEN}` || l.auth === 'Bearer wrongTokenWrongTokenWrongToken1234'));
  assert.equal((await c.viewer.get(`${D}/dashboard`)).body.domain_issues, 1, 'the dashboard counts the domain that needs a look');
  assert.equal((await c.admin.get('/api/notifications')).body && JSON.stringify((await c.admin.get('/api/notifications')).body).includes('changed for the worse'), false, 'the first look raises nothing');
});

test('the table joins the stats of the period: the split of DKIM and SPF, the policy from the reports, and domains that only appear in reports', async () => {
  const mk = (id, domain, records) => reportXml({ id, domain, records });
  assert.equal((await upload(c.operator, mk('c1', 'comdata.rs', [{ ip: '192.0.2.1', count: 100 }, { ip: '192.0.2.2', count: 40, dkim: 'fail', spf: 'pass', dkimAuth: [{ domain: 'esp.example', result: 'pass' }] }, { ip: '192.0.2.3', count: 10, dkim: 'fail', spf: 'fail', dkimAuth: [], spfAuth: [{ domain: 'x.example', result: 'fail' }] }]))).status, 200);
  assert.equal((await upload(c.operator, mk('o1', 'unlisted.example', [{ ip: '198.51.100.1', count: 7 }]))).status, 200);
  const d = await row('comdata.rs');
  assert.deepEqual([d.total, d.pass, d.fail, d.reports], [150, 140, 10, 1]);
  assert.deepEqual(d.dkim, { aligned: 100, notAligned: 40, failed: 10 }, 'DKIM: 100 aligned, 40 passed for the ESP\'s own domain, 10 had no signature');
  assert.deepEqual(d.spf, { aligned: 140, notAligned: 0, failed: 10 });
  assert.deepEqual(d.policy, { p: 'quarantine', sp: 'quarantine', pct: 100, from: 'reports' });
  const quiet = await row('bizcentar.com'); assert.deepEqual([quiet.total, quiet.reports, quiet.policy.from, quiet.policy.p], [0, 0, 'dns', 'none'], 'a domain with no reports shows the policy of its record');
  const u = await row('unlisted.example'); assert.deepEqual([u.source, u.record, u.total, u.issue], ['reports', null, 7, false]);
  const s = (await c.viewer.get(`${D}/summary?domain=comdata.rs`)).body;
  assert.deepEqual(s.auth, { total: 150, dmarc: { pass: 140, fail: 10 }, dkim: { aligned: 100, notAligned: 40, failed: 10 }, spf: { aligned: 140, notAligned: 0, failed: 10 } });
  assert.equal((await c.viewer.get(`${D}/summary?domain=comdata.rs`)).body.domainTable.length, 4, 'the table lists every domain whatever the filter');
});

test('domains added by hand: validated, once, checked, and removable — Cloudflare ones are not', async () => {
  assert.equal((await c.viewer.post(`${D}/domains`, { name: 'extra.example' })).status, 403);
  for (const bad of ['', 'nodot', 'http://x.example', 'a b.example', '-x.example']) { const r = await c.operator.post(`${D}/domains`, { name: bad }); assert.equal(r.status, 400, bad); assert.match(r.body.error, /not a domain name/); }
  const dup = await c.operator.post(`${D}/domains`, { name: 'COMDATA.RS' }); assert.equal(dup.status, 400); assert.match(dup.body.error, /already listed \(it comes from Cloudflare\)/);
  const ok = await c.operator.post(`${D}/domains`, { name: '  Extra.Example. ' });
  assert.equal(ok.status, 201); assert.deepEqual([ok.body.name, ok.body.source, ok.body.health], ['extra.example', 'manual', 'unchecked']);
  const again = await c.operator.post(`${D}/domains`, { name: 'extra.example' }); assert.equal(again.status, 400); assert.match(again.body.error, /already listed$/);
  assert.equal((await row('extra.example')).source, 'manual');
  assert.equal((await c.operator.post(`${D}/domains/remove`, { name: 'comdata.rs' })).status, 400);
  assert.match((await c.operator.post(`${D}/domains/remove`, { name: 'comdata.rs' })).body.error, /goes when it leaves Cloudflare/);
  assert.equal((await c.operator.post(`${D}/domains/remove`, { name: 'nothing.example' })).status, 404); assert.equal((await c.viewer.post(`${D}/domains/remove`, { name: 'extra.example' })).status, 403);
  assert.deepEqual((await c.operator.post(`${D}/domains/remove`, { name: 'extra.example' })).body, { removed: 'extra.example' });
  assert.equal(await row('extra.example'), undefined);
  const audit = JSON.stringify((await c.admin.get('/api/audit-log?limit=200')).body); for (const a of ['dmarc.domain.add', 'dmarc.domain.remove', 'dmarc.domains.refresh']) assert.ok(audit.includes(a), a);
});

test('muting a domain: it is left out of what needs a look', async () => {
  assert.equal((await c.viewer.patch(`${D}/domains`, { name: 'parked.example', ignored: true })).status, 403);
  assert.equal((await c.operator.patch(`${D}/domains`, { name: 'parked.example', ignored: 'yes' })).status, 400);
  assert.equal((await c.operator.patch(`${D}/domains`, { name: 'nothing.example', ignored: true })).status, 404);
  const m = await c.operator.patch(`${D}/domains`, { name: 'parked.example', ignored: true }); assert.deepEqual([m.status, m.body.ignored], [200, 1]);
  const p = await row('parked.example'); assert.deepEqual([p.ignored, p.issue], [true, false]);
  assert.equal((await c.viewer.get(`${D}/dashboard`)).body.domain_issues, 0);
  assert.equal((await c.operator.patch(`${D}/domains`, { name: 'parked.example', ignored: false })).body.ignored, 0);
  assert.equal((await c.viewer.get(`${D}/dashboard`)).body.domain_issues, 1);
});

test('a record that gets worse is announced, once', async () => {
  const notices = async () => JSON.stringify((await c.admin.get('/api/notifications')).body);
  cf.state.records['comdata.rs'] = [txt('"v=DMARC1; p=none; rua=mailto:dmarc@comdata.rs"')];
  const r = await c.operator.post(`${D}/domains/refresh`); assert.equal(r.body.alerts, 1);
  assert.match(await notices(), /the record of comdata\.rs changed for the worse — its policy is now p=none \(monitoring only\)/);
  assert.equal((await c.operator.post(`${D}/domains/refresh`)).body.alerts, 0, 'once');
  cf.state.records['comdata.rs'] = [txt('"v=DMARC1; p=reject; rua=mailto:dmarc@comdata.rs"')];
  assert.equal((await c.operator.post(`${D}/domains/refresh`)).body.alerts, 0, 'better is not announced');
});

test('a Cloudflare that cannot be reached: the page says so, and the list stays', async () => {
  cf.state.token = 'revoked';
  const r = await c.operator.post(`${D}/domains/refresh`); assert.equal(r.status, 502); assert.match(r.body.error, /Cloudflare 401/);
  const s = (await c.viewer.get(`${D}/summary`)).body; assert.match(s.cloudflare.lastError, /Cloudflare 401/); assert.ok(s.domainTable.length >= 3);
  cf.state.token = TOKEN;
  assert.equal((await c.operator.post(`${D}/domains/refresh`)).status, 200); assert.equal((await c.viewer.get(`${D}/summary`)).body.cloudflare.lastError, null);
});

test('removing the token: the zones stay on the list until the next refresh, then Cloudflare is out of the picture', async () => {
  assert.equal((await c.admin.put(`${D}/settings`, { clear_cf_token: true })).body.cf_token_set, false);
  assert.equal((await c.viewer.get(`${D}/summary`)).body.cloudflare.enabled, false);
  assert.equal((await c.operator.post(`${D}/domains/refresh`)).status, 200, 'a refresh without Cloudflare just checks the domains that are there');
  assert.equal((await c.admin.post(`${D}/test-cloudflare`)).status, 400);
});
