'use strict';

// The DMARC module's parts that need a database: settings, the ingest and alert rules, the clean-up, reading a mailbox through
// a fake Graph client, and the reminders. A throw-away encrypted database; nothing here touches the real data directory.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dmarc-svc-'));
const hex = () => crypto.randomBytes(32).toString('hex');
Object.assign(process.env, { NODE_ENV: 'test', DB_PATH: path.join(dir, 'infraloom.db'), DB_ENCRYPTION_KEY: hex(), APP_SECRET: hex(), BACKUP_ENCRYPTION_PASSWORD: hex(), DMARC_PTR_LOOKUP: 'false' });

const db = require('../src/db/database');
const config = require('../src/services/dmarc/config');
const { createStore } = require('../src/services/dmarc/store');
const { createIngestor, FAIL_STREAK_ALERT, MAX_ALERTS_PER_RUN } = require('../src/services/dmarc/ingest');
const service = require('../src/services/dmarc/service');
const { reportXml, gzipOf, zipOf, hour } = require('./_dmarcSamples');

test.after(() => { fs.rmSync(dir, { recursive: true, force: true }); });

const quietLogger = { info() {}, warn() {}, error() {} };
const PTR = { '40.107.22.78': 'mail-x.outbound.protection.outlook.com', '205.201.131.12': 'mail131-12.atl91.mcsv.net' };
const mkIngestor = (over = {}) => {
  const sent = [];
  const store = createStore(db);
  const cfg = { trustedGroups: ['microsoft 365'], alertOnNewSources: true, alertOnOverrides: false, storeRawXml: true, initialLookbackDays: 30, ...over.config };
  const ingestor = createIngestor({ store, graph: over.graph ?? null, config: cfg, notify: async (event, message) => { sent.push({ event, message }); }, logger: quietLogger, reverse: async (ip) => PTR[ip] ?? null });
  return { store, ingestor, sent };
};
const upload = async (ing, xml, opts = {}) => { const r = await ing.ingestor.ingestBuffer(Buffer.from(xml), 'r.xml', { origin: 'upload' }, opts); await ing.ingestor.dispatch(r.alerts); return r; };

test('the tables are made by a numbered migration', () => {
  assert.deepEqual(db.prepare('SELECT version FROM dmarc_migrations').all().map((r) => r.version), ['001_dmarc']);
  const names = db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name LIKE 'dmarc_%'").all().map((r) => r.name);
  for (const t of ['dmarc_config', 'dmarc_reports', 'dmarc_records', 'dmarc_sources', 'dmarc_groups', 'dmarc_messages', 'dmarc_state', 'dmarc_migrations']) assert.ok(names.includes(t), t);
});

test('settings: defaults, validation, and a secret that is never given back', () => {
  const d = config.publicConfig();
  assert.equal(d.enabled, false); assert.equal(d.client_secret_set, false); assert.equal(d.graph_configured, false);
  assert.deepEqual([d.poll_minutes, d.retention_days, d.raw_xml_days, d.trusted_groups], [60, 400, 90, 'Microsoft 365']);
  const bad = [
    [{ tenant_id: 'nope' }, /Tenant ID must be a GUID/], [{ client_id: '123' }, /Client ID must be a GUID/], [{ mailbox: 'not-an-address' }, /Mailbox must be an e-mail/],
    [{ secret_expires: '18.10.2028' }, /must look like 2028-10-18/], [{ secret_expires: '2028-13-45' }, /must look like/], [{ poll_minutes: 2 }, /between 5 and 1440/], [{ poll_minutes: 'x' }, /whole number/],
    [{ retention_days: 5 }, /between 30 and 3650/], [{ raw_xml_days: -1 }, /between 0 and 3650/], [{ initial_lookback_days: 0 }, /between 1 and 365/], [{ client_secret: 'x'.repeat(501) }, /too long/], [{ trusted_groups: 'x'.repeat(501) }, /too long/],
  ];
  for (const [body, re] of bad) assert.throws(() => config.update(body), re, JSON.stringify(body).slice(0, 50));
  assert.deepEqual(db.prepare('SELECT * FROM dmarc_config').all(), [], 'a refused change writes nothing');

  const keys = config.update({ enabled: true, tenant_id: '6F9E3D4C-E6E8-41A7-92A4-27A229AC2459', client_id: '6b84056d-2b1d-4880-8017-0132ee391d64', client_secret: 'S3cret-value', mailbox: 'DMARC@comdata.rs', secret_expires: '2028-10-18', poll_minutes: '30', trusted_groups: ' Microsoft 365, Google ' });
  assert.ok(keys.includes('client_secret') && keys.includes('mailbox'));
  const pub = config.publicConfig();
  assert.equal(pub.client_secret_set, true); assert.equal(pub.graph_configured, true); assert.equal(pub.mailbox, 'dmarc@comdata.rs'); assert.equal(pub.poll_minutes, 30);
  assert.ok(!JSON.stringify(pub).includes('S3cret'), 'the public view has no secret');
  assert.equal(config.get().clientSecret, 'S3cret-value'); assert.deepEqual(config.get().trustedGroups, ['microsoft 365', 'google']);
  config.update({ client_secret: '' }); assert.equal(config.get().clientSecret, 'S3cret-value', 'an empty secret leaves the stored one alone');
  config.update({ mailbox: 'x@comdata.rs' }); assert.equal(config.get().clientSecret, 'S3cret-value', 'so does a change of something else');
  config.update({ clear_client_secret: true }); assert.equal(config.publicConfig().client_secret_set, false);
  assert.equal(db.prepare("SELECT COUNT(*) c FROM settings WHERE key LIKE 'dmarc%'").get().c, 0, 'nothing is written to the general settings table');
  db.prepare('DELETE FROM dmarc_config').run();
});

test('a failure from an unapproved sender raises an alert; a trusted provider and a duplicate do not', async () => {
  const ing = mkIngestor();
  const xml = reportXml({ id: 'a1', records: [
    { ip: '40.107.22.78', count: 200 },                                                       // Microsoft 365: trusted
    { ip: '185.220.101.34', count: 47, dkim: 'fail', spf: 'fail', disposition: 'quarantine' }, // unknown, failing
    { ip: '205.201.131.12', count: 30 },                                                      // Mailchimp: new, passing
  ] });
  const r = await upload(ing, xml);
  assert.deepEqual([r.reports, r.duplicates, r.records], [1, 0, 3]);
  assert.deepEqual(ing.sent.map((s) => s.event).sort(), ['dmarc_fail', 'dmarc_new_sender']);
  const fail = ing.sent.find((s) => s.event === 'dmarc_fail').message;
  assert.match(fail, /^DMARC: DMARC failures from an unapproved sender — comdata\.rs\. 47 messages from 185\.220\.101\.34, header_from=comdata\.rs, DKIM=fail, SPF=fail, disposition=quarantine\. Reported by google\.com\.$/);
  assert.match(ing.sent.find((s) => s.event === 'dmarc_new_sender').message, /New sender in the name of comdata\.rs: Mailchimp\. First seen 205\.201\.131\.12 \(mail131-12\.atl91\.mcsv\.net\), 30 messages, DMARC pass/);
  assert.equal(ing.store.getGroup('Microsoft 365').approved, 1, 'trusted groups are approved the first time they are seen');
  assert.equal(ing.store.getGroup('185.220.101.0/24').approved, 0);
  const again = await upload(ing, xml); assert.deepEqual([again.reports, again.duplicates], [0, 1]); assert.equal(ing.sent.length, 2, 'the same report is never stored or alerted twice');
});

test('a source that keeps failing is announced once a day, not with every report', async () => {
  const ing = mkIngestor();
  const rep = (id) => reportXml({ id, records: [{ ip: '198.18.0.7', count: 9, dkim: 'fail', spf: 'fail' }] });
  await upload(ing, rep('t1')); assert.equal(ing.sent.filter((s) => s.event === 'dmarc_fail').length, 1);
  await upload(ing, rep('t2')); await upload(ing, rep('t3')); assert.equal(ing.sent.filter((s) => s.event === 'dmarc_fail').length, 1, 'throttled');
  ing.store.setState('alert:fail:198.18.0.7', Date.now() - 25 * 3600_000);
  await upload(ing, rep('t4')); assert.equal(ing.sent.filter((s) => s.event === 'dmarc_fail').length, 2, 'a day later it is announced again');
});

test('approving the group silences it; history, backfill and uploads do not alert', async () => {
  const ing = mkIngestor();
  ing.store.ensureGroup('198.51.100.0/24', 1, false); ing.store.upsertSource('198.51.100.7', null, '198.51.100.0/24', 1);
  ing.store.updateGroup('198.51.100.0/24', { approved: true });
  await upload(ing, reportXml({ id: 'ok1', records: [{ ip: '198.51.100.7', dkim: 'fail', spf: 'fail' }] }));
  assert.deepEqual(ing.sent, [], 'an approved sender raises nothing, even when it fails');
  const old = hour(24 * 10);
  await upload(ing, reportXml({ id: 'old1', end: old, records: [{ ip: '203.0.113.9', dkim: 'fail', spf: 'fail' }] }));
  assert.deepEqual(ing.sent, [], 'a failure in a report from ten days ago is history');
  const q = await ing.ingestor.ingestBuffer(Buffer.from(reportXml({ id: 'q1', records: [{ ip: '205.201.131.12' }] })), 'q.xml', { origin: 'graph' }, { quiet: true });
  assert.equal(q.alerts.length, 0, 'a quiet run (backfill, upload) does not announce new senders');
  const n = await ing.ingestor.ingestBuffer(Buffer.from(reportXml({ id: 'q2', records: [{ ip: '192.0.2.50' }] })), 'q.xml', { origin: 'graph' }, {});
  assert.deepEqual(n.alerts.map((a) => a.event), ['dmarc_new_sender']);
});

test('forwarding and mailing lists are only counted, unless asked for; SPF permerror once a day; no more than ten alerts a run', async () => {
  const fwd = (id) => reportXml({ id, records: [{ ip: '209.85.208.46', count: 5, dkim: 'fail', spf: 'fail', reasons: [{ type: 'local_policy', comment: 'arc=pass' }] }] });
  const a = mkIngestor(); await upload(a, fwd('f1')); assert.deepEqual(a.sent.filter((s) => s.event !== 'dmarc_new_sender'), []);
  const b = mkIngestor({ config: { alertOnOverrides: true } }); await upload(b, fwd('f2')); assert.deepEqual(b.sent.filter((s) => s.event === 'dmarc_override').length, 1);
  const c = mkIngestor();
  const pe = (id) => reportXml({ id, records: [{ ip: '40.107.22.78', spf: 'fail', spfAuth: [{ domain: 'comdata.rs', result: 'permerror' }] }] });
  await upload(c, pe('p1')); await upload(c, pe('p2'));
  const perm = c.sent.filter((s) => s.event === 'dmarc_spf_permerror'); assert.equal(perm.length, 1); assert.match(perm[0].message, /dig \+short TXT comdata\.rs/);
  const d = mkIngestor();
  await upload(d, reportXml({ id: 'many', records: Array.from({ length: 13 }, (_, i) => ({ ip: `203.0.113.${i + 1}`.replace(/^/, ''), dkim: 'fail', spf: 'fail' })).map((r, i) => ({ ...r, ip: `10.${i}.0.1` })) }));
  const fails = d.sent.filter((s) => s.event === 'dmarc_fail');
  assert.equal(fails.length, MAX_ALERTS_PER_RUN + 1, `${MAX_ALERTS_PER_RUN} one by one, and one more that says how many were left`);
  assert.match(fails[fails.length - 1].message, /3 more alerts were not sent one by one/);
});

test('the numbers for the screens and the dashboard card', async () => {
  const ing = mkIngestor();
  await upload(ing, reportXml({ id: 's1', domain: 'bizcentar.com', records: [{ ip: '172.16.5.5', count: 7, dkim: 'fail', spf: 'fail' }, { ip: '172.16.5.6', count: 3 }] }));
  const since = Math.floor(Date.now() / 1000) - 30 * 86400;
  const s = ing.store.summary(since);
  assert.ok(s.totals.total >= 10 && s.totals.fail >= 7); assert.ok(s.domains.includes('bizcentar.com'));
  assert.deepEqual(ing.store.summary(since, 'bizcentar.com').totals, { total: 10, pass: 3, fail: 7, spf_permerror: 0, reports: 1, reporters: 1 });
  assert.equal(ing.store.summary(since, 'bizcentar.com').latestPolicy.policy_p, 'quarantine');
  const dash = ing.store.dashboard(since); assert.ok(dash.total >= 10); assert.ok(dash.unapproved >= 1 && dash.unapproved_failing >= 1);
  assert.equal(ing.store.listReports({ sinceTs: since, domain: 'bizcentar.com' }).length, 1);
  const rep = ing.store.getReport(ing.store.listReports({ sinceTs: since, domain: 'bizcentar.com' })[0].id);
  assert.deepEqual(rep.records.map((r) => [r.source_ip, r.dmarc_pass]), [['172.16.5.5', 0], ['172.16.5.6', 1]], 'failures first'); assert.ok(rep.raw_xml.includes('bizcentar.com'));
});

test('clean-up: old reports go, the original XML goes sooner, and so do the processed-mail records', () => {
  const store = createStore(db); const now = Math.floor(Date.now() / 1000);
  const ins = (rid, endDaysAgo) => store.saveReport({ orgName: 'purge.example', reportId: rid, orgEmail: null, dateBegin: now - (endDaysAgo + 1) * 86400, dateEnd: now - endDaysAgo * 86400, policy: { domain: 'purge.example', p: 'none' }, records: [{ sourceIp: '192.0.2.1', count: 1, dmarcPass: true, dkim: [], spf: [], reasons: [] }] }, { origin: 'upload', rawXml: '<x/>', storeRaw: true });
  ins('keep', 10); ins('raw', 120); ins('gone', 500);
  db.prepare("INSERT INTO dmarc_messages (graph_id, status, processed_at) VALUES ('old-m', 'ok', ?), ('new-m', 'ok', ?)").run(now - 500 * 86400, now);
  const r = store.purge(400, 90);
  assert.equal(r.reportsDeleted >= 1, true); assert.equal(r.rawCleared >= 1, true); assert.equal(r.messagesDeleted, 1);
  const get = (rid) => db.prepare("SELECT raw_xml FROM dmarc_reports WHERE org_name = 'purge.example' AND report_id = ?").get(rid);
  assert.equal(get('gone'), undefined); assert.equal(get('raw').raw_xml, null); assert.equal(get('keep').raw_xml, '<x/>');
  assert.equal(db.prepare("SELECT COUNT(*) c FROM dmarc_records WHERE report_id NOT IN (SELECT id FROM dmarc_reports)").get().c, 0, 'the records of a deleted report go with it');
  assert.equal(store.purge(400, 0).rawCleared, 0, '0 days = keep the original XML as long as the report');
});

const fakeGraph = (script) => {
  const calls = [];
  return { calls, mailbox: 'dmarc@comdata.rs', listMessagesSince: async (iso) => { calls.push(iso); return script.list(calls.length); }, getAttachments: async (id) => script.files(id) };
};
const msg = (id, extra = {}) => ({ id, receivedDateTime: `2026-10-18T0${id.length}:00:00Z`, subject: `Report ${id}`, from: { emailAddress: { address: 'noreply@google.com' } }, hasAttachments: true, ...extra });

test('reading the mailbox: reports, mail that is not a report, mail that is broken — and nothing twice', async () => {
  const good = reportXml({ id: 'g1', records: [{ ip: '198.19.0.9', count: 5, dkim: 'fail', spf: 'fail' }, { ip: '205.201.131.12', count: 3 }] });
  const messages = [msg('m1'), msg('m22', { hasAttachments: false }), msg('m333'), msg('m4444'), msg('m55555')];
  const files = { m1: [{ name: 'g.xml.gz', buffer: gzipOf(good) }], m333: [{ name: 'bad.xml', buffer: Buffer.from('<html><body>not a report</body></html>') }], m4444: [{ name: 'photo.png', buffer: Buffer.from([0x89, 0x50, 0x4e, 0x47]) }], m55555: [{ name: 'z.zip', buffer: zipOf({ 'a.xml': reportXml({ id: 'g2', records: [{ ip: '40.107.22.78' }] }) }) }] };
  const graph = fakeGraph({ list: () => messages, files: (id) => files[id] ?? [] });
  const ing = mkIngestor({ graph });
  const first = await ing.ingestor.syncMailbox();
  assert.deepEqual([first.messages, first.reports, first.records, first.errors], [5, 2, 3, 1]);
  const status = Object.fromEntries(db.prepare('SELECT graph_id, status, error FROM dmarc_messages').all().map((r) => [r.graph_id, r]));
  assert.equal(status.m1.status, 'ok'); assert.equal(status.m22.status, 'no-report'); assert.equal(status.m4444.status, 'no-report'); assert.equal(status.m55555.status, 'ok');
  assert.equal(status.m333.status, 'error'); assert.match(status.m333.error, /not a DMARC aggregate report/);
  assert.deepEqual(ing.sent.map((s) => s.event), ['dmarc_fail'], 'the first read is a backfill: a failure from yesterday is announced, a new sender is not');
  assert.equal(ing.store.getState('graph_cursor'), '2026-10-18T06:00:00Z'); assert.equal(ing.store.getState('last_sync_error'), ''); assert.equal(JSON.parse(ing.store.getState('last_sync_result')).reports, 2);
  const iso0 = new Date(graph.calls[0]).getTime(); assert.ok(Math.abs(iso0 - (Date.now() - 30 * 86400_000)) < 60_000, 'the first read goes back initialLookbackDays');
  const second = await ing.ingestor.syncMailbox();
  assert.deepEqual([second.messages, second.reports], [0, 0], 'messages already processed are skipped');
  assert.ok(Math.abs(new Date(graph.calls[1]).getTime() - (new Date('2026-10-18T06:00:00Z').getTime() - 2 * 3600_000)) < 1000, 'the next read starts from the newest message, minus two hours');
});

test('a mailbox that cannot be read: one alert on the third failure in a row, and a read that works starts the count again', async () => {
  let broken = true;
  const graph = fakeGraph({ list: () => { if (broken) throw new Error('Graph 403 ErrorAccessDenied: Access is denied'); return []; }, files: () => [] });
  const ing = mkIngestor({ graph });
  for (let i = 1; i < FAIL_STREAK_ALERT; i++) { await assert.rejects(ing.ingestor.syncMailbox(), /ErrorAccessDenied/); assert.equal(ing.sent.length, 0, `failure ${i}: no alert yet`); }
  await assert.rejects(ing.ingestor.syncMailbox(), /ErrorAccessDenied/);
  assert.equal(ing.sent.length, 1); assert.equal(ing.sent[0].event, 'dmarc_sync_failed'); assert.match(ing.sent[0].message, /dmarc@comdata\.rs has failed 3 times in a row \(Graph 403 ErrorAccessDenied/);
  await assert.rejects(ing.ingestor.syncMailbox(), /ErrorAccessDenied/); assert.equal(ing.sent.length, 1, 'not repeated while it stays broken');
  assert.match(ing.store.getState('last_sync_error'), /ErrorAccessDenied/);
  broken = false; await ing.ingestor.syncMailbox(); assert.equal(ing.store.getState('sync_fail_streak'), '0'); assert.equal(ing.store.getState('last_sync_error'), '');
  broken = true; for (let i = 0; i < 3; i++) await assert.rejects(ing.ingestor.syncMailbox());
  assert.equal(ing.sent.length, 2, 'a new streak, a new alert');
  const noGraph = mkIngestor(); await assert.rejects(noGraph.ingestor.syncMailbox(), /not set up/);
});

test('two reads at once: the second one waits its turn', async () => {
  let release; const gate = new Promise((r) => { release = r; });
  const graph = fakeGraph({ list: async () => { await gate; return []; }, files: () => [] });
  const ing = mkIngestor({ graph });
  const a = ing.ingestor.syncMailbox(); await new Promise((r) => setTimeout(r, 20));
  assert.equal(ing.ingestor.isRunning(), true); assert.deepEqual(await ing.ingestor.syncMailbox(), { skipped: true, reason: 'a read is already running' });
  release(); await a; assert.equal(ing.ingestor.isRunning(), false);
});

test('the client-secret reminder: 30 days, 7 days and expired, each once', async () => {
  const day = 86400_000; const now = Date.parse('2026-10-19T10:00:00Z');
  const exp = '2026-11-18'; // valid through the end of that day
  const sent = () => db.prepare("SELECT message FROM app_notifications WHERE event_type = 'dmarc_secret_expiring' ORDER BY id").all().map((r) => r.message);
  assert.equal(await service.checkSecretExpiry({ secretExpires: '' }, now), null); assert.equal(await service.checkSecretExpiry({ secretExpires: '2028-10-18' }, now), null, 'nothing to say two years ahead');
  assert.equal(await service.checkSecretExpiry({ secretExpires: exp }, now), null, '31 days left: too early');
  assert.deepEqual(await service.checkSecretExpiry({ secretExpires: exp }, now + day), { days: 30, step: 30 });
  assert.equal(await service.checkSecretExpiry({ secretExpires: exp }, now + 2 * day), null, 'once');
  assert.deepEqual(await service.checkSecretExpiry({ secretExpires: exp }, Date.parse('2026-11-12T10:00:00Z')), { days: 7, step: 7 });
  assert.equal(await service.checkSecretExpiry({ secretExpires: exp }, Date.parse('2026-11-13T10:00:00Z')), null);
  assert.deepEqual(await service.checkSecretExpiry({ secretExpires: exp }, Date.parse('2026-11-20T10:00:00Z')), { days: -1, step: 0 });
  assert.equal(sent().length, 3); assert.match(sent()[0], /expires in 30 days \(2026-11-18\)/); assert.match(sent()[1], /expires in 7 days/); assert.match(sent()[2], /expired 1 day ago/);
  assert.match(sent()[0], /Settings → DMARC/);
  assert.deepEqual(await service.checkSecretExpiry({ secretExpires: '2026-11-25' }, Date.parse('2026-11-20T10:00:00Z')), { days: 6, step: 7 }, 'a new secret has its own reminders');
});

test('how often the mailbox is read becomes a cron expression', () => {
  for (const [m, e] of [[5, '*/5 * * * *'], [30, '*/30 * * * *'], [59, '*/59 * * * *'], [60, '0 */1 * * *'], [90, '0 */2 * * *'], [720, '0 */12 * * *'], [1440, '0 0 * * *']]) assert.equal(service.syncExpression(m), e, String(m));
});
