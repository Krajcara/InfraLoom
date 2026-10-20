'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { filesFromMime, MAX_ATTACHMENT_BYTES } = require('../src/services/dmarc/graph');
const { noReportReason } = require('../src/services/dmarc/ingest');
const { parseAttachment } = require('../src/services/dmarc/parser');
const { reportXml, zipOf, gzipOf, mimeMessage } = require('./_dmarcSamples');

const xml = (id) => reportXml({ id, records: [{ ip: '192.0.2.1', count: 5 }] });
const zipName = 'google.com!comdata.rs!1760918400!1761004799.zip';

test('a report attached as a file is found in the source of the message', async () => {
  const r = await filesFromMime(mimeMessage({ parts: [{ name: zipName, content: zipOf({ 'r.xml': xml('f1') }) }] }));
  assert.deepEqual(r.files.map((f) => [f.name, f.contentType]), [[zipName, 'application/zip']]); assert.deepEqual(r.notes, []);
  assert.equal(parseAttachment(r.files[0].buffer, r.files[0].name)[0].report.reportId, 'f1', 'the bytes come out as they went in');
});

test('Google: the report is an attached message, and the archive is inside it', async () => {
  const inner = mimeMessage({ subject: 'Report domain: comdata.rs Submitter: google.com Report-ID: 7', parts: [{ name: zipName, content: zipOf({ 'g.xml': xml('g1') }) }] });
  const outer = mimeMessage({ subject: 'Report domain: comdata.rs Submitter: google.com Report-ID: 7', parts: [{ message: inner }] });
  const r = await filesFromMime(outer);
  assert.deepEqual(r.files.map((f) => f.name), [zipName]);
  assert.equal(parseAttachment(r.files[0].buffer, zipName)[0].report.reportId, 'g1');
});

test('a message in a message in a message is unpacked; deeper than that is refused with a note', async () => {
  const deep = (n, last) => (n === 0 ? last : mimeMessage({ parts: [{ message: deep(n - 1, last) }] }));
  const leaf = mimeMessage({ parts: [{ name: 'r.xml.gz', type: 'application/gzip', content: gzipOf(xml('d1')) }] });
  assert.equal((await filesFromMime(deep(3, leaf))).files.length, 1, 'three levels of attached messages');
  const tooDeep = await filesFromMime(deep(5, leaf));
  assert.equal(tooDeep.files.length, 0); assert.match(tooDeep.notes[0], /nested too deep/);
});

test('files that are too large are left out and mentioned; several files all come out', async () => {
  const big = Buffer.alloc(MAX_ATTACHMENT_BYTES + 1000, 0x61);
  const r = await filesFromMime(mimeMessage({ parts: [{ name: 'big.bin', type: 'application/octet-stream', content: big }, { name: 'a.xml.gz', type: 'application/gzip', content: gzipOf(xml('m1')) }, { name: 'b.zip', content: zipOf({ 'b.xml': xml('m2') }) }] }));
  assert.deepEqual(r.files.map((f) => f.name), ['a.xml.gz', 'b.zip']); assert.match(r.notes[0], /^big\.bin: \d+ MB, too large$/);
});

test('mail with nothing in it gives nothing, and the reason says what was seen', async () => {
  const r = await filesFromMime(mimeMessage({ parts: [] })); assert.deepEqual([r.files.length, r.notes.length], [0, 0]);
  assert.equal(noReportReason([], []), 'no attachments');
  assert.equal(noReportReason([], ['the message source could not be read (Graph 404 ErrorItemNotFound)']), 'no attachments; the message source could not be read (Graph 404 ErrorItemNotFound)');
  assert.equal(noReportReason([{ name: 'photo.png', buffer: Buffer.alloc(2048) }], []), 'photo.png (2 KB): no DMARC report in it');
  assert.match(noReportReason(Array.from({ length: 5 }, (_, i) => ({ name: `f${i}.bin`, buffer: Buffer.alloc(10) })), []), /f0\.bin \(10 B\), f1\.bin \(10 B\), f2\.bin \(10 B\) and 2 more: no DMARC report in it/);
});
