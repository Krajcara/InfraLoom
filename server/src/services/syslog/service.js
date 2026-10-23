'use strict';

// Firewall logs received as syslog (UDP and/or TCP): the traffic is summed up by the hour, the security events are recognised, kept and — when they matter —
// announced, and the silence of a firewall that stops sending is noticed. Only sources that are known (FortiGates of the router list, and the addresses given) are accepted.

const dgram = require('node:dgram');
const net = require('node:net');
const cron = require('node-cron');
const db = require('../../db/database');
const { parseLine, eventSeconds } = require('./parser');
const { classify, trafficOf } = require('./rules');
const { Aggregator, toRow, combine, DIMS } = require('./aggregate');

class ConfigError extends Error {}
const DEFAULTS = { enabled: 0, udp_port: 5140, tcp_port: 0, allowed_sources: '', event_days: 90, hourly_days: 400, fail_count: 3, fail_window_minutes: 10, silent_minutes: 15, notify_admin_login: 0, notify_config_change: 1, notify_ips: 1, notify_vpn_failed: 1, notify_system: 1 };
const LIMITS = { udp_port: [1, 65535], tcp_port: [0, 65535], event_days: [7, 365], hourly_days: [30, 1100], fail_count: [2, 50], fail_window_minutes: [1, 60], silent_minutes: [2, 240] };
const FLAGS = ['enabled', 'notify_admin_login', 'notify_config_change', 'notify_ips', 'notify_vpn_failed', 'notify_system'];
const EVENT_CAP_PER_MIN = 200;   // per kind: a flood of one kind of event does not fill the table
const LINE_MAX = 16384;

const norm = (ip) => String(ip || '').replace(/^::ffff:/i, '');
const kv = (key) => db.prepare('SELECT value FROM syslog_config WHERE key = ?').get(key)?.value;
const setKv = (key, value) => db.prepare('INSERT INTO syslog_config (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value').run(key, String(value));

function getConfig() {
  const out = { ...DEFAULTS };
  for (const r of db.prepare("SELECT key, value FROM syslog_config WHERE key NOT LIKE 'seen:%' AND key NOT LIKE 'silent:%'").all()) {
    if (!(r.key in DEFAULTS)) continue;
    out[r.key] = r.key === 'allowed_sources' ? r.value : Number(r.value);
  }
  return out;
}
function saveConfig(body = {}) {
  const next = { ...getConfig() };
  for (const k of FLAGS) if (body[k] !== undefined) { if (typeof body[k] !== 'boolean') throw new ConfigError(`${k} must be true or false`); next[k] = body[k] ? 1 : 0; }
  for (const [k, [lo, hi]] of Object.entries(LIMITS)) {
    if (body[k] === undefined) continue;
    const n = Number(body[k]);
    if (!Number.isInteger(n) || n < lo || n > hi) throw new ConfigError(`${k.replace(/_/g, ' ')} must be a whole number from ${lo} to ${hi}`);
    next[k] = n;
  }
  if (body.allowed_sources !== undefined) {
    const list = String(body.allowed_sources).split(/[\s,;]+/).filter(Boolean);
    const bad = list.find((x) => !net.isIP(x));
    if (bad) throw new ConfigError(`“${bad}” is not an IP address`);
    if (list.length > 50) throw new ConfigError('At most 50 addresses');
    next.allowed_sources = [...new Set(list)].join(', ');
  }
  if (next.enabled && next.udp_port === 0 && !next.tcp_port) throw new ConfigError('Give a UDP or a TCP port');
  db.transaction(() => { for (const [k, v] of Object.entries(next)) setKv(k, v); })();
  allowCache.at = 0;
  return next;
}

/** The addresses that may send: the FortiGates of the router list, and the ones given by hand. */
let allowCache = { at: 0, set: null };
function allowedSources(fresh = false) {
  if (!fresh && allowCache.set && Date.now() - allowCache.at < 2000) return allowCache.set;
  const set = new Set(getConfig().allowed_sources.split(/[\s,;]+/).filter(Boolean));
  for (const r of db.prepare("SELECT ip_address FROM routers WHERE LOWER(brand) = 'fortigate'").all()) {
    const h = String(r.ip_address || '').replace(/:\d+$/, '').trim(); if (net.isIP(h)) set.add(h);
  }
  allowCache = { at: Date.now(), set };
  return set;
}

// ── state ─────────────────────────────────────────────────────────────

const agg = new Aggregator();
const counters = { received: 0, parsed: 0, unparsed: 0, rejected: 0, events: 0, events_dropped: 0 };
const rejectedBy = new Map();
const seen = new Map();                 // device → { last (ms), ip }
const silent = new Set();
const windows = new Map();              // burst key → [{ t, user }]
const throttle = new Map();             // key → ms of the last alert
const groups = new Map();               // config changes of one person on one device, to be said once
const perMinute = new Map();            // kind → { minute, n }
const hourlyAlerts = new Map();         // device → { hour, n }
const rate = [];                        // received per minute, the last 10
let startedAt = Date.now(); let lastMinute = 0;

const notifyDefault = async (event, message) => require('../notificationService').notify(message, event);
const throttled = (key, ms, nowMs) => { const t = throttle.get(key); if (t && nowMs - t < ms) return true; throttle.set(key, nowMs); if (throttle.size > 5000) for (const [k, v] of throttle) if (nowMs - v > 3600_000) throttle.delete(k); return false; };
const loader = (device, hour) => {
  const r = db.prepare('SELECT * FROM syslog_hourly WHERE device = ? AND hour = ?').get(device, hour);
  return r || null;
};
const statMem = new Map(); // device|hour → what arrived since it was last written
const stat = (device, sec, field) => {
  const hour = Math.floor(sec / 3600) * 3600; const k = `${device}|${hour}`;
  const e = statMem.get(k) || { device, hour, received: 0, unparsed: 0 }; e[field] += 1; statMem.set(k, e);
};
function flushStats() {
  const put = db.prepare('INSERT INTO syslog_stats (device, hour, received, unparsed) VALUES (@device, @hour, @received, @unparsed) ON CONFLICT(device, hour) DO UPDATE SET received = received + excluded.received, unparsed = unparsed + excluded.unparsed');
  const rows = [...statMem.values()]; statMem.clear();
  db.transaction(() => { for (const r of rows) put.run(r); })();
}

function recordEvent(device, sec, c, raw, nowMs) {
  const minute = Math.floor(nowMs / 60000); const pm = perMinute.get(c.kind) || { minute, n: 0 };
  if (pm.minute !== minute) { pm.minute = minute; pm.n = 0; } pm.n += 1; perMinute.set(c.kind, pm);
  if (pm.n > EVENT_CAP_PER_MIN) { counters.events_dropped += 1; return false; }
  db.prepare('INSERT INTO syslog_events (ts, device, kind, level, summary, user, srcip, raw) VALUES (?, ?, ?, ?, ?, ?, ?, ?)').run(sec, device, c.kind, c.level, c.summary, c.user || null, c.srcip || null, raw.slice(0, 1500));
  counters.events += 1; return true;
}

/** What to tell people about an event: a burst of failed logins, a change of the configuration, an attack, a system event. */
async function announce(device, c, f, nowMs, cfg, notifier) {
  const say = async (event, text) => { try { await notifier(event, text); } catch (e) { console.error('[syslog] notify failed:', e.message); } };
  const hour = Math.floor(nowMs / 3600_000);
  const cap = () => { const h = hourlyAlerts.get(device) || { hour, n: 0 }; if (h.hour !== hour) { h.hour = hour; h.n = 0; } h.n += 1; hourlyAlerts.set(device, h); return h.n <= 10; }; // never more than ten attack alerts an hour per firewall

  if (c.kind === 'admin_login_failed' || c.kind === 'vpn_login_failed') {
    if (c.kind === 'vpn_login_failed' && !cfg.notify_vpn_failed) return;
    const key = `${device}|${c.kind}|${c.srcip || '?'}`; const win = cfg.fail_window_minutes * 60000;
    const arr = (windows.get(key) || []).filter((x) => nowMs - x.t < win); arr.push({ t: nowMs, user: c.user || '?' }); windows.set(key, arr);
    if (windows.size > 5000) for (const [k, v] of windows) if (!v.length || nowMs - v[v.length - 1].t > win) windows.delete(k);
    if (arr.length >= cfg.fail_count && !throttled(key, 30 * 60000, nowMs)) {
      const users = [...new Set(arr.map((x) => x.user))].slice(0, 5).join(', ');
      await say(c.kind === 'admin_login_failed' ? 'fw_admin_login_failed' : 'fw_vpn_login_failed', `${arr.length} failed ${c.kind === 'admin_login_failed' ? 'administrator' : 'VPN'} logins on ${device} from ${c.srcip || 'an unknown address'} in ${cfg.fail_window_minutes} min (user: ${users}).`);
    }
    return;
  }
  if (c.kind === 'admin_login' && cfg.notify_admin_login && !throttled(`${device}|login|${c.user}|${c.srcip}`, 10 * 60000, nowMs)) return say('fw_admin_login', `${c.summary} on ${device}.`);
  if (c.kind === 'config_change' && cfg.notify_config_change) {
    const key = `${device}|${c.user || '?'}`; const g = groups.get(key) || { device, user: c.user, first: nowMs, last: nowMs, items: [], ui: f.ui || null };
    g.last = nowMs; if (g.items.length < 200) g.items.push(f.cfgpath ? `${f.cfgpath}${f.cfgobj ? ` ${f.cfgobj}` : ''}${f.cfgattr ? ` (${String(f.cfgattr).slice(0, 60)})` : ''}` : c.summary); groups.set(key, g); return;
  }
  if ((c.kind === 'ips' || c.kind === 'malware') && cfg.notify_ips && c.level !== 'info' && !throttled(`${device}|${c.kind}|${c.attack}`, 3600_000, nowMs) && cap()) return say('fw_ips', `${c.summary} (${device}).`);
  if (c.kind === 'system_event' && cfg.notify_system && !throttled(`${device}|sys|${c.summary.slice(0, 60)}`, 10 * 60000, nowMs)) return say('fw_system', `${device}: ${c.summary}`);
}

/** One log line (or one datagram) from `remoteIp`. Returns what became of it. */
async function ingest(input, remoteIp, nowMs = Date.now(), { notifier = notifyDefault } = {}) {
  const ip = norm(remoteIp); const sec = Math.floor(nowMs / 1000);
  if (!allowedSources().has(ip)) { counters.rejected += 1; rejectedBy.set(ip, (rejectedBy.get(ip) || 0) + 1); if (rejectedBy.size > 200) rejectedBy.delete(rejectedBy.keys().next().value); return 'rejected'; }
  counters.received += 1;
  const p = parseLine(input);
  if (!p) { counters.unparsed += 1; stat(`ip:${ip}`, sec, 'unparsed'); return 'unparsed'; }
  counters.parsed += 1;
  const f = p.fields; const device = String(f.devname || f.devid || ip).slice(0, 60);
  const prev = seen.get(device); seen.set(device, { last: nowMs, ip });
  stat(device, sec, 'received');
  if (silent.delete(device) || (prev === undefined && kv(`silent:${device}`) === '1')) { db.prepare('DELETE FROM syslog_config WHERE key = ?').run(`silent:${device}`); await announceRaw('fw_log_resumed', `${device} is sending logs again.`, notifier); }
  const ts = eventSeconds(f, sec);
  const t = trafficOf(f);
  if (t) agg.add(device, ts, t, loader);
  const c = classify(f);
  if (c) {
    const raw = (Buffer.isBuffer(input) ? input.toString('utf8') : String(input)).trim();
    if (recordEvent(device, ts, c, raw, nowMs)) await announce(device, c, f, nowMs, getConfig(), notifier);
  }
  return 'ok';
}
async function announceRaw(event, text, notifier) { try { await notifier(event, text); } catch (e) { console.error('[syslog] notify failed:', e.message); } }

// ── what is done now and then ─────────────────────────────────────────

function persist(rows) {
  const put = db.prepare('INSERT INTO syslog_hourly (device, hour, sessions, blocked, bytes_out, bytes_in, top) VALUES (@device, @hour, @sessions, @blocked, @bytes_out, @bytes_in, @top) ON CONFLICT(device, hour) DO UPDATE SET sessions = excluded.sessions, blocked = excluded.blocked, bytes_out = excluded.bytes_out, bytes_in = excluded.bytes_in, top = excluded.top');
  db.transaction(() => { for (const r of rows) put.run(r); })();
}

/** Every few seconds: hours that are over are written, the hour that goes on is written too (so a restart loses little), config changes are said, silence is noticed. */
async function tick(nowMs = Date.now(), { notifier = notifyDefault } = {}) {
  const sec = Math.floor(nowMs / 1000); const cfg = getConfig();
  persist(agg.take(sec).map(toRow)); persist(agg.live().map(toRow)); flushStats();
  for (const [key, g] of groups) {
    if (nowMs - g.last < 120_000 && nowMs - g.first < 600_000) continue;
    groups.delete(key);
    const list = [...new Set(g.items)]; const shown = list.slice(0, 6).join('; ');
    await announceRaw('fw_config_change', `Configuration of ${g.device} was changed${g.user ? ` by ${g.user}` : ''}${g.ui ? ` (${g.ui})` : ''}: ${g.items.length} change${g.items.length === 1 ? '' : 's'} — ${shown}${list.length > 6 ? `; and ${list.length - 6} more` : ''}.`, notifier);
  }
  const minute = Math.floor(nowMs / 60000);
  if (minute !== lastMinute) {
    lastMinute = minute;
    rate.push(counters.received); if (rate.length > 11) rate.shift();
    for (const [device, s] of seen) setKv(`seen:${device}`, `${s.last}|${s.ip}`);
    if (nowMs - startedAt > cfg.silent_minutes * 60000 * 0.5 || nowMs - startedAt > 120_000) {
      for (const [device, s] of seen) {
        if (silent.has(device) || nowMs - s.last <= cfg.silent_minutes * 60000) continue;
        silent.add(device); setKv(`silent:${device}`, '1');
        await announceRaw('fw_log_silent', `No logs from ${device} for ${Math.round((nowMs - s.last) / 60000)} min (the last one came at ${new Date(s.last).toLocaleTimeString()}). Check that the firewall still sends syslog to this server.`, notifier);
      }
    }
  }
}

function purge(nowSec = Math.floor(Date.now() / 1000)) {
  const cfg = getConfig();
  return {
    events: db.prepare('DELETE FROM syslog_events WHERE ts < ?').run(nowSec - cfg.event_days * 86400).changes,
    hourly: db.prepare('DELETE FROM syslog_hourly WHERE hour < ?').run(nowSec - cfg.hourly_days * 86400).changes,
    stats: db.prepare('DELETE FROM syslog_stats WHERE hour < ?').run(nowSec - 30 * 86400).changes,
  };
}

// ── what is shown ─────────────────────────────────────────────────────

const RANGE = { '1h': 3600, '24h': 86400, '7d': 7 * 86400, '30d': 30 * 86400, '1y': 365 * 86400 };

function summary(range = '24h', device = null, nowSec = Math.floor(Date.now() / 1000)) {
  const span = RANGE[range]; if (!span) throw new ConfigError(`Range must be one of ${Object.keys(RANGE).join(', ')}`);
  const from = nowSec - span; const live = agg.live(device || undefined); const liveKey = new Set(live.map((b) => `${b.device}|${b.hour}`));
  const rows = db.prepare(`SELECT * FROM syslog_hourly WHERE hour + 3600 > ?${device ? ' AND device = ?' : ''} ORDER BY hour`).all(...(device ? [from, device] : [from])).filter((r) => !liveKey.has(`${r.device}|${r.hour}`));
  const all = [...rows, ...live.filter((b) => b.hour + 3600 > from)];
  const bucket = span <= 86400 * 2 ? 3600 : 86400; const line = new Map();
  for (const r of all) { const t = Math.floor(r.hour / bucket) * bucket; const e = line.get(t) || { ts: t, bytes: 0, sessions: 0, blocked: 0 }; e.bytes += r.bytes_out + r.bytes_in; e.sessions += r.sessions; e.blocked += r.blocked; line.set(t, e); }
  const events = db.prepare(`SELECT kind, level, COUNT(*) AS n FROM syslog_events WHERE ts >= ?${device ? ' AND device = ?' : ''} GROUP BY kind, level`).all(...(device ? [from, device] : [from]));
  const devices = [...new Set([...db.prepare('SELECT DISTINCT device FROM syslog_hourly WHERE hour + 3600 > ?').all(from).map((r) => r.device), ...agg.live().map((b) => b.device)])].sort();
  return { range, from, to: nowSec, device: device || null, devices, ...combine(all, 10), timeline: [...line.values()].sort((a, b) => a.ts - b.ts), bucket, events };
}

function events({ limit = 100, kind = null, level = null, q = null, before = null, device = null } = {}) {
  const where = []; const args = [];
  if (kind) { where.push('kind = ?'); args.push(kind); } if (level) { where.push('level = ?'); args.push(level); } if (device) { where.push('device = ?'); args.push(device); }
  if (before) { where.push('id < ?'); args.push(Number(before)); }
  if (q) { where.push("(summary LIKE ? ESCAPE '\\' OR user LIKE ? ESCAPE '\\' OR srcip LIKE ? ESCAPE '\\')"); const like = `%${String(q).replace(/[\\%_]/g, (m) => `\\${m}`)}%`; args.push(like, like, like); }
  const n = Math.min(Math.max(Number(limit) || 100, 1), 500);
  return db.prepare(`SELECT id, ts, device, kind, level, summary, user, srcip, raw FROM syslog_events ${where.length ? `WHERE ${where.join(' AND ')}` : ''} ORDER BY id DESC LIMIT ?`).all(...args, n);
}

// ── listening ─────────────────────────────────────────────────────────

const net_ = { udp: null, tcp: null, errors: {}, tcpSockets: new Set() };
const handleDatagram = (msg, rinfo) => { for (const line of msg.toString('utf8').split('\n')) if (line.trim()) ingest(line, rinfo.address).catch((e) => console.error('[syslog]', e.message)); };

function listen() {
  const cfg = getConfig(); net_.errors = {};
  if (!cfg.enabled) return;
  if (cfg.udp_port) {
    const s = dgram.createSocket({ type: 'udp4', reuseAddr: false });
    s.on('message', handleDatagram);
    s.on('error', (e) => { net_.errors.udp = e.code === 'EADDRINUSE' ? `UDP port ${cfg.udp_port} is in use by another program` : e.code === 'EACCES' ? `UDP port ${cfg.udp_port} needs more privileges than this service has (use a port above 1023)` : e.message; try { s.close(); } catch { /* closed */ } if (net_.udp === s) net_.udp = null; });
    s.bind(cfg.udp_port, '0.0.0.0', () => { net_.udp = s; });
  }
  if (cfg.tcp_port) {
    const srv = net.createServer((sock) => {
      const ip = norm(sock.remoteAddress); let buf = '';
      net_.tcpSockets.add(sock); sock.setTimeout(600_000, () => sock.destroy()); sock.on('close', () => net_.tcpSockets.delete(sock)); sock.on('error', () => {});
      sock.on('data', (d) => {
        buf += d.toString('utf8');
        let i; while ((i = buf.indexOf('\n')) >= 0) { const line = buf.slice(0, i); buf = buf.slice(i + 1); if (line.trim()) ingest(line, ip).catch((e) => console.error('[syslog]', e.message)); }
        if (buf.length > LINE_MAX) buf = '';
      });
    });
    srv.on('error', (e) => { net_.errors.tcp = e.code === 'EADDRINUSE' ? `TCP port ${cfg.tcp_port} is in use by another program` : e.code === 'EACCES' ? `TCP port ${cfg.tcp_port} needs more privileges than this service has (use a port above 1023)` : e.message; });
    srv.listen(cfg.tcp_port, '0.0.0.0', () => { net_.tcp = srv; });
  }
}
function unlisten() {
  if (net_.udp) { try { net_.udp.close(); } catch { /* closed */ } net_.udp = null; }
  if (net_.tcp) { try { net_.tcp.close(); } catch { /* closed */ } net_.tcp = null; }
  for (const s of net_.tcpSockets) s.destroy(); net_.tcpSockets.clear();
}

function status() {
  const cfg = getConfig(); const now = Date.now();
  const perMin = rate.length >= 2 ? Math.round((rate[rate.length - 1] - rate[0]) / (rate.length - 1)) : 0;
  return {
    enabled: !!cfg.enabled,
    udp: { port: cfg.udp_port, listening: !!net_.udp, error: net_.errors.udp || null }, tcp: { port: cfg.tcp_port, listening: !!net_.tcp, error: net_.errors.tcp || null },
    counters: { ...counters }, per_minute: perMin,
    rejected: [...rejectedBy].sort((a, b) => b[1] - a[1]).slice(0, 5).map(([ip, n]) => ({ ip, n })),
    devices: [...seen].map(([device, s]) => ({ device, ip: s.ip, last_seen: new Date(s.last).toISOString(), seconds_ago: Math.round((now - s.last) / 1000), silent: silent.has(device) })).sort((a, b) => a.device.localeCompare(b.device)),
    allowed: [...allowedSources(true)],
  };
}

/** Writes what is only in memory (the hour that goes on, the counters); done when the service stops, so that a restart loses nothing. */
function flushNow() { try { persist(agg.live().map(toRow)); flushStats(); } catch (e) { console.error('[syslog] final write failed:', e.message); } }
let exitHooked = false;

let tasks = []; let timer = null;
function stop() { tasks.forEach((t) => t.stop()); tasks = []; if (timer) { clearInterval(timer); timer = null; } unlisten(); }
function start() {
  stop(); startedAt = Date.now(); lastMinute = 0;
  if (!exitHooked) { exitHooked = true; process.on('exit', flushNow); } // the server ends with process.exit() on SIGTERM, so this is run when it is stopped or restarted
  for (const r of db.prepare("SELECT key, value FROM syslog_config WHERE key LIKE 'seen:%'").all()) { const [t, ip] = r.value.split('|'); if (Number(t) > 0) seen.set(r.key.slice(5), { last: Number(t), ip }); }
  for (const r of db.prepare("SELECT key FROM syslog_config WHERE key LIKE 'silent:%'").all()) silent.add(r.key.slice(7));
  listen();
  timer = setInterval(() => tick().catch((e) => console.error('[syslog] tick failed:', e.message)), 10_000); timer.unref?.();
  tasks.push(cron.schedule('20 3 * * *', () => { try { purge(); } catch (e) { console.error('[syslog] purge failed:', e.message); } }));
}
const initScheduler = start; const reload = start;
function resetForTests() { allowCache = { at: 0, set: null }; statMem.clear(); agg.buckets.clear(); for (const m of [rejectedBy, seen, windows, throttle, groups, perMinute, hourlyAlerts]) m.clear(); silent.clear(); Object.assign(counters, { received: 0, parsed: 0, unparsed: 0, rejected: 0, events: 0, events_dropped: 0 }); rate.length = 0; lastMinute = 0; startedAt = Date.now(); }

module.exports = { flushNow, getConfig, saveConfig, ingest, tick, purge, summary, events, status, start, stop, reload, initScheduler, allowedSources, resetForTests, ConfigError, DEFAULTS, RANGE, DIMS };
