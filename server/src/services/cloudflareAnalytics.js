'use strict';

// DNS analytics of the domains that are hosted at Cloudflare: how many queries they get, for which names and record types, with what answers,
// and from which of Cloudflare's data centres. Read with the API token of the DNS page (it needs "Zone → Analytics → Read" besides what it has),
// from Cloudflare's GraphQL analytics API. Every figure is a query of its own, so one that Cloudflare refuses (a plan without it, a field that is
// called otherwise) leaves the others as they are, and says why.

const axios = require('axios');
const db = require('../db/database');

const base = () => (process.env.CLOUDFLARE_ANALYTICS_BASE_URL || 'https://api.cloudflare.com/client/v4').replace(/\/$/, '');
const RANGES = { '24h': 86400, '7d': 7 * 86400, '30d': 30 * 86400 };
const CACHE_MS = 5 * 60_000;
const DAILY_FROM = 30 * 86400;                    // from this range the timeline is by the day
const PARTS = { timeline: ['datetimeHour', 'datetimeHour_ASC', 1000], names: ['queryName', 'count_DESC', 15], types: ['queryType', 'count_DESC', 12], codes: ['responseCode', 'count_DESC', 12], colos: ['coloCode', 'count_DESC', 12] };

class CfError extends Error { constructor(message, status = 502) { super(message); this.status = status; } }

const getSetting = (key) => db.prepare('SELECT value FROM settings WHERE key = ?').get(key)?.value || '';
const token = () => getSetting('cloudflare_api_token');
const LAST = new Map();      // what Cloudflare last answered to each figure, for an administrator who has to find out why one is missing
const CACHE = new Map();

const NO_PERMISSION = 'The Cloudflare token cannot read DNS analytics. In Cloudflare, edit the API token and add Zone → Analytics → Read for the zones (the DNS page keeps the token).';

/** What Cloudflare said, in words a person can act on. */
function friendly(errors, http) {
  const first = Array.isArray(errors) && errors.length ? errors[0] : null;
  const text = String(first?.message || '').toLowerCase(); const code = String(first?.extensions?.code || '').toLowerCase();
  if (http === 401 || http === 403 || code === 'authz' || /does not have access|not authorized|authentication error|unauthori[sz]ed|permission/.test(text)) return NO_PERMISSION;
  if (http === 429 || /rate limit|too many requests/.test(text)) return 'Cloudflare is limiting the requests (rate limit): wait a few minutes and try again.';
  if (first?.message) return String(first.message).slice(0, 300);
  return http ? `Cloudflare answered HTTP ${http}` : 'No answer from Cloudflare';
}

async function call(method, path, body, { retry = true } = {}) {
  const t = token();
  if (!t) throw new CfError('The Cloudflare API token is not set: it is kept on the DNS page, under Cloudflare', 400);
  try {
    const res = await axios({ method, url: `${base()}${path}`, data: body, headers: { Authorization: `Bearer ${t}`, 'Content-Type': 'application/json' }, timeout: 20000, validateStatus: () => true });
    if (res.status === 429 && retry) {
      const wait = Math.min(Number(res.headers['retry-after']) || 1, 5);
      await new Promise((r) => setTimeout(r, wait * 1000));
      return call(method, path, body, { retry: false });
    }
    return res;
  } catch (e) { throw new CfError(e.code === 'ECONNABORTED' ? 'Cloudflare did not answer within 20 s' : `Cannot reach Cloudflare: ${e.code || e.message}`); }
}

const REFUSED = 'Cloudflare refused the token: it is wrong, has expired, or cannot read zones (it needs Zone → Zone → Read). The DNS page keeps the token.';
const zonesFail = (r) => new CfError(r.status === 401 || r.status === 403 ? REFUSED : friendly(r.data?.errors, r.status));
let ZONES = null;

/** The zones the token sees (or the one zone the DNS page was limited to); remembered for five minutes. */
async function listZones({ now = Date.now() } = {}) {
  const only = getSetting('cloudflare_zone_id'); const who = `${token()}|${only}`;
  if (ZONES && ZONES.who === who && now - ZONES.at < CACHE_MS) return ZONES.list;
  const list = await fetchZones(only); ZONES = { who, at: now, list }; return list;
}
async function fetchZones(only) {
  if (only) {
    const r = await call('get', `/zones/${encodeURIComponent(only)}`);
    if (r.status !== 200 || !r.data?.success) throw zonesFail(r);
    return [{ id: r.data.result.id, name: r.data.result.name, status: r.data.result.status }];
  }
  const out = [];
  for (let page = 1; page <= 10; page++) {
    const r = await call('get', `/zones?per_page=50&page=${page}`);
    if (r.status !== 200 || !r.data?.success) throw zonesFail(r);
    out.push(...r.data.result.map((z) => ({ id: z.id, name: z.name, status: z.status })));
    if (page >= (r.data.result_info?.total_pages || 1)) break;
  }
  return out.sort((a, b) => a.name.localeCompare(b.name));
}

function query(part) {
  const [dim, order, limit] = PARTS[part];
  return `query($zone: String!, $from: Time!, $to: Time!) { viewer { zones(filter: {zoneTag: $zone}) { dnsAnalyticsAdaptiveGroups(limit: ${limit}, filter: {datetime_geq: $from, datetime_leq: $to}, orderBy: [${order}]) { count dimensions { ${dim} } } } } }`;
}

/** One figure of one zone: the rows { key, count }. Throws CfError with the reason. */
async function figure(zone, part, from, to) {
  const q = query(part); const dim = PARTS[part][0];
  const r = await call('post', '/graphql', { query: q, variables: { zone, from: from.toISOString(), to: to.toISOString() } });
  LAST.set(`${zone}|${part}`, { at: new Date().toISOString(), part, http: r.status, request: { zone, from: from.toISOString(), to: to.toISOString(), query: q }, response: JSON.stringify(r.data).slice(0, 4000) });
  if (LAST.size > 400) LAST.delete(LAST.keys().next().value);
  if (r.status !== 200 || (Array.isArray(r.data?.errors) && r.data.errors.length)) throw new CfError(friendly(r.data?.errors, r.status));
  const rows = r.data?.data?.viewer?.zones?.[0]?.dnsAnalyticsAdaptiveGroups;
  if (!Array.isArray(rows)) throw new CfError('Cloudflare answered, but without the figures (the zone may not have DNS analytics on this plan)');
  return rows.map((x) => ({ key: x.dimensions?.[dim] == null ? '' : String(x.dimensions[dim]), count: Number(x.count) || 0 }));
}

function timelineOf(rows, daily) {
  const step = daily ? 86400 : 3600; const by = new Map();
  for (const r of rows) { const t = Math.floor(new Date(r.key).getTime() / 1000 / step) * step; if (Number.isFinite(t)) by.set(t, (by.get(t) || 0) + r.count); }
  return [...by].sort((a, b) => a[0] - b[0]).map(([ts, queries]) => ({ ts, queries }));
}

/** The figures of a zone for a range. parts: which of them ('timeline' alone is enough for the table of all the domains). */
async function zoneStats(zone, range, parts = Object.keys(PARTS), { refresh = false, now = Date.now() } = {}) {
  const span = RANGES[range]; if (!span) throw new CfError(`Range must be one of ${Object.keys(RANGES).join(', ')}`, 400);
  // each figure is remembered for five minutes by itself: the table of all the domains and the page of one of them share the timeline
  const to = new Date(now); const from = new Date(now - span * 1000);
  const errors = {}; const got = {}; let asked = 0;
  await Promise.all(parts.map(async (p) => {
    const key = `${zone}|${range}|${p}`; const hit = CACHE.get(key);
    if (!refresh && hit && now - hit.at < CACHE_MS) { got[p] = hit.rows; return; }
    asked += 1;
    try { const rows = await figure(zone, p, from, to); got[p] = rows; CACHE.set(key, { at: now, rows }); if (CACHE.size > 600) CACHE.delete(CACHE.keys().next().value); } catch (e) { errors[p] = e.message; }
  }));
  if (Object.keys(got).length === 0) throw new CfError(Object.values(errors)[0] || 'Cloudflare gave no figures');
  const timeline = got.timeline ? timelineOf(got.timeline, span >= DAILY_FROM) : null;
  const total = timeline ? timeline.reduce((t, p) => t + p.queries, 0) : (got.types || got.codes || got.names || []).reduce((t, r) => t + r.count, 0);
  const top = (p) => (got[p] || []).filter((r) => r.count > 0).map((r) => ({ name: r.key, count: r.count }));
  const value = { zone, range, from: Math.floor(from.getTime() / 1000), to: Math.floor(to.getTime() / 1000), queries: total, bucket: span >= DAILY_FROM ? 86400 : 3600, timeline, top: { names: top('names'), types: top('types'), codes: top('codes'), colos: top('colos') }, errors, fetched_at: new Date(now).toISOString(), cached: asked === 0 };
  return value;
}

/** All the domains: the queries of each, and the timeline of all together. */
async function allStats(range, { refresh = false, now = Date.now() } = {}) {
  const zones = await listZones(); const rows = []; const errors = {};
  for (let i = 0; i < zones.length; i += 4) {
    await Promise.all(zones.slice(i, i + 4).map(async (z) => {
      try { const s = await zoneStats(z.id, range, ['timeline'], { refresh, now }); rows.push({ zone: z.id, name: z.name, queries: s.queries, timeline: s.timeline }); } catch (e) { errors[z.name] = e.message; rows.push({ zone: z.id, name: z.name, queries: null, timeline: [] }); }
    }));
  }
  if (zones.length && Object.keys(errors).length === zones.length) throw new CfError(Object.values(errors)[0]);
  const merged = new Map(); for (const r of rows) for (const p of r.timeline) merged.set(p.ts, (merged.get(p.ts) || 0) + p.queries);
  const span = RANGES[range];
  return { range, zone: 'all', queries: rows.reduce((t, r) => t + (r.queries || 0), 0), bucket: span >= DAILY_FROM ? 86400 : 3600, from: Math.floor((now - span * 1000) / 1000), to: Math.floor(now / 1000), timeline: [...merged].sort((a, b) => a[0] - b[0]).map(([ts, queries]) => ({ ts, queries })), zones: rows.map(({ timeline, ...z }) => z).sort((a, b) => (b.queries ?? -1) - (a.queries ?? -1)), errors, fetched_at: new Date(now).toISOString() };
}

const raw = (zone) => [...LAST.entries()].filter(([k]) => !zone || k.startsWith(`${zone}|`)).map(([, v]) => v);
const clearCache = () => { CACHE.clear(); LAST.clear(); ZONES = null; };

module.exports = { listZones, zoneStats, allStats, raw, clearCache, friendly, CfError, RANGES, PARTS, NO_PERMISSION, query };
