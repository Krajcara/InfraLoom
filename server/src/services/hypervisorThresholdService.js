'use strict';

// Usage thresholds for hypervisors: CPU, RAM and system disk of every node, every Proxmox storage, plus "storage is not
// active" and "node is offline". Fed by the metrics collector (every couple of minutes) with the data it already fetched.
//
// An alert fires when a value has been over a level for CONFIRM samples in a row, and not on every sample: a single spike
// does nothing, a value flapping around the line does nothing, and once raised an alert is not repeated. A level clears only
// when the value falls HYST points below it. warn -> crit and "back to normal" notify; crit -> warn is silent.

const db = require('../db/database');

const HYST = 3;     // percentage points below a level before it clears
const CONFIRM = 2;  // consecutive samples at a new level before it counts

const DEFAULTS = {
  enabled: true,
  ignore_iso_only: true,   // storages that hold only ISO images / container templates: being full is not an incident
  ignore_storages: [],     // storage names to skip everywhere
  cpu: { enabled: true, warn: 90, crit: 98, minutes: 10 },   // average over `minutes`, not one sample
  memory: { enabled: true, warn: 90, crit: 97 },
  node_disk: { enabled: true, warn: 85, crit: 95 },
  storage: { enabled: true, warn: 85, crit: 95 },
  storage_inactive: { enabled: true },
  node_offline: { enabled: true },
};
const SETTING_KEY = 'hypervisor_thresholds';
const KINDS = ['cpu', 'memory', 'node_disk', 'storage', 'storage_inactive', 'node_offline'];
const EVENT_FOR = { warn: 'hypervisor_threshold_warning', crit: 'hypervisor_threshold_critical', ok: 'hypervisor_threshold_ok' };

// ── configuration ──────────────────────────────────────────────────────────

const isPct = (n) => Number.isFinite(n) && n >= 1 && n <= 100;

/** Merges a stored/submitted object over the defaults. With strict=true, anything wrong throws (used by the API). */
function sanitize(input, strict = false) {
  const src = input && typeof input === 'object' ? input : {};
  const out = JSON.parse(JSON.stringify(DEFAULTS));
  const bad = (msg) => { if (strict) throw new Error(msg); };

  if (typeof src.enabled === 'boolean') out.enabled = src.enabled;
  if (typeof src.ignore_iso_only === 'boolean') out.ignore_iso_only = src.ignore_iso_only;
  if (Array.isArray(src.ignore_storages)) {
    const list = src.ignore_storages.map((s) => String(s).trim()).filter(Boolean);
    if (list.length > 50 || list.some((s) => s.length > 100)) bad('ignore_storages: at most 50 names of up to 100 characters');
    else out.ignore_storages = list;
  } else if (src.ignore_storages !== undefined) bad('ignore_storages must be a list of names');

  for (const kind of ['cpu', 'memory', 'node_disk', 'storage']) {
    const s = src[kind];
    if (s === undefined) continue;
    if (typeof s.enabled === 'boolean') out[kind].enabled = s.enabled;
    const warn = s.warn === undefined ? out[kind].warn : Number(s.warn);
    const crit = s.crit === undefined ? out[kind].crit : Number(s.crit);
    if (!isPct(warn) || !isPct(crit)) bad(`${kind}: warning and critical levels must be between 1 and 100`);
    else if (warn >= crit) bad(`${kind}: the warning level must be lower than the critical level`);
    else { out[kind].warn = warn; out[kind].crit = crit; }
    if (kind === 'cpu' && s.minutes !== undefined) {
      const m = Number(s.minutes);
      if (!Number.isInteger(m) || m < 2 || m > 60) bad('cpu: minutes must be a whole number between 2 and 60');
      else out.cpu.minutes = m;
    }
  }
  for (const kind of ['storage_inactive', 'node_offline']) if (src[kind] && typeof src[kind].enabled === 'boolean') out[kind].enabled = src[kind].enabled;
  return out;
}

function getConfig() {
  const raw = db.prepare('SELECT value FROM settings WHERE key = ?').get(SETTING_KEY)?.value;
  try { return sanitize(raw ? JSON.parse(raw) : {}); } catch { return sanitize({}); }
}

function saveConfig(input) {
  const cfg = sanitize(input, true);
  db.prepare("INSERT INTO settings (key, value, updated_at) VALUES (?, ?, datetime('now')) ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = datetime('now')").run(SETTING_KEY, JSON.stringify(cfg));
  return cfg;
}

// ── the state machine ──────────────────────────────────────────────────────

function levelFor(value, th, prev = 'ok') {
  if (value >= th.crit || (prev === 'crit' && value >= th.crit - HYST)) return 'crit';
  if (value >= th.warn || ((prev === 'warn' || prev === 'crit') && value >= th.warn - HYST)) return 'warn';
  return 'ok';
}

/** Records one observation; returns { from, to } when the level actually changed (after confirmation), else null. */
function observe(connId, kind, subject, candidate, value, detail) {
  const row = db.prepare('SELECT * FROM hypervisor_threshold_state WHERE connection_id = ? AND kind = ? AND subject = ?').get(connId, kind, subject);
  const now = new Date().toISOString();
  if (!row) {
    db.prepare('INSERT INTO hypervisor_threshold_state (connection_id, kind, subject, level, pending_level, pending_count, value, detail, since, updated_at) VALUES (?,?,?,?,?,?,?,?,?,?)')
      .run(connId, kind, subject, 'ok', candidate === 'ok' ? null : candidate, candidate === 'ok' ? 0 : 1, value, detail, now, now);
    if (candidate !== 'ok' && CONFIRM <= 1) return commit(connId, kind, subject, 'ok', candidate, now);
    return null;
  }
  if (candidate === row.level) {
    db.prepare('UPDATE hypervisor_threshold_state SET pending_level = NULL, pending_count = 0, value = ?, detail = ?, updated_at = ? WHERE connection_id = ? AND kind = ? AND subject = ?')
      .run(value, detail, now, connId, kind, subject);
    return null;
  }
  const count = row.pending_level === candidate ? row.pending_count + 1 : 1;
  if (count >= CONFIRM) {
    db.prepare('UPDATE hypervisor_threshold_state SET value = ?, detail = ?, updated_at = ? WHERE connection_id = ? AND kind = ? AND subject = ?').run(value, detail, now, connId, kind, subject);
    return commit(connId, kind, subject, row.level, candidate, now);
  }
  db.prepare('UPDATE hypervisor_threshold_state SET pending_level = ?, pending_count = ?, value = ?, detail = ?, updated_at = ? WHERE connection_id = ? AND kind = ? AND subject = ?')
    .run(candidate, count, value, detail, now, connId, kind, subject);
  return null;
}

function commit(connId, kind, subject, from, to, now) {
  db.prepare('UPDATE hypervisor_threshold_state SET level = ?, pending_level = NULL, pending_count = 0, since = ? WHERE connection_id = ? AND kind = ? AND subject = ?').run(to, now, connId, kind, subject);
  return { from, to };
}

// ── wording ────────────────────────────────────────────────────────────────

const gb = (b) => (b / 1073741824).toFixed(1);

function describe(kind, subject, value, extra = {}, cfg = DEFAULTS) {
  const [node, storage] = subject.includes('/') ? subject.split('/') : [subject, null];
  switch (kind) {
    case 'cpu': return `node ${node}: CPU has averaged ${value}% over the last ${cfg.cpu.minutes} minutes`;
    case 'memory': return `node ${node}: memory usage is ${value}%`;
    case 'node_disk': return `node ${node}: system disk is ${value}% full`;
    case 'storage': return `storage "${storage || subject}"${extra.node ? ` on node ${extra.node}` : ''} is ${value}% full${extra.total ? ` (${gb(extra.total - extra.used)} GB free of ${gb(extra.total)} GB)` : ''}`;
    case 'storage_inactive': return `storage "${storage}" on node ${node} is not active (offline or unreachable)`;
    case 'node_offline': return `node ${node} is offline`;
    default: return `${kind} ${subject}`;
  }
}

function messageFor(conn, kind, level, detail, cfg) {
  const th = cfg[kind];
  const head = `Hypervisor "${conn.name}": ${detail}`;
  if (level === 'ok') return `${head} — back to normal.`;
  if (kind === 'storage_inactive' || kind === 'node_offline') return `${head}.`;
  return level === 'crit' ? `${head} — CRITICAL (level ${th.crit}%).` : `${head} — above the warning level of ${th.warn}%.`;
}

// ── evaluation ─────────────────────────────────────────────────────────────

const isoOnly = (content) => {
  const parts = String(content || '').split(',').map((s) => s.trim()).filter(Boolean);
  return parts.length > 0 && parts.every((p) => p === 'iso' || p === 'vztmpl');
};

/** @param nodes   the summary the metrics collector fetched (node, status, cpu_usage, mem_usage, disk_usage)
 *  @param storages Proxmox only: { items: [{node, storage, content, shared, enabled, active, total, used}], failedNodes: Set } or null */
async function evaluate(conn, nodes, storages = null) {
  const cfg = getConfig();
  if (!cfg.enabled) {
    db.prepare('DELETE FROM hypervisor_threshold_state').run(); // switched off: nothing stays "breached" forever
    return { transitions: [] };
  }
  if (!conn.enabled || conn.health_check_enabled === 0) return { transitions: [] }; // snoozed connections are not alerted on

  const seen = new Set();
  const out = []; // { kind, subject, from, to, detail }
  const run = (kind, subject, candidate, value, detail) => {
    seen.add(`${kind}|${subject}`);
    const t = observe(conn.id, kind, subject, candidate, value, detail);
    if (t) out.push({ kind, subject, ...t, detail });
  };

  for (const n of nodes) {
    if (cfg.node_offline.enabled) run('node_offline', n.node, n.status === 'online' ? 'ok' : 'crit', n.status === 'online' ? 1 : 0, describe('node_offline', n.node, 0));
    if (n.status !== 'online') {
      // keep the node's other states as they are while it is away
      for (const k of ['cpu', 'memory', 'node_disk']) seen.add(`${k}|${n.node}`);
      continue;
    }
    for (const [kind, v] of [['memory', n.mem_usage], ['node_disk', n.disk_usage]]) {
      if (!cfg[kind].enabled || v == null || !Number.isFinite(Number(v))) continue;
      const prev = db.prepare('SELECT level FROM hypervisor_threshold_state WHERE connection_id = ? AND kind = ? AND subject = ?').get(conn.id, kind, n.node)?.level || 'ok';
      run(kind, n.node, levelFor(Number(v), cfg[kind], prev), Number(v), describe(kind, n.node, Math.round(Number(v)), {}, cfg));
    }
    if (cfg.cpu.enabled) {
      // sustained load, not one sample: average of the window, and only once the data covers at least half of it
      const w = db.prepare("SELECT AVG(cpu_usage) a, COUNT(*) c, MIN(recorded_at) first FROM hypervisor_node_metrics WHERE connection_id = ? AND node = ? AND cpu_usage IS NOT NULL AND recorded_at >= datetime('now', ?)")
        .get(conn.id, n.node, `-${cfg.cpu.minutes} minutes`);
      const coverMin = w.first ? (Date.now() - new Date(`${w.first.replace(' ', 'T')}Z`).getTime()) / 60000 : 0;
      if (w.c >= 2 && coverMin >= cfg.cpu.minutes / 2) {
        const avg = Math.round(w.a);
        const prev = db.prepare("SELECT level FROM hypervisor_threshold_state WHERE connection_id = ? AND kind = 'cpu' AND subject = ?").get(conn.id, n.node)?.level || 'ok';
        run('cpu', n.node, levelFor(avg, cfg.cpu, prev), avg, describe('cpu', n.node, avg, {}, cfg));
      } else {
        seen.add(`cpu|${n.node}`); // not enough data yet: leave the state alone
      }
    }
  }

  let storagesComplete = false;
  if (storages) {
    storagesComplete = storages.failedNodes.size === 0;
    const sharedDone = new Set();
    const ignore = new Set(cfg.ignore_storages.map((s) => s.toLowerCase()));
    for (const s of storages.items) {
      if (ignore.has(String(s.storage).toLowerCase())) continue;
      if (cfg.ignore_iso_only && isoOnly(s.content)) continue;
      const nodeSubject = `${s.node}/${s.storage}`;
      if (s.enabled === 0) continue; // switched off in Proxmox: not a fault
      if (cfg.storage_inactive.enabled) run('storage_inactive', nodeSubject, s.active ? 'ok' : 'crit', s.active ? 1 : 0, describe('storage_inactive', nodeSubject, 0));
      if (!s.active || !cfg.storage.enabled || !(s.total > 0)) continue;
      const subject = s.shared ? s.storage : nodeSubject;
      if (s.shared) { if (sharedDone.has(subject)) continue; sharedDone.add(subject); }
      const pct = Math.round((s.used / s.total) * 1000) / 10;
      const prev = db.prepare("SELECT level FROM hypervisor_threshold_state WHERE connection_id = ? AND kind = 'storage' AND subject = ?").get(conn.id, subject)?.level || 'ok';
      run('storage', subject, levelFor(pct, cfg.storage, prev), pct, describe('storage', subject, Math.round(pct), { node: s.shared ? null : s.node, total: s.total, used: s.used }, cfg));
    }
  }

  // forget what no longer exists (a removed storage must not stay "critical" forever) — but only when we saw everything
  const rows = db.prepare('SELECT kind, subject FROM hypervisor_threshold_state WHERE connection_id = ?').all(conn.id);
  for (const r of rows) {
    const storageKind = r.kind === 'storage' || r.kind === 'storage_inactive';
    const disabled = !cfg[r.kind]?.enabled;
    if (!disabled && storageKind && !storagesComplete) continue;
    if (disabled || !seen.has(`${r.kind}|${r.subject}`)) db.prepare('DELETE FROM hypervisor_threshold_state WHERE connection_id = ? AND kind = ? AND subject = ?').run(conn.id, r.kind, r.subject);
  }

  if (out.length && global.io) global.io.emit('hypervisor:health-checked', {}); // pages reload their alert badges
  const { notify } = require('./notificationService');
  for (const t of out) {
    if (t.from === 'crit' && t.to === 'warn') continue; // easing off, still above the warning level: silent
    await notify(messageFor(conn, t.kind, t.to, t.detail, cfg), EVENT_FOR[t.to], { type: 'hypervisor', id: conn.id });
  }
  return { transitions: out };
}

/** Everything that is over a level right now (optionally one connection). */
function activeBreaches(connectionId = null) {
  const rows = db
    .prepare(`SELECT s.connection_id, c.name AS connection_name, s.kind, s.subject, s.level, s.value, s.detail, s.since
              FROM hypervisor_threshold_state s JOIN hypervisor_connections c ON c.id = s.connection_id
              WHERE s.level != 'ok' ${connectionId ? 'AND s.connection_id = ?' : ''} ORDER BY s.level DESC, s.connection_id, s.kind, s.subject`)
    .all(...(connectionId ? [connectionId] : []));
  return rows;
}

module.exports = { DEFAULTS, KINDS, HYST, CONFIRM, EVENT_FOR, getConfig, saveConfig, sanitize, levelFor, evaluate, activeBreaches, messageFor };
