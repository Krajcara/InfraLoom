'use strict';

// Unpacks a report attachment (.zip / .gz / .xml) and parses an aggregate report (RFC 7489).
// The mailbox receives mail from anyone, so everything that comes out of an attachment is limited in size.

const zlib = require('node:zlib');
const AdmZip = require('adm-zip');
const { XMLParser } = require('fast-xml-parser');

const MAX_XML_BYTES = 30 * 1024 * 1024; // one unpacked report; real ones are a few hundred KB
const MAX_ENTRIES = 20;                 // files read from one archive

const xml = new XMLParser({
  ignoreAttributes: true,
  removeNSPrefix: true,
  parseTagValue: false, // everything stays a string; IP addresses and ids must not become numbers
  trimValues: true,
  isArray: (name, jpath) =>
    ['feedback.record', 'feedback.record.auth_results.dkim', 'feedback.record.auth_results.spf',
      'feedback.record.row.policy_evaluated.reason'].includes(jpath),
});

/**
 * One or more XML strings out of an attachment's bytes. The format is recognised by its first bytes, not by the
 * file name (senders are not consistent).
 */
function extractXmlDocuments(buffer, filename = '') {
  if (!buffer || buffer.length === 0) return [];

  // ZIP: PK\x03\x04
  if (buffer[0] === 0x50 && buffer[1] === 0x4b && buffer[2] === 0x03 && buffer[3] === 0x04) {
    const zip = new AdmZip(buffer);
    const entries = zip.getEntries().filter((e) => !e.isDirectory && /\.xml$/i.test(e.entryName));
    if (entries.length > MAX_ENTRIES) throw new Error(`The archive holds ${entries.length} XML files; at most ${MAX_ENTRIES} are read`);
    return entries.map((e) => {
      if (e.header.size > MAX_XML_BYTES) throw new Error(`${e.entryName} is larger than ${MAX_XML_BYTES / 1048576} MB unpacked`);
      return { name: e.entryName, xml: e.getData().toString('utf8') };
    });
  }

  // GZIP: 1f 8b
  if (buffer[0] === 0x1f && buffer[1] === 0x8b) {
    let out;
    try {
      out = zlib.gunzipSync(buffer, { maxOutputLength: MAX_XML_BYTES });
    } catch (e) {
      if (e.code === 'ERR_BUFFER_TOO_LARGE') throw new Error(`The file is larger than ${MAX_XML_BYTES / 1048576} MB unpacked`);
      throw e;
    }
    return [{ name: filename.replace(/\.gz$/i, ''), xml: out.toString('utf8') }];
  }

  if (buffer.length > MAX_XML_BYTES) throw new Error(`The file is larger than ${MAX_XML_BYTES / 1048576} MB`);
  const text = buffer.toString('utf8').replace(/^\uFEFF/, '');
  if (text.trimStart().startsWith('<')) return [{ name: filename, xml: text }];
  return [];
}

const str = (v) => (v === undefined || v === null || v === '' ? null : String(v));
const int = (v) => {
  const n = parseInt(v, 10);
  return Number.isFinite(n) ? n : null;
};

/** Parses one DMARC XML into a normalised object. Throws if it is not a valid aggregate report. */
function parseDmarcXml(xmlText) {
  // reports never define entities; a document that does is refused instead of expanded
  if (/<!ENTITY/i.test(xmlText)) throw new Error('The XML defines entities, which a DMARC report never does');
  const doc = xml.parse(xmlText);
  const fb = doc?.feedback;
  if (!fb?.report_metadata || !fb?.policy_published) {
    throw new Error('The XML is not a DMARC aggregate report (feedback/report_metadata is missing)');
  }

  const md = fb.report_metadata;
  const pp = fb.policy_published;

  const records = (fb.record || []).map((rec) => {
    const row = rec.row || {};
    const pe = row.policy_evaluated || {};
    const id = rec.identifiers || {};
    const auth = rec.auth_results || {};

    const dkim = (auth.dkim || []).map((d) => ({ domain: str(d.domain), selector: str(d.selector), result: str(d.result)?.toLowerCase() ?? null }));
    const spf = (auth.spf || []).map((s) => ({ domain: str(s.domain), scope: str(s.scope), result: str(s.result)?.toLowerCase() ?? null }));
    const reasons = (pe.reason || []).map((r) => ({ type: str(r.type), comment: str(r.comment) }));

    const dkimEval = str(pe.dkim)?.toLowerCase() ?? null;
    const spfEval = str(pe.spf)?.toLowerCase() ?? null;

    return {
      sourceIp: str(row.source_ip),
      count: int(row.count) ?? 0,
      disposition: str(pe.disposition),
      dkimEval,
      spfEval,
      // DMARC passes if at least one of the aligned mechanisms passed
      dmarcPass: dkimEval === 'pass' || spfEval === 'pass',
      override: reasons[0]?.type ?? null,
      reasons,
      headerFrom: str(id.header_from)?.toLowerCase() ?? null,
      envelopeFrom: str(id.envelope_from)?.toLowerCase() ?? null,
      envelopeTo: str(id.envelope_to)?.toLowerCase() ?? null,
      dkim,
      spf,
      spfPermerror: spf.some((s) => s.result === 'permerror'),
    };
  }).filter((r) => r.sourceIp);

  return {
    orgName: str(md.org_name) ?? 'unknown',
    orgEmail: str(md.email),
    reportId: str(md.report_id) ?? `noid-${Date.now()}`,
    dateBegin: int(md.date_range?.begin),
    dateEnd: int(md.date_range?.end),
    policy: {
      domain: str(pp.domain)?.toLowerCase() ?? null,
      adkim: str(pp.adkim) ?? 'r',
      aspf: str(pp.aspf) ?? 'r',
      p: str(pp.p),
      sp: str(pp.sp),
      np: str(pp.np),
      pct: int(pp.pct) ?? 100,
    },
    records,
  };
}

/** An attachment → the parsed reports in it (with the raw XML, for storing). */
function parseAttachment(buffer, filename) {
  return extractXmlDocuments(buffer, filename).map((d) => ({ filename: d.name || filename, rawXml: d.xml, report: parseDmarcXml(d.xml) }));
}

module.exports = { extractXmlDocuments, parseDmarcXml, parseAttachment, MAX_XML_BYTES, MAX_ENTRIES };
