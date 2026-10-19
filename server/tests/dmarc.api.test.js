'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { startServer, clientsFor } = require('./_helpers');
const { reportXml, zipOf, gzipOf, hour } = require('./_dmarcSamples');

let srv; let c;
test.before(async () => { srv = await startServer(); c = await clientsFor(srv); });
test.after(() => srv?.stop());

const D = '/api/dmarc';
const SECRET = 'Zq8~secret-value-that-must-never-come-back';
const upload = async (who, body, name = 'r.xml') => {
  const res = await fetch(`${srv.base}${D}/upload`, { method: 'POST', headers: { 'Content-Type': 'application/octet-stream', 'X-Filename': encodeURIComponent(name), Cookie: who.cookie ?? '' }, body });
  const text = await res.text(); let json = null; try { json = JSON.parse(text); } catch { /* not JSON */ }
  return { status: res.status, body: json ?? text };
};
const layout = async (client) => (await client.get('/api/dashboard/layout')).body.layout;

test('the module is off until an administrator switches it on', async () => {
  assert.deepEqual((await c.viewer.get(`${D}/status`)).body, { enabled: false });
  for (const path of ['/summary', '/reports', '/messages', '/dashboard']) assert.equal((await c.viewer.get(`${D}${path}`)).status, 404, path);
  assert.match((await c.viewer.get(`${D}/summary`)).body.error, /switched off/);
  assert.ok(!(await layout(c.admin)).some((w) => w.id === 'dmarc'), 'no dashboard card yet');
  assert.equal((await c.anon.get(`${D}/status`)).status, 401);
  assert.equal((await c.viewer.get(`${D}/settings`)).status, 403); assert.equal((await c.operator.get(`${D}/settings`)).status, 403);
  const s = (await c.admin.get(`${D}/settings`)).body;
  assert.equal(s.enabled, false); assert.equal(s.client_secret_set, false); assert.equal(s.graph_configured, false); assert.equal(s.poll_minutes, 60);
});

test('settings: only administrators, validated, and the secret never comes back', async () => {
  assert.equal((await c.operator.put(`${D}/settings`, { enabled: true })).status, 403);
  for (const [body, re] of [[{ tenant_id: 'x' }, /Tenant ID must be a GUID/], [{ mailbox: 'x' }, /e-mail address/], [{ poll_minutes: 1 }, /between 5 and 1440/], [{ secret_expires: 'soon' }, /must look like/]]) {
    const r = await c.admin.put(`${D}/settings`, body); assert.equal(r.status, 400, JSON.stringify(body)); assert.match(r.body.error, re);
  }
  const ok = await c.admin.put(`${D}/settings`, { enabled: true, tenant_id: '6f9e3d4c-e6e8-41a7-92a4-27a229ac2459', client_id: '6b84056d-2b1d-4880-8017-0132ee391d64', client_secret: SECRET, mailbox: 'dmarc@comdata.rs', secret_expires: '2028-10-18' });
  assert.equal(ok.status, 200); assert.equal(ok.body.client_secret_set, true); assert.equal(ok.body.graph_configured, true);
  assert.ok(!JSON.stringify(ok.body).includes(SECRET), 'not in the answer to the save');
  assert.ok(!JSON.stringify((await c.admin.get(`${D}/settings`)).body).includes(SECRET), 'not in a later read');
  const generic = JSON.stringify((await c.admin.get('/api/settings')).body);
  assert.ok(!generic.includes(SECRET) && !/dmarc/i.test(generic), 'the general settings API knows nothing about it');
  const audit = JSON.stringify((await c.admin.get('/api/audit-log?limit=100')).body);
  assert.ok(audit.includes('dmarc.settings.update') && audit.includes('client_secret') && !audit.includes(SECRET), 'the change is logged, the secret is not');
  assert.equal((await c.viewer.get(`${D}/status`)).body.enabled, true);
  assert.deepEqual((await layout(c.admin)).find((w) => w.id === 'dmarc'), { id: 'dmarc', visible: true, title: 'DMARC', phase: 16 }, 'the dashboard card is offered once the module is on');
  // keep Graph out of the way of the next tests: no secret, so only manual import works
  assert.equal((await c.admin.put(`${D}/settings`, { clear_client_secret: true })).body.client_secret_set, false);
});

test('importing reports by hand: operators only; XML, GZ and ZIP; duplicates; and things that are not reports', async () => {
  const xml = reportXml({ id: 'u1', records: [{ ip: '40.107.22.78', count: 200 }, { ip: '185.220.101.34', count: 47, dkim: 'fail', spf: 'fail', disposition: 'quarantine' }] });
  assert.equal((await upload(c.anon, xml)).status, 401);
  assert.equal((await upload(c.viewer, xml)).status, 403);
  const r = await upload(c.operator, xml, 'google.com!comdata.rs!1!2.xml');
  assert.equal(r.status, 200); assert.deepEqual([r.body.file, r.body.reports, r.body.duplicates, r.body.records], ['google.com!comdata.rs!1!2.xml', 1, 0, 2]); assert.equal(r.body.alerts, 1, 'the failure from an unapproved sender');
  const again = await upload(c.operator, xml); assert.deepEqual([again.body.reports, again.body.duplicates, again.body.alerts], [0, 1, 0]);
  const gz = await upload(c.operator, gzipOf(reportXml({ id: 'u2', org: 'Yahoo', records: [{ ip: '98.136.1.1', count: 12 }] })), 'yahoo.xml.gz'); assert.equal(gz.body.reports, 1);
  const zip = await upload(c.admin, zipOf({ 'a.xml': reportXml({ id: 'u3', org: 'Microsoft Corporation', records: [{ ip: '40.107.22.78', count: 9 }] }), 'b.xml': reportXml({ id: 'u4', org: 'Microsoft Corporation', domain: 'bizcentar.com', records: [{ ip: '40.107.22.78', count: 4 }] }) }), 'ms.zip');
  assert.equal(zip.body.reports, 2);
  const old = await upload(c.operator, reportXml({ id: 'u5', org: 'Zoho Corporation', end: hour(24 * 20), records: [{ ip: '136.143.188.12', count: 30 }] })); assert.equal(old.body.reports, 1);
  for (const [body, re] of [[Buffer.from('<html><body>not a report</body></html>'), /not a DMARC aggregate report/], [Buffer.from('hello'), /No DMARC report was found/], [zipOf({ 'notes.txt': 'hi' }), /No DMARC report was found/]]) {
    const bad = await upload(c.operator, body, 'x.xml'); assert.equal(bad.status, 400, String(body)); assert.match(bad.body.error, re);
  }
  const empty = await upload(c.operator, Buffer.alloc(0)); assert.equal(empty.status, 400); assert.match(empty.body.error, /empty/);
  const entity = await upload(c.operator, '<!DOCTYPE x [<!ENTITY a "b">]><feedback/>'); assert.equal(entity.status, 400); assert.match(entity.body.error, /entities/);
  const notice = JSON.stringify((await c.admin.get('/api/notifications')).body);
  assert.match(notice, /DMARC failures from an unapproved sender — comdata\.rs/); assert.match(notice, /47 messages from 185\.220\.101\.34/);
  assert.ok(JSON.stringify((await c.admin.get('/api/audit-log?limit=100')).body).includes('dmarc.upload'));
});

test('the screens: summary, reports, one report, the original XML', async () => {
  const s = (await c.viewer.get(`${D}/summary?days=30`)).body;
  assert.deepEqual(s.totals, { total: 200 + 47 + 12 + 9 + 4 + 30, pass: 200 + 12 + 9 + 4 + 30, fail: 47, spf_permerror: 0, reports: 5, reporters: 4 });
  const week = (await c.viewer.get(`${D}/summary?days=7`)).body; assert.equal(week.totals.reports, 4, 'the report from 20 days ago is outside a week');
  assert.deepEqual((await c.viewer.get(`${D}/summary?days=30&domain=bizcentar.com`)).body.totals, { total: 4, pass: 4, fail: 0, spf_permerror: 0, reports: 1, reporters: 1 });
  assert.deepEqual(s.domains.sort(), ['bizcentar.com', 'comdata.rs']); assert.equal(s.latestPolicy.policy_p, 'quarantine');
  assert.deepEqual([s.sync.enabled, s.sync.mailbox, s.sync.running, s.sync.pollMinutes], [false, null, false, 60]);
  const bad = s.groups.find((g) => g.name === '185.220.101.0/24'); assert.deepEqual([bad.total, bad.fail, bad.approved, bad.ips], [47, 47, 0, 1]);
  assert.equal(s.sources[0].ip, '185.220.101.34', 'failing sources first'); assert.ok(s.sources[0].reporters.includes('google.com'));
  assert.equal((await c.viewer.get(`${D}/summary?days=99999`)).body.days, 730, 'the period is capped');
  const list = (await c.viewer.get(`${D}/reports?days=30`)).body; assert.equal(list.length, 5); assert.equal(list[0].org_name !== undefined, true);
  assert.equal((await c.viewer.get(`${D}/reports?days=30&domain=bizcentar.com`)).body.length, 1);
  const first = (await c.viewer.get(`${D}/reports/${list.find((r) => r.report_id === 'u1').id}`)).body;
  assert.deepEqual(first.records.map((r) => [r.source_ip, r.dmarc_pass]), [['185.220.101.34', 0], ['40.107.22.78', 1]]); assert.ok(first.raw_xml.includes('<report_id>u1</report_id>'));
  const x = await fetch(`${srv.base}${D}/reports/${first.id}/xml`, { headers: { Cookie: c.viewer.cookie } });
  assert.equal(x.status, 200); assert.match(x.headers.get('content-type'), /xml/); assert.match(await x.text(), /<report_id>u1<\/report_id>/);
  assert.equal((await c.viewer.get(`${D}/reports/99999`)).status, 404); assert.equal((await c.viewer.get(`${D}/reports/99999/xml`)).status, 404);
  assert.deepEqual((await c.viewer.get(`${D}/messages`)).body, [], 'nothing came by mail');
});

test('approving a sender: operators, by group or by address, with the name in the body (group names contain "/")', async () => {
  const g = (b, who = c.operator) => who.patch(`${D}/groups`, b);
  assert.equal((await g({ name: '185.220.101.0/24', approved: true }, c.viewer)).status, 403);
  const ok = await g({ name: '185.220.101.0/24', approved: true, note: 'Our old mail relay' });
  assert.equal(ok.status, 200); assert.deepEqual([ok.body.name, ok.body.approved, ok.body.note], ['185.220.101.0/24', 1, 'Our old mail relay']);
  const s = (await c.viewer.get(`${D}/summary`)).body; assert.equal(s.groups.find((x) => x.name === '185.220.101.0/24').approved, 1); assert.equal(s.sources.find((x) => x.ip === '185.220.101.34').approved, 1);
  assert.equal((await g({ name: '185.220.101.0/24', approved: false })).body.approved, 0, 'and back');
  assert.equal((await g({ name: 'no-such-group', approved: true })).status, 404); assert.equal((await g({ approved: true })).status, 400); assert.equal((await g({ name: '185.220.101.0/24', approved: 'yes' })).status, 400);
  assert.equal((await g({ name: '185.220.101.0/24', note: 'x'.repeat(201) })).status, 400);
  const src = await c.operator.patch(`${D}/sources`, { ip: '98.136.1.1', approved: true, note: 'Yahoo test' }); assert.deepEqual([src.status, src.body.approved, src.body.note], [200, 1, 'Yahoo test']);
  assert.equal((await c.operator.patch(`${D}/sources`, { ip: '1.1.1.1', approved: true })).status, 404); assert.equal((await c.viewer.patch(`${D}/sources`, { ip: '98.136.1.1', approved: false })).status, 403);
  const audit = JSON.stringify((await c.admin.get('/api/audit-log?limit=100')).body); assert.ok(audit.includes('dmarc.group.update') && audit.includes('dmarc.source.update'));
});

test('the dashboard card numbers', async () => {
  const d = (await c.viewer.get(`${D}/dashboard`)).body;
  assert.deepEqual([d.total, d.pass, d.fail, d.reports], [302, 255, 47, 5], 'the last 30 days');
  assert.ok(d.unapproved >= 1 && d.unapproved_failing >= 1); assert.equal(d.sync_enabled, false); assert.equal(d.last_error, null);
});

test('without Microsoft Graph, reading the mailbox is refused with the reason', async () => {
  const r = await c.operator.post(`${D}/sync`); assert.equal(r.status, 502); assert.match(r.body.error, /not set up/);
  assert.equal((await c.viewer.post(`${D}/sync`)).status, 403);
  const t = await c.admin.post(`${D}/test-graph`); assert.equal(t.status, 400); assert.match(t.body.error, /not set up/); assert.equal((await c.operator.post(`${D}/test-graph`)).status, 403);
});

test('switched off again: the data is kept, the screens and the card are gone', async () => {
  assert.equal((await c.admin.put(`${D}/settings`, { enabled: false })).body.enabled, false);
  assert.equal((await c.viewer.get(`${D}/summary`)).status, 404); assert.equal((await c.operator.post(`${D}/sync`)).status, 404);
  assert.ok(!(await layout(c.admin)).some((w) => w.id === 'dmarc'));
  assert.equal((await c.admin.put(`${D}/settings`, { enabled: true })).body.enabled, true);
  assert.equal((await c.viewer.get(`${D}/summary`)).body.totals.reports, 5, 'nothing was lost');
});
