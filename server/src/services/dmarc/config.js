'use strict';

// DMARC module settings. They live in dmarc_config (not in the general settings table), so the Graph client secret
// is never returned by the generic settings API; the secret is also never returned by this module's own API.

const db = require('../../db/database');

class ConfigError extends Error {}

const DEFAULTS = {
  enabled: 'false',
  tenant_id: '',
  client_id: '',
  client_secret: '',
  mailbox: '',
  secret_expires: '',           // YYYY-MM-DD, from Entra → Certificates & secrets: a reminder is sent before it
  poll_minutes: '60',
  initial_lookback_days: '30',
  retention_days: '400',
  raw_xml_days: '90',
  store_raw_xml: 'true',
  trusted_groups: 'Microsoft 365',
  alert_new_sources: 'true',
  alert_overrides: 'false',
  cf_token: '',                 // Cloudflare API token (Zone → Zone → Read, and Zone → DNS → Read for the records); write-only
  cf_check_records: 'true',     // read the DMARC record of each zone through the Cloudflare API
};

const rawAll = () => ({ ...DEFAULTS, ...Object.fromEntries(db.prepare('SELECT key, value FROM dmarc_config').all().map((r) => [r.key, r.value])) });
const bool = (v) => ['1', 'true', 'yes', 'on'].includes(String(v).toLowerCase());
const GUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/** Typed settings, for the module itself (contains the secret). */
function get() {
  const r = rawAll();
  const n = (v, d) => (Number.isFinite(parseInt(v, 10)) ? parseInt(v, 10) : d);
  return {
    enabled: bool(r.enabled),
    tenantId: r.tenant_id, clientId: r.client_id, clientSecret: r.client_secret, mailbox: r.mailbox, secretExpires: r.secret_expires,
    pollMinutes: n(r.poll_minutes, 60), initialLookbackDays: n(r.initial_lookback_days, 30),
    retentionDays: n(r.retention_days, 400), rawXmlDays: n(r.raw_xml_days, 90), storeRawXml: bool(r.store_raw_xml),
    trustedGroups: r.trusted_groups.split(',').map((s) => s.trim().toLowerCase()).filter(Boolean),
    alertOnNewSources: bool(r.alert_new_sources), alertOnOverrides: bool(r.alert_overrides),
    cfToken: r.cf_token, cfCheckRecords: bool(r.cf_check_records),
  };
}

const isEnabled = () => bool(rawAll().enabled);

/** Settings for the settings screen: everything but the secret, which is only reported as set or not. */
function publicConfig() {
  const r = rawAll();
  return {
    enabled: bool(r.enabled), tenant_id: r.tenant_id, client_id: r.client_id, client_secret_set: !!r.client_secret, mailbox: r.mailbox, secret_expires: r.secret_expires,
    poll_minutes: Number(r.poll_minutes), initial_lookback_days: Number(r.initial_lookback_days), retention_days: Number(r.retention_days), raw_xml_days: Number(r.raw_xml_days),
    store_raw_xml: bool(r.store_raw_xml), trusted_groups: r.trusted_groups, alert_new_sources: bool(r.alert_new_sources), alert_overrides: bool(r.alert_overrides),
    graph_configured: !!(r.tenant_id && r.client_id && r.client_secret && r.mailbox),
    cf_token_set: !!r.cf_token, cf_check_records: bool(r.cf_check_records), cf_configured: !!r.cf_token,
  };
}

const intIn = (v, label, min, max) => {
  const n = Number(v);
  if (!Number.isInteger(n) || n < min || n > max) throw new ConfigError(`${label} must be a whole number between ${min} and ${max}`);
  return String(n);
};

/** Validates and stores the changed settings. An empty or missing client_secret leaves the stored one as it is
 * (the screen never receives it); clear_client_secret removes it. Returns the keys that were written. */
function update(body = {}) {
  const out = {};
  const text = (k, label, max = 200) => {
    if (body[k] === undefined) return null;
    const s = String(body[k] ?? '').trim();
    if (s.length > max) throw new ConfigError(`${label} is too long`);
    return s;
  };
  if (body.enabled !== undefined) out.enabled = body.enabled ? 'true' : 'false';
  for (const [k, label] of [['tenant_id', 'Tenant ID'], ['client_id', 'Client ID']]) {
    const s = text(k, label); if (s === null) continue;
    if (s && !GUID.test(s)) throw new ConfigError(`${label} must be a GUID like 6f9e3d4c-e6e8-41a7-92a4-27a229ac2459`);
    out[k] = s;
  }
  const mb = text('mailbox', 'Mailbox', 254);
  if (mb !== null) { if (mb && !EMAIL.test(mb)) throw new ConfigError('Mailbox must be an e-mail address'); out.mailbox = mb.toLowerCase(); }
  if (body.clear_client_secret) out.client_secret = '';
  else if (typeof body.client_secret === 'string' && body.client_secret.trim()) {
    if (body.client_secret.length > 500) throw new ConfigError('Client secret is too long');
    out.client_secret = body.client_secret.trim();
  }
  const exp = text('secret_expires', 'Secret expiry date', 10);
  if (exp !== null) {
    if (exp && (!/^\d{4}-\d{2}-\d{2}$/.test(exp) || Number.isNaN(Date.parse(`${exp}T00:00:00Z`)))) throw new ConfigError('Secret expiry date must look like 2028-10-18');
    out.secret_expires = exp;
  }
  if (body.poll_minutes !== undefined) out.poll_minutes = intIn(body.poll_minutes, 'Check every (minutes)', 5, 1440);
  if (body.initial_lookback_days !== undefined) out.initial_lookback_days = intIn(body.initial_lookback_days, 'First read goes back (days)', 1, 365);
  if (body.retention_days !== undefined) out.retention_days = intIn(body.retention_days, 'Keep reports (days)', 30, 3650);
  if (body.raw_xml_days !== undefined) out.raw_xml_days = intIn(body.raw_xml_days, 'Keep original XML (days, 0 = as long as the report)', 0, 3650);
  if (body.clear_cf_token) out.cf_token = '';
  else if (typeof body.cf_token === 'string' && body.cf_token.trim()) {
    if (!/^[A-Za-z0-9_-]{20,120}$/.test(body.cf_token.trim())) throw new ConfigError('The Cloudflare API token looks wrong: it is 40 or so letters, digits, - and _');
    out.cf_token = body.cf_token.trim();
  }
  for (const k of ['store_raw_xml', 'alert_new_sources', 'alert_overrides', 'cf_check_records']) if (body[k] !== undefined) out[k] = body[k] ? 'true' : 'false';
  const tg = text('trusted_groups', 'Trusted senders', 500);
  if (tg !== null) out.trusted_groups = tg;

  const put = db.prepare("INSERT INTO dmarc_config (key, value, updated_at) VALUES (?, ?, datetime('now')) ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at");
  db.transaction(() => { for (const [k, v] of Object.entries(out)) put.run(k, v); })();
  return Object.keys(out);
}

module.exports = { get, publicConfig, update, isEnabled, ConfigError, DEFAULTS };
