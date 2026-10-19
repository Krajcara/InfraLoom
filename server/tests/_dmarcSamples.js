'use strict';

// Builders of DMARC aggregate reports (XML, ZIP, GZ) for the tests.

const zlib = require('node:zlib');
const AdmZip = require('adm-zip');

const hour = (n = 1) => Math.floor(Date.now() / 1000) - n * 3600;

/** records: [{ ip, count, disposition, dkim, spf, headerFrom, envelopeFrom, dkimAuth, spfAuth, reasons }] */
function reportXml({ org = 'google.com', email = 'noreply-dmarc-support@google.com', id = 'r-1', domain = 'comdata.rs', end = hour(1), begin = end - 86400, p = 'quarantine', sp = 'quarantine', pct = 100, records = [] } = {}) {
  const rec = records.map((r) => {
    const dkim = r.dkim ?? 'pass'; const spf = r.spf ?? 'pass';
    const dkimAuth = (r.dkimAuth ?? [{ domain, selector: 'selector1', result: dkim }]).map((d) => `<dkim><domain>${d.domain}</domain><selector>${d.selector || 's'}</selector><result>${d.result}</result></dkim>`).join('');
    const spfAuth = (r.spfAuth ?? [{ domain, scope: 'mfrom', result: spf }]).map((s) => `<spf><domain>${s.domain}</domain><scope>${s.scope || 'mfrom'}</scope><result>${s.result}</result></spf>`).join('');
    const reasons = (r.reasons ?? []).map((x) => `<reason><type>${x.type}</type>${x.comment ? `<comment>${x.comment}</comment>` : ''}</reason>`).join('');
    return `<record><row><source_ip>${r.ip}</source_ip><count>${r.count ?? 1}</count><policy_evaluated><disposition>${r.disposition ?? 'none'}</disposition><dkim>${dkim}</dkim><spf>${spf}</spf>${reasons}</policy_evaluated></row>` +
      `<identifiers><envelope_to>gmail.com</envelope_to><envelope_from>${r.envelopeFrom ?? domain}</envelope_from><header_from>${r.headerFrom ?? domain}</header_from></identifiers>` +
      `<auth_results>${dkimAuth}${spfAuth}</auth_results></record>`;
  }).join('');
  return `<?xml version="1.0" encoding="UTF-8" ?><feedback><version>1.0</version><report_metadata><org_name>${org}</org_name><email>${email}</email><report_id>${id}</report_id>` +
    `<date_range><begin>${begin}</begin><end>${end}</end></date_range></report_metadata>` +
    `<policy_published><domain>${domain}</domain><adkim>r</adkim><aspf>r</aspf><p>${p}</p><sp>${sp}</sp><pct>${pct}</pct></policy_published>${rec}</feedback>`;
}

const zipOf = (files) => { const z = new AdmZip(); for (const [name, data] of Object.entries(files)) z.addFile(name, Buffer.isBuffer(data) ? data : Buffer.from(data)); return z.toBuffer(); };
const gzipOf = (xml) => zlib.gzipSync(Buffer.from(xml));

module.exports = { reportXml, zipOf, gzipOf, hour };
