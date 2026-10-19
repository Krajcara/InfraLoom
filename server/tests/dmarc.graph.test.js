'use strict';

// The whole path against a fake Microsoft Graph: sign-in, listing the mailbox page by page, attachments, throttling, and the
// errors a real tenant gives. The fake also writes down every request, to show that the module only ever reads.

const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const { startServer, clientsFor } = require('./_helpers');
const { reportXml, zipOf, gzipOf } = require('./_dmarcSamples');

const TENANT = '6f9e3d4c-e6e8-41a7-92a4-27a229ac2459';
const CLIENT = '6b84056d-2b1d-4880-8017-0132ee391d64';
const MAILBOX = 'dmarc@comdata.rs';
const SECRET = 'fake-secret-1';
const D = '/api/dmarc';

function fakeGraph() {
  const log = []; const filters = []; const state = { throttleOnce: true, throttled: 0 };
  const iso = (m) => new Date(Date.now() - m * 60_000).toISOString();
  const att = (id, name, buf, extra = {}) => ({ '@odata.type': '#microsoft.graph.fileAttachment', id, name, contentType: 'application/octet-stream', size: buf.length, ...extra, _buf: buf });
  const msgs = [
    { id: 'M1', subject: 'Report domain: comdata.rs Submitter: google.com', from: 'noreply-dmarc-support@google.com', received: iso(300), has: true },
    { id: 'M2', subject: 'Report domain: comdata.rs Submitter: Microsoft', from: 'dmarcreport@microsoft.com', received: iso(200), has: true },
    { id: 'M3', subject: 'Out of office', from: 'someone@gmail.com', received: iso(150), has: false },
    { id: 'M4', subject: 'A very large attachment', from: 'big@example.com', received: iso(100), has: true },
    { id: 'M5', subject: 'Not really a report', from: 'broken@example.com', received: iso(50), has: true },
  ];
  const files = {
    M1: [att('A1', 'google.com!comdata.rs!1!2.xml.gz', gzipOf(reportXml({ id: 'G1', records: [{ ip: '198.18.5.5', count: 31, dkim: 'fail', spf: 'fail', disposition: 'quarantine' }, { ip: '40.107.22.78', count: 120 }] })), { contentBytes: 'inline' })],
    M2: [att('A2', 'ms.zip', zipOf({ 'ms.xml': reportXml({ id: 'G2', org: 'Microsoft Corporation', records: [{ ip: '40.107.22.78', count: 77 }] }) }))], // no contentBytes: fetched from /$value
    M4: [att('A4', 'huge.zip', Buffer.alloc(10), { size: 11 * 1024 * 1024 })],
    M5: [att('A5', 'x.xml', Buffer.from('<html><body>nope</body></html>'), { contentBytes: 'inline' })],
  };
  const server = http.createServer((req, res) => {
    const url = new URL(req.url, 'http://x'); const path = url.pathname;
    log.push(`${req.method} ${path}`);
    const json = (code, body) => { res.writeHead(code, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(body)); };
    if (req.method === 'POST' && path === `/${TENANT}/oauth2/v2.0/token`) {
      let raw = ''; req.on('data', (d) => { raw += d; });
      return req.on('end', () => {
        const p = new URLSearchParams(raw);
        if (p.get('client_id') !== CLIENT || p.get('client_secret') !== state.secret || p.get('grant_type') !== 'client_credentials' || p.get('scope') !== 'https://graph.microsoft.com/.default') {
          return json(401, { error: 'invalid_client', error_description: 'AADSTS7000215: Invalid client secret provided. Ensure the secret being sent in the request is the client secret value.\r\nTrace ID: 1\r\nCorrelation ID: 2' });
        }
        return json(200, { access_token: 'tok-1', token_type: 'Bearer', expires_in: 3599 });
      });
    }
    if (req.headers.authorization !== 'Bearer tok-1') return json(401, { error: { code: 'InvalidAuthenticationToken', message: 'Access token is empty.' } });
    const m = /^\/users\/([^/]+)(\/.*)$/.exec(path);
    if (!m || decodeURIComponent(m[1]) !== MAILBOX) return json(403, { error: { code: 'ErrorAccessDenied', message: 'Access is denied. Check credentials and try again.' } });
    const rest = m[2];
    if (req.method !== 'GET') return json(405, { error: { code: 'MethodNotAllowed', message: 'read only' } });
    if (rest === '/mailFolders/inbox/messages') {
      if (url.searchParams.get('$top') === '1') return json(200, { value: [{ id: 'M5', subject: 'sample', receivedDateTime: msgs[4].received }] });
      if (state.throttleOnce && !url.searchParams.get('page')) { state.throttleOnce = false; state.throttled++; res.writeHead(429, { 'Retry-After': '1' }); return res.end(); }
      filters.push(url.searchParams.get('$filter'));
      const shape = (x) => ({ id: x.id, subject: x.subject, receivedDateTime: x.received, hasAttachments: x.has, from: { emailAddress: { address: x.from } } });
      const since = /ge (.+)$/.exec(url.searchParams.get('$filter'))[1];
      const all = msgs.filter((x) => x.received >= since).map(shape);
      if (!url.searchParams.get('page')) { const next = new URL(url); next.searchParams.set('page', '2'); return json(200, { value: all.slice(0, 2), '@odata.nextLink': next.toString().replace('http://x', `http://${req.headers.host}`) }); }
      return json(200, { value: all.slice(2) });
    }
    let mm = /^\/messages\/([^/]+)\/attachments$/.exec(rest);
    if (mm) return json(200, { value: (files[mm[1]] || []).map(({ _buf, ...a }) => ({ ...a, ...(a.contentBytes ? { contentBytes: _buf.toString('base64') } : {}) })) });
    mm = /^\/messages\/([^/]+)\/attachments\/([^/]+)\/\$value$/.exec(rest);
    if (mm) { const a = (files[mm[1]] || []).find((x) => x.id === mm[2]); res.writeHead(200, { 'Content-Type': 'application/octet-stream' }); return res.end(a._buf); }
    return json(404, { error: { code: 'NotFound', message: path } });
  });
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve({ url: `http://127.0.0.1:${server.address().port}`, log, filters, state, close: () => server.close() })));
}

let fake; let srv; let c;
test.before(async () => {
  fake = await fakeGraph(); fake.state.secret = SECRET;
  srv = await startServer({ DMARC_GRAPH_BASE_URL: fake.url, DMARC_LOGIN_BASE_URL: fake.url });
  c = await clientsFor(srv);
});
test.after(() => { srv?.stop(); fake?.close(); });

const configure = (over = {}) => c.admin.put(`${D}/settings`, { enabled: true, tenant_id: TENANT, client_id: CLIENT, client_secret: SECRET, mailbox: MAILBOX, ...over });

test('settings are checked against the real thing with "Test connection"', async () => {
  const bad = await configure({ client_secret: 'the-wrong-secret' }); assert.equal(bad.status, 200);
  const r1 = await c.admin.post(`${D}/test-graph`); assert.equal(r1.status, 502);
  assert.match(r1.body.error, /^Graph sign-in: 401 invalid_client AADSTS7000215: Invalid client secret provided\./); assert.ok(!r1.body.error.includes('Trace ID'), 'one line of the answer, not the whole of it');
  await configure({ mailbox: 'other@comdata.rs', client_secret: SECRET });
  const r2 = await c.admin.post(`${D}/test-graph`); assert.equal(r2.status, 502); assert.match(r2.body.error, /^Graph 403 ErrorAccessDenied: Access is denied/);
  await configure({ mailbox: MAILBOX });
  const ok = await c.admin.post(`${D}/test-graph`); assert.equal(ok.status, 200); assert.equal(ok.body.ok, true); assert.equal(ok.body.sample.subject, 'sample');
  assert.equal((await c.operator.post(`${D}/test-graph`)).status, 403);
});

test('reading the mailbox: pages, a throttled request, inline and downloaded attachments, one too big, one that is not a report', async () => {
  const r = await c.operator.post(`${D}/sync`);
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.deepEqual([r.body.messages, r.body.reports, r.body.records, r.body.errors], [5, 2, 3, 1]);
  assert.equal(fake.state.throttled, 1, 'the first listing was answered with 429 and read again');
  const msgs = Object.fromEntries((await c.viewer.get(`${D}/messages`)).body.map((m) => [m.subject, m]));
  assert.equal(msgs['Report domain: comdata.rs Submitter: google.com'].status, 'ok'); assert.equal(msgs['Report domain: comdata.rs Submitter: Microsoft'].status, 'ok');
  assert.equal(msgs['Out of office'].status, 'no-report'); assert.equal(msgs['A very large attachment'].status, 'no-report', 'an attachment over 10 MB is skipped, not downloaded');
  assert.equal(msgs['Not really a report'].status, 'error'); assert.match(msgs['Not really a report'].error, /not a DMARC aggregate report/);
  assert.equal(msgs['Out of office'].from_addr, 'someone@gmail.com');
  const s = (await c.viewer.get(`${D}/summary`)).body;
  assert.deepEqual([s.totals.total, s.totals.fail, s.totals.reports], [31 + 120 + 77, 31, 2]);
  assert.deepEqual([s.sync.enabled, s.sync.mailbox, s.sync.lastResult.reports, s.sync.lastError], [true, MAILBOX, 2, null]); assert.ok(s.sync.lastSync);
  assert.match(JSON.stringify((await c.admin.get('/api/notifications')).body), /31 messages from 198\.18\.5\.5/, 'the failure in yesterday\'s report is announced even in the first read');
  assert.ok(!/New sender/.test(JSON.stringify((await c.admin.get('/api/notifications')).body)), 'but the first read does not announce new senders');
});

test('a second read takes only what is new', async () => {
  const r = await c.operator.post(`${D}/sync`); assert.equal(r.status, 200); assert.deepEqual([r.body.messages, r.body.reports], [0, 0]);
  assert.equal(fake.filters.length >= 2, true);
  const [first, second] = fake.filters.filter((f, i, a) => i === 0 || f !== a[i - 1]).slice(0, 2);
  const t = (f) => new Date(/ge (.+)$/.exec(f)[1]).getTime();
  assert.ok(t(second) > t(first) + 20 * 86400_000, 'the second read starts from the newest message, not 30 days back');
});

test('the module only reads: one sign-in per hour, everything else is a GET on the one mailbox', async () => {
  const other = fake.log.filter((l) => !l.startsWith('GET '));
  assert.ok(other.length >= 1 && other.every((l) => l === `POST /${TENANT}/oauth2/v2.0/token`), `only token requests are not GETs: ${other.join(' | ')}`);
  const gets = fake.log.filter((l) => l.startsWith('GET '));
  assert.ok(gets.length > 5);
  const ofMailbox = gets.filter((l) => l.includes(`/users/${encodeURIComponent(MAILBOX)}/`));
  const strangers = gets.filter((l) => !l.includes(`/users/${encodeURIComponent(MAILBOX)}/`) && !l.includes('other%40comdata.rs'));
  assert.equal(strangers.length, 0, `nothing but the dmarc mailbox: ${strangers.join(' | ')}`); assert.ok(ofMailbox.length > 5);
  assert.ok(!gets.some((l) => /\/(move|copy|send|forward|reply)|\$ref/.test(l)));
});

test('when reading fails the page can say why', async () => {
  await configure({ client_secret: 'rotated-and-now-wrong' });
  const r = await c.operator.post(`${D}/sync`); assert.equal(r.status, 502); assert.match(r.body.error, /Graph sign-in: 401 invalid_client/);
  const s = (await c.viewer.get(`${D}/summary`)).body; assert.match(s.sync.lastError, /invalid_client/);
  await configure({ client_secret: SECRET });
  assert.equal((await c.operator.post(`${D}/sync`)).status, 200); assert.equal((await c.viewer.get(`${D}/summary`)).body.sync.lastError, null);
});
