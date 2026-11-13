'use strict';

// DNS analytics of the domains hosted at Cloudflare, against a fake Cloudflare (zones and GraphQL): what is asked, what is shown, and what is said when Cloudflare refuses.

const test = require('node:test');
const assert = require('node:assert/strict');
const { startServer, clientsFor } = require('./_helpers');
const { startFakeCloudflare, ZONES } = require('./_fakeCfAnalytics');

const A = '/api/dns-analytics/cloudflare';
const [Z1, Z2, Z3] = ZONES.map((z) => z.id);
let srv; let c; let cf;
const NO_PERMISSION = /Zone → Analytics → Read/;

test.before(async () => {
  cf = await startFakeCloudflare();
  srv = await startServer({ CLOUDFLARE_ANALYTICS_BASE_URL: cf.url }); c = await clientsFor(srv);
});
test.after(() => { srv?.stop(); cf?.close(); });
const get = (p, who = c.viewer) => who.get(`${A}${p}`);
const hourly = (z, ts) => (z === Z1 ? 30 : z === Z2 ? 20 : 10) + ((ts / 3600) % 5);

test('without a token it says where to set it; and it is for people who are signed in', async () => {
  assert.equal((await c.anon.get(`${A}/stats`)).status, 401);
  for (const p of ['/zones', '/stats', `/stats?zone=${Z1}`]) { const r = await get(p); assert.equal(r.status, 400, p); assert.match(r.body.error, /token is not set: it is kept on the DNS page, under Cloudflare/); }
  assert.equal(cf.state.calls.length + cf.state.zoneCalls, 0, 'nothing was asked of Cloudflare');
  assert.equal((await c.admin.post('/api/dns/cloudflare/config', { token: 'cf-token' })).status, 200);
});

test('the domains the token sees, asked once in a while', async () => {
  const r = await get('/zones'); assert.equal(r.status, 200); assert.deepEqual(r.body.map((z) => z.name), ['ailomera.com', 'bizcentar.com', 'comdata.rs']);
  await get('/zones'); await get(`/stats?zone=${Z1}&range=7d`); assert.equal(cf.state.zoneCalls, 1, 'the list is remembered for five minutes'); assert.ok(cf.state.auth.every((h) => h === 'Bearer cf-token'));
});

test('one domain: the queries by the hour, the names, the types, the answers and the data centres', async () => {
  cf.state.calls.length = 0;
  const r = await get(`/stats?zone=${Z1}&range=24h`); assert.equal(r.status, 200); const s = r.body;
  assert.deepEqual([s.zone, s.name, s.range, s.bucket, s.cached, s.errors], [Z1, 'comdata.rs', '24h', 3600, false, {}]);
  assert.ok(s.timeline.length >= 24 && s.timeline.length <= 26); assert.ok(s.timeline.every((p) => p.queries === hourly(Z1, p.ts)), 'each hour as Cloudflare gave it'); assert.equal(s.queries, s.timeline.reduce((t, p) => t + p.queries, 0));
  assert.deepEqual(s.top.names.map((n) => [n.name, n.count]), [['www.comdata.rs', 900], ['mail.comdata.rs', 410], ['autodiscover.comdata.rs', 300], ['_dmarc.comdata.rs', 25]]);
  assert.deepEqual(s.top.types.map((n) => [n.name, n.count]), [['A', 1800], ['AAAA', 600], ['MX', 120], ['TXT', 90]], 'a type nobody asked for is not listed'); assert.deepEqual(s.top.codes.map((n) => n.name), ['NOERROR', 'NXDOMAIN', 'SERVFAIL']); assert.deepEqual(s.top.colos.map((n) => n.name), ['FRA', 'VIE', 'PRG']);
  const asked = cf.state.calls.filter((x) => x.zone === Z1); assert.deepEqual(asked.map((x) => x.dim).sort(), ['coloCode', 'datetimeHour', 'queryName', 'queryType', 'responseCode'], 'each figure is a query of its own');
  const w = asked[0]; assert.equal(Math.round((new Date(w.to) - new Date(w.from)) / 3600_000), 24); assert.match(w.query, /zones\(filter: \{zoneTag: \$zone\}\)/); assert.match(w.query, /dnsAnalyticsAdaptiveGroups\(limit: \d+, filter: \{datetime_geq: \$from, datetime_leq: \$to\}/);
});

test('asked again it is remembered; "refresh" asks again; a busy Cloudflare is waited for', async () => {
  const n = () => cf.state.calls.length; const before = n();
  const again = await get(`/stats?zone=${Z1}&range=24h`); assert.equal(again.body.cached, true); assert.equal(n(), before, 'not one query to Cloudflare');
  const fresh = await get(`/stats?zone=${Z1}&range=24h&refresh=1`); assert.equal(fresh.body.cached, false); assert.equal(n(), before + 5);
  cf.state.once429 = true; const busy = await get(`/stats?zone=${Z1}&range=24h&refresh=1`); assert.equal(busy.status, 200, 'the 429 was waited for and asked again'); assert.equal(cf.state.once429, false);
});

test('thirty days are shown by the day', async () => {
  const s = (await get(`/stats?zone=${Z2}&range=30d`)).body; assert.deepEqual([s.bucket, s.range], [86400, '30d']);
  assert.ok(s.timeline.length >= 30 && s.timeline.length <= 32); assert.ok(s.timeline.every((p) => p.ts % 86400 === 0));
  const mid = s.timeline[Math.floor(s.timeline.length / 2)]; let sum = 0; for (let h = 0; h < 24; h++) sum += hourly(Z2, mid.ts + h * 3600); assert.equal(mid.queries, sum, 'the hours of a day are added up');
});

test('all the domains: the queries of each, biggest first, and one timeline', async () => {
  const before = cf.state.calls.length; const s = (await get('/stats?range=24h')).body;
  assert.deepEqual([s.zone, s.range, s.bucket], ['all', '24h', 3600]); assert.deepEqual(s.zones.map((z) => z.name), ['comdata.rs', 'bizcentar.com', 'ailomera.com']);
  assert.equal(s.queries, s.zones.reduce((t, z) => t + z.queries, 0)); assert.ok(s.zones[0].queries > s.zones[1].queries && s.zones[1].queries > s.zones[2].queries);
  assert.ok(s.timeline.every((p) => p.queries === hourly(Z1, p.ts) + hourly(Z2, p.ts) + hourly(Z3, p.ts)), 'the timeline is the sum of the domains');
  const asked = cf.state.calls.slice(before); assert.ok(asked.every((x) => x.dim === 'datetimeHour'), 'for the table only the timeline is asked, not the lists'); assert.ok(asked.length <= 2, 'and the domains that were just read are remembered');
});

test('a figure that Cloudflare refuses leaves the others as they are, and says why', async () => {
  cf.state.mode.responseCode = 'unknown'; cf.state.mode['queryType'] = 'empty';
  const s = (await get(`/stats?zone=${Z1}&range=24h&refresh=1`)).body;
  assert.equal(s.errors.codes, 'unknown field "responseCode"'); assert.match(s.errors.types, /without the figures/); assert.deepEqual([s.top.codes, s.top.types], [[], []]); assert.equal(s.top.names.length, 4); assert.ok(s.queries > 0 && s.timeline.length > 0);
  cf.state.mode = {};
  cf.state.mode.datetimeHour = 'range'; const t = (await get(`/stats?zone=${Z1}&range=24h&refresh=1`)).body;
  assert.equal(t.errors.timeline, 'query time range is too large: the maximum is 7 days'); assert.equal(t.timeline, null); assert.equal(t.queries, 1800 + 600 + 120 + 90, 'without the timeline the total is the sum of the types'); cf.state.mode = {};
});

test('a token without the permission is told what to add; a token that is wrong is told that', async () => {
  cf.state.authzAll = true;
  for (const p of [`/stats?zone=${Z1}&range=24h&refresh=1`, '/stats?range=7d&refresh=1']) { const r = await get(p); assert.equal(r.status, 502, p); assert.match(r.body.error, NO_PERMISSION); }
  cf.state.authzAll = false;
  assert.equal((await c.admin.post('/api/dns/cloudflare/config', { token: 'wrong-token' })).status, 200);
  const bad = await get('/zones'); assert.equal(bad.status, 502); assert.match(bad.body.error, /Cloudflare refused the token: it is wrong, has expired, or cannot read zones/);
  assert.equal((await c.admin.post('/api/dns/cloudflare/config', { token: 'cf-token' })).status, 200); assert.equal((await get('/zones')).status, 200);
  cf.state.mode[`${Z2}|datetimeHour`] = 'range'; const all = await get('/stats?range=30d&refresh=1'); assert.equal(all.status, 200, 'if only some domains fail the others are shown');
  assert.deepEqual(all.body.zones.map((z) => [z.name, z.queries === null]), [['comdata.rs', false], ['ailomera.com', false], ['bizcentar.com', true]]); assert.match(all.body.errors['bizcentar.com'], /maximum is 7 days/);
  cf.state.mode.datetimeHour = 'range'; delete cf.state.mode[`${Z2}|datetimeHour`]; const none = await get('/stats?range=30d&refresh=1'); assert.equal(none.status, 502, 'if all of them fail it is said'); assert.match(none.body.error, /maximum is 7 days/); cf.state.mode = {};
});

test('what is asked for is checked', async () => {
  const bad = await get(`/stats?zone=${Z1}&range=2w`); assert.equal(bad.status, 400); assert.match(bad.body.error, /Range must be one of 24h, 7d, 30d/);
  assert.equal((await get('/stats?zone=../../etc')).status, 400); assert.equal((await get(`/stats?zone=${'d'.repeat(32)}`)).status, 404);
  assert.equal((await c.admin.post('/api/dns/cloudflare/config', { zone_id: Z2 })).status, 200); cf.state.mode = {};
  const only = await get('/zones'); assert.deepEqual(only.body.map((z) => z.name), ['bizcentar.com'], 'the one zone the DNS page was limited to');
  assert.equal((await get(`/stats?zone=${Z1}`)).status, 404, 'the others are not read'); assert.deepEqual((await get('/stats?range=24h&refresh=1')).body.zones.map((z) => z.name), ['bizcentar.com']);
  assert.equal((await c.admin.post('/api/dns/cloudflare/config', { zone_id: '' })).status, 200);
});

test('what Cloudflare answered to each figure can be seen by an administrator', async () => {
  for (const who of [c.viewer, c.operator]) assert.equal((await get('/raw', who)).status, 403);
  cf.state.mode = {}; await get(`/stats?zone=${Z1}&range=24h&refresh=1`);
  const raw = (await get(`/raw?zone=${Z1}`, c.admin)).body; assert.ok(raw.length >= 5); const names = raw.find((x) => x.part === 'names');
  assert.deepEqual([names.http, names.request.zone], [200, Z1]); assert.match(names.request.query, /queryName/); assert.match(names.response, /www\.comdata\.rs/); assert.ok(names.response.length <= 4000);
  assert.ok((await get('/raw', c.admin)).body.length >= raw.length, 'without a zone, all of them');
});
