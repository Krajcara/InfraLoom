'use strict';

// Which DNS servers the checks of a domain ask — shown with a tiny DNS server of our own that plays "the world outside":
// the domain has its MX, DKIM and DMARC records there, which is what a local copy of the zone may lack.

const test = require('node:test');
const assert = require('node:assert/strict');
const { startServer, clientsFor } = require('./_helpers');
const { startFakeDns } = require('./_fakeDns');

let dnsd; let srv; let c;
const zones = () => ({
  'bizcentar.com': { A: ['203.0.113.7'], NS: ['ns1.example-dns.net'], MX: [{ pref: 0, host: 'bizcentar-com.mail.protection.outlook.com' }], TXT: ['v=spf1 include:spf.protection.outlook.com ~all', 'MS=ms62706620'] },
  '_dmarc.bizcentar.com': { TXT: ['v=DMARC1; p=quarantine; rua=mailto:dmarc@comdata.rs'] },
  'selector1._domainkey.bizcentar.com': { TXT: ['v=DKIM1; k=rsa; p=MIIBIjANBgkq'] },
});
test.before(async () => {
  dnsd = await startFakeDns(zones());
  srv = await startServer({ DMARC_DNS_LOOKUP: 'true' });
  c = await clientsFor(srv);
});
test.after(() => { srv?.stop(); dnsd?.close(); });

const settings = () => c.viewer.get('/api/dns/check-settings');
const choose = (body, who = c.admin) => who.put('/api/dns/check-settings', body);

test('by default the checks ask public DNS servers', async () => {
  const r = await settings();
  assert.deepEqual([r.body.mode, r.body.servers, r.body.effective], ['public', '', ['1.1.1.1', '8.8.8.8']]);
});

test('the choice is for administrators, and the addresses are checked', async () => {
  assert.equal((await choose({ mode: 'custom', servers: dnsd.address }, c.operator)).status, 403);
  assert.equal((await choose({ mode: 'custom', servers: dnsd.address }, c.viewer)).status, 403);
  for (const [body, re] of [[{ mode: 'fast' }, /public, system or custom/], [{ mode: 'custom', servers: '' }, /at least one/], [{ mode: 'custom', servers: 'not-an-ip' }, /“not-an-ip” is not an IP address/],
    [{ mode: 'custom', servers: '1.1.1.1:99999' }, /is not an IP address/], [{ mode: 'custom', servers: '1.1.1.1, 1.0.0.1, 8.8.8.8, 8.8.4.4, 9.9.9.9' }, /At most four/]]) {
    const r = await choose(body); assert.equal(r.status, 400, JSON.stringify(body)); assert.match(r.body.error, re);
  }
  const ok = await choose({ mode: 'custom', servers: '9.9.9.9, 9.9.9.10:5353 [2606:4700:4700::1111]:53;2606:4700:4700::1001' });
  assert.deepEqual([ok.status, ok.body.mode, ok.body.effective.length], [200, 'custom', 4]);
  assert.ok(JSON.stringify((await c.admin.get('/api/audit-log?limit=50')).body).includes('dns.check_settings'));
  assert.equal((await choose({ mode: 'system' })).body.effective, 'system'); assert.equal((await settings()).body.servers, '', 'the list is dropped when it is not used');
});

test('the check of a domain asks the chosen server: MX, SPF, DKIM and DMARC as the outside world has them', async () => {
  assert.equal((await choose({ mode: 'custom', servers: dnsd.address })).status, 200);
  const r = await c.operator.post('/api/dns/check', { domain: 'BizCentar.com' });
  assert.equal(r.status, 200); const d = r.body;
  assert.equal(d.status, 'ok'); assert.equal(d.spf, 'v=spf1 include:spf.protection.outlook.com ~all');
  assert.deepEqual(d.mx, [{ priority: 0, exchange: 'bizcentar-com.mail.protection.outlook.com' }]);
  assert.equal(d.dmarc, 'v=DMARC1; p=quarantine; rua=mailto:dmarc@comdata.rs');
  assert.deepEqual([d.dkim.selector, d.dkim.value.startsWith('v=DKIM1')], ['selector1', true]); assert.deepEqual(d.a, ['203.0.113.7']); assert.deepEqual(d.ns, ['ns1.example-dns.net']);
  assert.ok(dnsd.log.includes('TXT _dmarc.bizcentar.com') && dnsd.log.includes('MX bizcentar.com'), `asked: ${dnsd.log.join(', ')}`);
  const gone = await c.operator.post('/api/dns/check', { domain: 'nothing-here.example' });
  assert.deepEqual([gone.body.status, gone.body.dmarc, gone.body.mx, gone.body.spf], ['ok', null, [], null], 'a name that is not there is simply empty');
});

test('a domain added by hand in the DMARC module is read from the same server', async () => {
  assert.equal((await c.admin.put('/api/dmarc/settings', { enabled: true, mailbox: 'dmarc@comdata.rs' })).status, 200);
  const add = await c.operator.post('/api/dmarc/domains', { name: 'bizcentar.com' });
  assert.equal(add.status, 201); assert.deepEqual([add.body.health, add.body.rua, add.body.p], ['protected', 'dmarc@comdata.rs', 'quarantine']);
  let row = (await c.viewer.get('/api/dmarc/summary')).body.domainTable.find((x) => x.name === 'bizcentar.com');
  assert.deepEqual([row.record.health, row.record.rua_missing, row.issue], ['protected', false, false]);
  dnsd.zones['_dmarc.bizcentar.com'] = { TXT: ['v=DMARC1; p=quarantine; rua=mailto:someone@else.example'] };
  assert.equal((await c.operator.post('/api/dmarc/domains/refresh')).status, 200);
  row = (await c.viewer.get('/api/dmarc/summary')).body.domainTable.find((x) => x.name === 'bizcentar.com');
  assert.deepEqual([row.record.rua_missing, row.issue], [true, true], 'the reports go elsewhere now, and the page says so');
  assert.match(JSON.stringify((await c.admin.get('/api/notifications')).body), /bizcentar\.com changed for the worse — its rua no longer includes dmarc@comdata\.rs/);
});
