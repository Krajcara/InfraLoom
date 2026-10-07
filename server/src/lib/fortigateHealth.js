'use strict';

// Health of a FortiGate itself, over the same read-only REST API token used for switch/AP sync: CPU/memory/sessions, HA,
// IPsec tunnels, FortiGuard/FortiCare licences and SD-WAN health checks. Every section is fetched on its own, so one that
// this FortiOS version does not offer (404) or the token may not read (403) never takes the others down; the raw reply of
// every section is kept so a field that does not look right can be checked against what the device really said.
//
// The parsers are deliberately forgiving about shape (FortiOS differs between versions) and are exported for testing.

const axios = require('axios');
const https = require('https');

const httpsAgent = new https.Agent({ rejectUnauthorized: false });
const RAW_LIMIT = 24000; // characters kept per section

const client = (router) =>
  axios.create({ baseURL: `https://${router.ip_address}`, httpsAgent, timeout: 15000, headers: { Authorization: `Bearer ${router.api_token}` } });

const num = (v) => {
  if (typeof v === 'number' && Number.isFinite(v)) return v;
  if (typeof v === 'string' && v.trim() !== '' && Number.isFinite(Number(v))) return Number(v);
  return null;
};

/** A reading can be a number, [number], [{current}] or {current} depending on the FortiOS version. */
function pick(v) {
  if (Array.isArray(v)) return pick(v[0]);
  if (v && typeof v === 'object') return num(v.current ?? v.value ?? v.usage ?? null);
  return num(v);
}

function parseResources(results) {
  const r = Array.isArray(results) ? results[0] : results;
  if (!r || typeof r !== 'object') return null;
  const out = { cpu: pick(r.cpu), memory: pick(r.mem ?? r.memory), disk: pick(r.disk), sessions: pick(r.session ?? r.sessions) };
  return Object.values(out).every((v) => v === null) ? null : out;
}

function parseHa(peers, cmdb) {
  const c = Array.isArray(cmdb) ? cmdb[0] : cmdb;
  const list = Array.isArray(peers) ? peers : [];
  const mode = c && typeof c === 'object' && c.mode ? String(c.mode) : null;
  if (mode === 'standalone' || (!mode && list.length === 0)) return { mode: 'standalone', members: [], count: 1 };
  const members = list.map((p) => ({
    serial: p.serial_no || p.serial || null, hostname: p.hostname || p.name || null, priority: num(p.priority), role: p.role || p.status || null,
  }));
  return { mode: mode || 'ha', members, count: members.length + 1 }; // the peers, plus this unit
}

/** tunnels: [{ name, state: 'up'|'partial'|'down', up, total }] */
function parseIpsec(monitor, phase1 = null) {
  const list = Array.isArray(monitor) ? monitor : [];
  const configured = Array.isArray(phase1)
    ? new Map(phase1.map((p) => [String(p.name), { type: String(p.type || 'static'), disabled: String(p.status || 'enable') === 'disable' }]))
    : null;
  const byName = new Map();
  for (const t of list) {
    const name = String(t.name || t.tunnel_name || '').trim();
    if (!name) continue;
    const ids = Array.isArray(t.proxyid) ? t.proxyid : [];
    const up = ids.filter((p) => String(p.status || '').toLowerCase() === 'up').length;
    byName.set(name, { name, up, total: ids.length });
  }
  // a tunnel that has never come up is not listed at all — but it is configured, and it is down
  if (configured) for (const [name, c] of configured) if (!byName.has(name) && c.type !== 'dynamic' && !c.disabled) byName.set(name, { name, up: 0, total: 0 });

  const out = [];
  for (const t of byName.values()) {
    if (configured) {
      const c = configured.get(t.name);
      if (c && (c.type === 'dynamic' || c.disabled)) continue;       // dial-up templates and disabled tunnels
      if (!c && /_\d+$/.test(t.name)) continue;                       // an instance of a dial-up tunnel
    } else if (/_\d+$/.test(t.name)) continue;
    out.push({ ...t, state: t.up === 0 ? 'down' : t.total > 0 && t.up < t.total ? 'partial' : 'up' });
  }
  return out.sort((a, b) => a.name.localeCompare(b.name));
}

const EXPIRY_KEYS = ['expires', 'expiry', 'expire', 'expiration', 'expire_date', 'expiry_date', 'expires_at', 'expiration_date', 'support_expiry_date', 'contract_expiry'];

function toMs(v) {
  if (typeof v === 'number' && Number.isFinite(v) && v > 0) return v > 1e12 ? v : v * 1000;       // epoch seconds or milliseconds
  if (typeof v === 'string' && v.trim() && !/^0+$/.test(v.trim())) {
    if (/^\d+$/.test(v.trim())) return toMs(Number(v));
    const t = Date.parse(v);
    return Number.isNaN(t) ? null : t;
  }
  return null;
}

/** Finds every entitlement with an expiry date, wherever it sits in the reply. Entries without a date (features that were
 * never licensed, perpetual ones) are ignored — they must not raise alerts. */
function parseLicences(results, now = Date.now()) {
  const out = [];
  const seen = new Set();
  (function walk(node, path, depth) {
    if (!node || typeof node !== 'object' || depth > 7) return;
    if (!Array.isArray(node)) {
      for (const k of EXPIRY_KEYS) {
        const ms = toMs(node[k]);
        if (ms) {
          const name = path.filter(Boolean).join(' / ') || 'licence';
          if (!seen.has(name)) {
            seen.add(name);
            const days = Math.floor((ms - now) / 86400000);
            if (days < 3650) out.push({ name, expires_at: new Date(ms).toISOString(), days_left: days, status: String(node.status || node.entitlement || node.state || '') || null });
          }
          break;
        }
      }
    }
    const entries = Array.isArray(node) ? node.map((v, i) => [v && (v.name || v.type || v.id) ? String(v.name || v.type || v.id) : String(i), v]) : Object.entries(node);
    for (const [k, v] of entries) if (v && typeof v === 'object') walk(v, path.concat(k), depth + 1);
  })(results, [], 0);
  return out.sort((a, b) => a.days_left - b.days_left);
}

/** [{ name: 'check/member', state: 'up'|'down' }] — any node that carries a status of up/alive or down/dead */
function parseSdwan(results) {
  const out = [];
  (function walk(node, path, depth) {
    if (!node || typeof node !== 'object' || depth > 6) return;
    const s = !Array.isArray(node) && typeof node.status === 'string' ? node.status.toLowerCase() : null;
    if (s && path.length && /^(up|alive|down|dead)$/.test(s)) out.push({ name: path.join(' / '), state: /^(up|alive)$/.test(s) ? 'up' : 'down' });
    const entries = Array.isArray(node)
      ? node.map((v, i) => [v && (v.name || v.interface || v.health_check) ? String(v.name || v.interface || v.health_check) : String(i), v])
      : Object.entries(node);
    for (const [k, v] of entries) if (v && typeof v === 'object') walk(v, path.concat(k), depth + 1);
  })(results, [], 0);
  return out;
}

// ── FortiLink-managed switches and FortiAPs ─────────────────────────────────
// Read through the FortiGate that manages them (no route to the FortiLink network, no SNMP). Shapes below are the real replies of
// FortiOS 7.4.12: managed-switch/health is an object keyed by the switch name; managed_ap is an array.

/** 'ok' | 'warn' | 'crit' for FortiGate's own ratings ("good", "fair", "poor"...). An unknown word is a warning, not silence. */
function ratingLevel(r) {
  const s = String(r ?? '').trim().toLowerCase();
  if (!s || s === 'good' || s === 'ok') return 'ok';
  if (/fair|moderate|medium|warn|degrad/.test(s)) return 'warn';
  if (/poor|bad|crit|severe|fail/.test(s)) return 'crit';
  return 'warn';
}

const clip = (v) => { const s = JSON.stringify(v); return s && s.length > RAW_LIMIT ? `${s.slice(0, RAW_LIMIT)}…(truncated)` : s; };
const notGood = (rating) => ratingLevel(rating) !== 'ok';

function uptimeSeconds(u) {
  if (!u || typeof u !== 'object') return null;
  const parts = [['days', 86400], ['hours', 3600], ['minutes', 60]].map(([k, m]) => (num(u[k]?.value) ?? 0) * m);
  return parts.reduce((a, b) => a + b, 0);
}

function parseSwitchHealth(results) {
  if (!results || typeof results !== 'object' || Array.isArray(results)) return [];
  const out = [];
  for (const [key, h] of Object.entries(results)) {
    if (!h || typeof h !== 'object') continue;
    const perf = h['performance-status'] || {};
    const sum = h.summary || {};
    const idle = num(perf.cpu?.idle?.value);
    const temps = (Array.isArray(h.temperature) ? h.temperature : []).map((t) => num(t?.status?.value ?? t?.value)).filter((v) => v !== null);
    const poeMax = num(h.poe?.max_value), poeUsed = num(h.poe?.value);
    const bad = [];
    for (const [k, v] of Object.entries(sum)) {
      if (k === 'overall') continue;
      const r = v?.rating ?? (v && typeof v === 'object' ? Object.values(v).map((x) => x?.rating).find((x) => x !== undefined) : undefined);
      if (r !== undefined && notGood(r)) bad.push(`${k}: ${r}`);
    }
    out.push({
      key,
      cpu: num(sum.cpu?.value) ?? (idle !== null ? 100 - idle : null),
      memory: num(sum.memory?.value) ?? num(perf.memory?.used?.value),
      temperature: temps.length ? Math.max(...temps) : null,
      uptime_s: num(sum.uptime?.value) ?? uptimeSeconds(perf.uptime),
      fans: (Array.isArray(h['fan-status']) ? h['fan-status'] : []).map((f) => ({ name: String(f.module || 'fan'), status: String(f.status ?? ''), speed: num(f.speed?.value) })),
      psu: (Array.isArray(h['psu-status']) ? h['psu-status'] : []).map((p, i) => ({ name: String(p.module || p.name || `psu${i + 1}`), status: String(p.status ?? '') })),
      poe: poeMax > 0 && poeUsed !== null ? { used_w: poeUsed, max_w: poeMax, pct: Math.round((poeUsed / poeMax) * 1000) / 10 } : null,
      overall: typeof sum.overall === 'string' ? sum.overall : sum.overall?.rating ?? null,
      not_good: bad,
      raw: clip(h),
    });
  }
  return out;
}

function parseApHealth(results) {
  if (!Array.isArray(results)) return [];
  return results.map((a) => {
    const total = num(a.mem_total), free = num(a.mem_free);
    const up = Array.isArray(a.health?.general?.uplink_status) ? a.health.general.uplink_status[0] : null;
    const l = Array.isArray(a.lldp) ? a.lldp[0] : null;
    return {
      serial: a.serial || a.wtp_id || null,
      name: a.name || a.serial || null,
      state: a.connection_state || a.status || null,
      cpu: num(a.cpu_usage),
      memory: total > 0 && free !== null ? Math.round(((total - free) / total) * 100) : null,
      clients: num(a.clients),
      reboot_epoch: num(a.last_reboot_time_raw),
      os_version: a.os_version || null,
      overall: a.health?.general?.overall?.severity ?? a.health?.overall?.severity ?? null,
      uplink: up ? { mbps: num(up.value), severity: up.severity ?? null } : null,
      connected_to: l ? { switch: l.system_name || null, port: l.port_id || null, ip: l.ip || null } : null,
      last_failure: a.last_failure && a.last_failure !== 'N/A' ? a.last_failure : null,
      radios: (Array.isArray(a.radio) ? a.radio : []).filter((r) => r.mode && r.mode !== 'Not Exist').map((r) => ({
        id: r.radio_id, type: r.radio_type || null, channel: num(r.oper_chan), clients: num(r.client_count), utilization: num(r.channel_utilization_percent), health: r.health?.overall?.severity ?? null,
      })),
      raw: clip(a),
    };
  }).filter((a) => a.serial);
}

/** @returns {{ switches: {ok, error?, endpoint, data?}, aps: {ok, error?, endpoint, data?} }} — each read on its own */
async function fetchManagedHealth(router) {
  if (!router.api_token) throw new Error('This router has no API token configured');
  const api = client(router);
  const one = async (endpoint, parse) => {
    try { return { ok: true, endpoint, data: parse(await get(api, endpoint)) }; }
    catch (err) { return { ok: false, endpoint, error: describeError(err) }; }
  };
  const [switches, aps] = await Promise.all([
    one('/api/v2/monitor/switch-controller/managed-switch/health', parseSwitchHealth),
    one('/api/v2/monitor/wifi/managed_ap', parseApHealth),
  ]);
  return { switches, aps };
}

function describeError(err) {
  const s = err.response?.status;
  if (s === 401 || s === 403) return `HTTP ${s} — the token was rejected or its admin profile cannot read this`;
  if (s === 404) return '404 — not available on this FortiOS version';
  if (err.code === 'ECONNABORTED') return 'no answer within 15 s';
  return err.message;
}

const rawOf = (data) => {
  const s = JSON.stringify(data);
  return s && s.length > RAW_LIMIT ? `${s.slice(0, RAW_LIMIT)}…(truncated)` : s;
};

async function get(api, path) {
  const res = await api.get(path, { params: { vdom: 'root' } });
  return res.data?.results;
}

/** @returns {{ sections: { [name]: { ok, error?, endpoint, data?, raw? } } }} */
async function fetchHealth(router) {
  if (!router.api_token) throw new Error('This router has no API token configured');
  const api = client(router);
  const sections = {};
  const section = async (name, fn) => {
    try {
      sections[name] = { ok: true, ...(await fn()) };
    } catch (err) {
      sections[name] = { ok: false, error: describeError(err), endpoint: err.endpoint || null };
    }
  };

  await section('resources', async () => {
    const endpoint = '/api/v2/monitor/system/resource/usage';
    const results = await get(api, endpoint).catch((e) => { e.endpoint = endpoint; throw e; });
    const data = parseResources(results);
    if (!data) throw Object.assign(new Error('the reply held no CPU/memory figures'), { endpoint });
    return { endpoint, data, raw: rawOf(results) };
  });

  await section('ha', async () => {
    const endpoint = '/api/v2/monitor/system/ha-peer';
    const [peers, cmdb] = await Promise.all([
      get(api, endpoint),
      get(api, '/api/v2/cmdb/system/ha').catch(() => null),
    ]);
    return { endpoint, data: parseHa(peers, cmdb), raw: rawOf({ peers, cmdb }) };
  });

  await section('ipsec', async () => {
    const endpoint = '/api/v2/monitor/vpn/ipsec';
    const [monitor, phase1] = await Promise.all([
      get(api, endpoint),
      get(api, '/api/v2/cmdb/vpn.ipsec/phase1-interface').catch(() => null),
    ]);
    return { endpoint, data: parseIpsec(monitor, phase1), raw: rawOf({ monitor, phase1 }) };
  });

  await section('licenses', async () => {
    const endpoint = '/api/v2/monitor/license/status';
    const results = await get(api, endpoint);
    return { endpoint, data: parseLicences(results), raw: rawOf(results) };
  });

  await section('sdwan', async () => {
    const endpoint = '/api/v2/monitor/virtual-wan/health-check';
    const results = await get(api, endpoint);
    return { endpoint, data: parseSdwan(results), raw: rawOf(results) };
  });

  return { sections };
}

module.exports = { fetchHealth, fetchManagedHealth, parseResources, parseHa, parseIpsec, parseLicences, parseSdwan, parseSwitchHealth, parseApHealth, ratingLevel, describeError };
