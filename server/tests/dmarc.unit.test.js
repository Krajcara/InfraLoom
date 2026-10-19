'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const zlib = require('node:zlib');
process.env.DMARC_PTR_LOOKUP = 'false';
const { extractXmlDocuments, parseDmarcXml, parseAttachment, MAX_XML_BYTES, MAX_ENTRIES } = require('../src/services/dmarc/parser');
const { classifyProvider, sourceGroup, reverseLookup } = require('../src/services/dmarc/sources');
const { reportXml, zipOf, gzipOf } = require('./_dmarcSamples');

const sample = () => reportXml({ id: 'abc-1', records: [
  { ip: '40.107.22.78', count: 212, spf: 'fail', spfAuth: [{ domain: 'comdata.rs', result: 'permerror' }] },
  { ip: '185.220.101.34', count: 47, disposition: 'quarantine', dkim: 'fail', spf: 'fail', dkimAuth: [], spfAuth: [{ domain: 'mail-relay.example', result: 'fail' }], envelopeFrom: 'bounce@mail-relay.example' },
  { ip: '209.85.208.46', count: 5, dkim: 'fail', spf: 'fail', reasons: [{ type: 'local_policy', comment: 'arc=pass' }] },
] });

test('a report is parsed into plain values: strings stay strings, DMARC passes when an aligned mechanism passes', () => {
  const r = parseDmarcXml(sample());
  assert.equal(r.orgName, 'google.com'); assert.equal(r.reportId, 'abc-1'); assert.equal(r.policy.domain, 'comdata.rs');
  assert.deepEqual([r.policy.p, r.policy.sp, r.policy.pct, r.policy.adkim, r.policy.aspf], ['quarantine', 'quarantine', 100, 'r', 'r']);
  assert.ok(r.dateEnd > r.dateBegin);
  assert.equal(r.records.length, 3);
  const [a, b, c] = r.records;
  assert.equal(a.sourceIp, '40.107.22.78'); assert.equal(typeof a.sourceIp, 'string'); assert.equal(a.count, 212);
  assert.equal(a.dmarcPass, true, 'DKIM passed'); assert.equal(a.spfEval, 'fail'); assert.equal(a.spfPermerror, true); assert.equal(a.dkim[0].selector, 'selector1');
  assert.equal(b.dmarcPass, false); assert.equal(b.disposition, 'quarantine'); assert.deepEqual(b.dkim, []); assert.equal(b.envelopeFrom, 'bounce@mail-relay.example'); assert.equal(b.spfPermerror, false);
  assert.equal(c.override, 'local_policy'); assert.deepEqual(c.reasons, [{ type: 'local_policy', comment: 'arc=pass' }]);
});

test('one record, or several signatures, still come out as lists', () => {
  const one = parseDmarcXml(reportXml({ records: [{ ip: '1.2.3.4' }] }));
  assert.equal(one.records.length, 1); assert.ok(Array.isArray(one.records[0].dkim) && Array.isArray(one.records[0].spf));
  const many = parseDmarcXml(reportXml({ records: [{ ip: '1.2.3.4', dkimAuth: [{ domain: 'a.example', result: 'pass' }, { domain: 'b.example', result: 'fail' }] }] }));
  assert.deepEqual(many.records[0].dkim.map((d) => d.domain), ['a.example', 'b.example']);
  assert.deepEqual(parseDmarcXml(reportXml({ records: [] })).records, []);
});

test('what is not a report is refused with a readable reason', () => {
  assert.throws(() => parseDmarcXml('<html><body>hello</body></html>'), /not a DMARC aggregate report/);
  assert.throws(() => parseDmarcXml('this is not xml at all'), /not a DMARC aggregate report/);
  assert.throws(() => parseDmarcXml('<!DOCTYPE feedback [<!ENTITY x "boom">]><feedback><report_metadata/><policy_published/></feedback>'), /defines entities/);
});

test('attachments: plain XML (with a byte-order mark), GZ and ZIP are recognised by their first bytes, not by the name', () => {
  const xml = sample();
  assert.equal(extractXmlDocuments(Buffer.from(`\uFEFF${xml}`), 'report.txt').length, 1);
  const gz = extractXmlDocuments(gzipOf(xml), 'google.com!comdata.rs!1!2.xml.gz'); assert.equal(gz.length, 1); assert.equal(gz[0].name, 'google.com!comdata.rs!1!2.xml');
  assert.equal(extractXmlDocuments(gzipOf(xml), 'noextension').length, 1);
  const zip = extractXmlDocuments(zipOf({ 'a.xml': xml, 'b.XML': reportXml({ id: 'abc-2', records: [] }), 'readme.txt': 'hi', 'dir/': '' }), 'x.zip');
  assert.deepEqual(zip.map((d) => d.name).sort(), ['a.xml', 'b.XML']);
  assert.deepEqual(extractXmlDocuments(Buffer.from('plain text'), 'x.txt'), []); assert.deepEqual(extractXmlDocuments(Buffer.alloc(0), 'x'), []);
  const parsed = parseAttachment(zipOf({ 'a.xml': xml }), 'x.zip'); assert.equal(parsed[0].report.reportId, 'abc-1'); assert.ok(parsed[0].rawXml.startsWith('<?xml'));
});

test('the mailbox takes mail from anyone: an archive that unpacks to too much is refused', () => {
  const bomb = zlib.gzipSync(Buffer.alloc(MAX_XML_BYTES + 1024, 0x20)); // a few KB packed
  assert.ok(bomb.length < 100_000);
  assert.throws(() => extractXmlDocuments(bomb, 'bomb.xml.gz'), /larger than 30 MB unpacked/);
  const big = zipOf({ 'big.xml': Buffer.alloc(MAX_XML_BYTES + 1024, 0x20) });
  assert.ok(big.length < 100_000);
  assert.throws(() => extractXmlDocuments(big, 'bomb.zip'), /larger than 30 MB unpacked/);
  const many = {}; for (let i = 0; i <= MAX_ENTRIES; i++) many[`r${i}.xml`] = '<a/>';
  assert.throws(() => extractXmlDocuments(zipOf(many), 'many.zip'), new RegExp(`at most ${MAX_ENTRIES}`));
  assert.throws(() => extractXmlDocuments(Buffer.concat([Buffer.from('<a>'), Buffer.alloc(MAX_XML_BYTES + 10, 0x61)]), 'big.xml'), /larger than 30 MB/);
});

test('senders are grouped by provider (from the PTR) or, without one, by network prefix', () => {
  for (const [ptr, name] of [['mail-db8eur05on2078.outbound.protection.outlook.com', 'Microsoft 365'], ['mail-sor-f41.google.com', 'Google'], ['a8-93.smtp-out.amazonses.com', 'Amazon SES'],
    ['mail131-12.atl91.mcsv.net', 'Mailchimp'], ['o1.sendgrid.net', 'SendGrid'], ['sender12.zoho.eu', 'Zoho'], ['mail.firma-partner.rs', 'firma-partner.rs'], ['host.example.co.uk.', 'co.uk']]) assert.equal(classifyProvider(ptr), name, ptr);
  assert.equal(classifyProvider(null), null); assert.equal(classifyProvider('localhost'), null);
  assert.equal(sourceGroup('185.220.101.34', null), '185.220.101.0/24');
  assert.equal(sourceGroup('2a01:111:f403:2c0e::70e', null), '2a01:111:f403::/48');
  assert.equal(sourceGroup('2001:db8::1', null), '2001:db8:0::/48');
  assert.equal(sourceGroup('40.107.22.78', 'mail-x.outbound.protection.outlook.com'), 'Microsoft 365');
});

test('the PTR lookup can be switched off, and then gives nothing', async () => {
  assert.equal(await reverseLookup('8.8.8.8'), null);
});
