'use strict';

// Domains: the DMARC record of each (from Cloudflare, or from public DNS for a domain added by hand), what it means,
// and the alert when a record gets worse. Pure functions first, then the refresh.

const dns = require('node:dns/promises');

const DOMAIN_RE = /^(?=.{1,253}$)([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z0-9-]{2,63}$/;
const normalizeDomain = (s) => String(s ?? '').trim().toLowerCase().replace(/\.$/, '');
const isDomain = (s) => DOMAIN_RE.test(s);

/** The text of a TXT record as the DNS holds it: the quotes and the splitting into 255-character pieces taken away. */
const txtText = (s) => String(s).replace(/"\s+"/g, '').replace(/^\s*"/, '').replace(/"\s*$/, '').trim();

/** "v=DMARC1; p=none; rua=mailto:a@b.rs,mailto:c@d.rs!10m" → its tags. */
function parseDmarcRecord(text) {
  const parts = txtText(text).split(';').map((x) => x.trim()).filter(Boolean);
  if (!parts.length) return { ok: false, error: 'The record is empty' };
  const tags = {};
  for (const part of parts) {
    const i = part.indexOf('=');
    if (i < 1) return { ok: false, error: `“${part.slice(0, 40)}” is not a tag=value pair` };
    tags[part.slice(0, i).trim().toLowerCase()] = part.slice(i + 1).trim();
  }
  if (parts[0].replace(/\s/g, '').toLowerCase() !== 'v=dmarc1') return { ok: false, error: 'The record does not start with v=DMARC1' };
  const p = (tags.p || '').toLowerCase();
  if (!['none', 'quarantine', 'reject'].includes(p)) return { ok: false, error: p ? `Unknown policy p=${p}` : 'The p= tag is missing' };
  const pct = tags.pct === undefined ? 100 : parseInt(tags.pct, 10);
  if (!Number.isInteger(pct) || pct < 0 || pct > 100) return { ok: false, error: `Bad pct=${tags.pct}` };
  const addrs = (v) => (v ? v.split(',').map((x) => x.trim()).filter((x) => /^mailto:/i.test(x)).map((x) => x.slice(7).split('!')[0].trim().toLowerCase()).filter(Boolean) : []);
  return { ok: true, p, sp: (tags.sp || '').toLowerCase() || null, pct, adkim: (tags.adkim || 'r').toLowerCase(), aspf: (tags.aspf || 'r').toLowerCase(), rua: addrs(tags.rua), ruf: addrs(tags.ruf) };
}

/**
 * What the DMARC records found at _dmarc.<domain> amount to.
 * health: protected (quarantine/reject for all mail) | partial (enforced for a part, pct < 100) | monitor (p=none)
 *   | no_record | multiple (more than one record: receivers ignore them all) | invalid | unchecked (could not be read)
 */
function classifyRecords({ txt = [], cname = null }) {
  const dmarc = txt.filter((t) => /^\s*"?\s*v\s*=\s*DMARC1/i.test(String(t)));
  if (dmarc.length === 0) {
    if (cname) return { health: 'unchecked', error: `_dmarc is a CNAME to ${cname}; its policy cannot be read here`, count: 0, raw: null };
    return { health: 'no_record', count: 0, raw: null };
  }
  const raw = dmarc.map(txtText).join(' | ');
  if (dmarc.length > 1) return { health: 'multiple', count: dmarc.length, raw, error: 'More than one DMARC record: receivers ignore all of them' };
  const r = parseDmarcRecord(dmarc[0]);
  if (!r.ok) return { health: 'invalid', count: 1, raw, error: r.error };
  const health = r.p === 'none' ? 'monitor' : r.pct < 100 ? 'partial' : 'protected';
  return { health, count: 1, raw, p: r.p, sp: r.sp, pct: r.pct, adkim: r.adkim, aspf: r.aspf, rua: r.rua };
}

const PROBLEM = new Set(['no_record', 'multiple', 'invalid']);
const WEAK = new Set(['monitor', 'partial']);
const ruaMissing = (row, mailbox) => !!mailbox && ['protected', 'partial', 'monitor'].includes(row.health) && !String(row.rua || '').split(',').filter(Boolean).includes(mailbox.toLowerCase());
const hasIssue = (row, mailbox) => !row.ignored && (PROBLEM.has(row.health) || ruaMissing(row, mailbox));

/** One domain for the screen: the stats of the period joined with what is known about its record. */
function buildTable({ registry, stats, policies, mailbox }) {
  const reg = new Map(registry.map((r) => [r.name, r]));
  const st = new Map(stats.map((s) => [s.domain, s]));
  const names = [...new Set([...reg.keys(), ...st.keys()].filter(Boolean))].sort();
  return names.map((name) => {
    const r = reg.get(name); const s = st.get(name); const pol = policies.get(name);
    const total = s?.total ?? 0;
    const split = (aligned, unaligned) => ({ aligned: aligned ?? 0, notAligned: unaligned ?? 0, failed: Math.max(0, total - (aligned ?? 0) - (unaligned ?? 0)) });
    return {
      name, source: r?.source ?? 'reports', ignored: !!r?.ignored,
      total, pass: s?.pass ?? 0, fail: total - (s?.pass ?? 0), reports: s?.reports ?? 0,
      dkim: split(s?.dkim_aligned, s?.dkim_unaligned_pass), spf: split(s?.spf_aligned, s?.spf_unaligned_pass),
      policy: pol ? { p: pol.policy_p, sp: pol.policy_sp, pct: pol.policy_pct, from: 'reports' } : r?.p ? { p: r.p, sp: r.sp, pct: r.pct, from: 'dns' } : null,
      record: r ? { health: r.health ?? 'unchecked', raw: r.record_raw, count: r.record_count, error: r.record_error, rua: (r.rua || '').split(',').filter(Boolean), rua_missing: ruaMissing(r, mailbox), checked_at: r.checked_at } : null,
      issue: r ? hasIssue(r, mailbox) : false,
    };
  });
}

const defaultResolveTxt = async (name) => {
  if (/^(0|false|no|off)$/i.test(process.env.DMARC_DNS_LOOKUP || '')) throw Object.assign(new Error('DNS lookups are switched off'), { code: 'OFF' });
  const rows = await dns.resolveTxt(name);
  return rows.map((chunks) => chunks.join(''));
};

/**
 * @param {object} deps
 * @param {object} deps.store
 * @param {object|null} deps.cloudflare   from createCloudflareClient(), or null
 * @param {object} deps.config            typed settings
 * @param {(event: string, message: string) => Promise<void>} deps.notify
 * @param {(name: string) => Promise<string[]>} [deps.resolveTxt]   public-DNS lookup of a TXT name (replaceable in tests)
 */
function createDomainService({ store, cloudflare, config, notify, resolveTxt = defaultResolveTxt, logger = console }) {
  let running = false;

  async function readRecord(row) {
    if (row.source === 'cloudflare' && cloudflare && config.cfCheckRecords) {
      try { return classifyRecords(await cloudflare.getDmarcRecords(row.zone_id, row.name)); } catch (e) {
        if (e.permission) return { health: 'unchecked', error: 'The API token may not read DNS records (it needs Zone → DNS → Read)', count: null, raw: null };
        throw e;
      }
    }
    try { return classifyRecords({ txt: await resolveTxt(`_dmarc.${row.name}`) }); } catch (e) {
      if (e.code === 'ENODATA' || e.code === 'ENOTFOUND') return classifyRecords({ txt: [] });
      if (e.code === 'OFF') return { health: 'unchecked', error: null, count: null, raw: null };
      return { health: 'unchecked', error: `DNS lookup failed: ${e.code || e.message}`, count: null, raw: null };
    }
  }

  /** Checks the record of one domain, stores it, and returns the alert it raises (if the record got worse). */
  async function checkOne(row) {
    const prev = store.getRegistry(row.name);
    const c = await readRecord(row);
    store.saveCheck(row.name, { record_raw: c.raw ?? null, record_count: c.count ?? null, p: c.p ?? null, sp: c.sp ?? null, pct: c.pct ?? null, adkim: c.adkim ?? null, aspf: c.aspf ?? null, rua: (c.rua || []).join(','), health: c.health, record_error: c.error ?? null });
    if (!prev?.health || prev.health === 'unchecked' || row.ignored || prev.ignored) return null; // the first look is a baseline, not news
    const now = store.getRegistry(row.name);
    const was = { ...prev };
    const worse = (PROBLEM.has(now.health) && !PROBLEM.has(was.health)) || (WEAK.has(now.health) && was.health === 'protected') || (ruaMissing(now, config.mailbox) && !ruaMissing(was, config.mailbox) && !PROBLEM.has(now.health));
    if (!worse) return null;
    const what = now.health === 'no_record' ? 'its DMARC record is gone' : now.health === 'multiple' ? 'it has more than one DMARC record' : now.health === 'invalid' ? `its DMARC record is invalid (${now.record_error})`
      : WEAK.has(now.health) ? `its policy is now ${now.health === 'monitor' ? 'p=none (monitoring only)' : `partial (pct=${now.pct})`}` : `its rua no longer includes ${config.mailbox}`;
    return { event: 'dmarc_domain_issue', message: `DMARC: the record of ${row.name} changed for the worse — ${what}.` };
  }

  /** Reads the zones from Cloudflare (if a token is set), then checks the record of every domain. */
  async function refresh() {
    if (running) return { skipped: true, reason: 'a refresh is already running' };
    running = true;
    const out = { zones: null, domains: 0, checked: 0, problems: 0, alerts: 0 };
    try {
      if (cloudflare) {
        const zones = await cloudflare.listZones();
        out.zones = zones.length;
        for (const z of zones) store.upsertRegistry({ name: z.name, source: 'cloudflare', zone_id: z.id });
        store.pruneCloudflare(zones.map((z) => z.name));
      }
      const rows = store.listRegistry();
      out.domains = rows.length;
      const alerts = [];
      for (let i = 0; i < rows.length; i += 5) {
        await Promise.all(rows.slice(i, i + 5).map(async (row) => {
          try { const a = await checkOne(row); out.checked++; if (a) alerts.push(a); } catch (e) {
            logger.error?.(`[dmarc] checking ${row.name}: ${e.message}`);
            store.saveCheck(row.name, { record_raw: null, record_count: null, health: 'unchecked', record_error: e.message.slice(0, 200) });
          }
        }));
      }
      out.problems = store.listRegistry().filter((r) => hasIssue(r, config.mailbox)).length;
      for (const a of alerts.slice(0, 10)) { try { await notify(a.event, a.message); out.alerts++; } catch (e) { logger.error?.('[dmarc] notify failed:', e.message); } }
      if (alerts.length > 10) await notify('dmarc_domain_issue', `DMARC: ${alerts.length - 10} more domains changed for the worse — see the DMARC page.`).catch(() => {});
      store.setState('domains_refreshed', new Date().toISOString());
      store.setState('domains_error', '');
      return out;
    } catch (e) {
      store.setState('domains_error', e.message);
      throw e;
    } finally { running = false; }
  }

  return { refresh, checkOne, isRunning: () => running };
}

module.exports = { createDomainService, parseDmarcRecord, classifyRecords, buildTable, normalizeDomain, isDomain, hasIssue, ruaMissing, txtText, PROBLEM };
