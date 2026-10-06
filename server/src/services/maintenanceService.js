'use strict';

const db = require('../db/database');

// Maintenance windows silence the *state-change* alerts of a target (down / recovered / offline / on battery ...)
// for a period of time. Checks keep running and statuses stay accurate in the UI — only the notifications are
// held back. Digest-style alerts (licence, SSL, Entra expiry) and "new device on the network" are never muted.
const STATE_EVENTS = new Set([
  'monitor_down', 'monitor_up', 'hypervisor_down', 'hypervisor_up',
  'ups_on_battery', 'ups_low_battery', 'ups_power_restored', 'ups_offline', 'ups_online',
  'network_device_offline',
]);

const TARGET_TYPES = ['all', 'monitor', 'hypervisor', 'ups', 'switch', 'access_point']; // switch/access_point = FortiGate-discovered
const PATCH_GRACE_MIN = 10;   // after a patch run ends, keep that host's alerts muted a little longer so a reboot can finish
const PATCH_SAFETY_MIN = 180; // a patch run that never reports back can't mute a host forever
const MAX_WINDOW_MIN = 31 * 24 * 60;

const nowIso = () => new Date().toISOString();
const plusMin = (iso, min) => new Date(new Date(iso).getTime() + min * 60000).toISOString();

function emit() {
  if (global.io) global.io.emit('maintenance:update', {});
}

// ── lookups ────────────────────────────────────────────────────────────────

function activeWindows() {
  const now = nowIso();
  return db.prepare('SELECT * FROM maintenance_windows WHERE ended_at IS NULL AND starts_at <= ? AND ends_at > ? ORDER BY ends_at DESC').all(now, now);
}

/** The active window covering this target (its own window, else a global one), or null. */
function activeFor(type, id) {
  const now = nowIso();
  return (
    db
      .prepare(
        `SELECT * FROM maintenance_windows
         WHERE ended_at IS NULL AND starts_at <= ? AND ends_at > ?
           AND (target_type = 'all' OR (target_type = ? AND target_id = ?))
         ORDER BY (target_type = 'all') ASC, ends_at DESC LIMIT 1`
      )
      .get(now, now, type ?? null, id ?? null) || null
  );
}

/** One query for a whole list: returns (type, id) => brief window info or null. */
function lookup() {
  const list = activeWindows();
  const all = list.find((w) => w.target_type === 'all');
  return (type, id) => brief(list.find((w) => w.target_type === type && w.target_id === id) || all || null);
}

function brief(w) {
  return w ? { id: w.id, ends_at: w.ends_at, reason: w.reason || null, source: w.source } : null;
}

function statusOf(w) {
  const now = nowIso();
  if (w.ended_at) return 'ended';
  if (w.ends_at <= now) return 'ended';
  if (w.starts_at > now) return 'scheduled';
  return 'active';
}

/** Called by notify(): returns the window that mutes this alert, or null. Never throws — if the maintenance logic
 * itself fails, the alert goes out normally (a muted real outage is worse than a noisy maintenance). */
function suppress(eventType, context) {
  if (!STATE_EVENTS.has(eventType)) return null;
  try {
    const w = activeFor(context?.type, context?.id);
    if (!w) return null;
    db.prepare('UPDATE maintenance_windows SET suppressed_count = suppressed_count + 1 WHERE id = ?').run(w.id);
    return w;
  } catch (err) {
    console.error('[maintenance] suppression check failed, sending alert:', err.message);
    return null;
  }
}

// ── create / end ───────────────────────────────────────────────────────────

function createWindow({ target_type, target_id = null, target_label, starts_at, ends_at, reason = null, source = 'manual', source_ref = null, created_by = null }) {
  if (!TARGET_TYPES.includes(target_type)) throw new Error(`Invalid target type: ${target_type}`);
  const r = db
    .prepare(
      `INSERT INTO maintenance_windows (target_type, target_id, target_label, starts_at, ends_at, reason, source, source_ref, created_by)
       VALUES (?,?,?,?,?,?,?,?,?)`
    )
    .run(target_type, target_id, target_label || null, starts_at, ends_at, reason, source, source_ref, created_by);
  emit();
  return db.prepare('SELECT * FROM maintenance_windows WHERE id = ?').get(r.lastInsertRowid);
}

/** Ends a window now. A window that never started is simply removed; one that was running is closed and the
 * target is re-checked, so anything that broke while alerts were muted is reported. */
async function endNow(id) {
  const w = db.prepare('SELECT * FROM maintenance_windows WHERE id = ?').get(id);
  if (!w || w.ended_at) return w || null;
  const now = nowIso();
  if (w.starts_at > now) {
    db.prepare('DELETE FROM maintenance_windows WHERE id = ?').run(id);
    emit();
    return null;
  }
  db.prepare('UPDATE maintenance_windows SET ended_at = ?, ends_at = MIN(ends_at, ?) WHERE id = ?').run(now, now, id);
  emit();
  await recheck(db.prepare('SELECT * FROM maintenance_windows WHERE id = ?').get(id));
  return db.prepare('SELECT * FROM maintenance_windows WHERE id = ?').get(id);
}

/** Closes windows whose time is up and re-checks their targets. Runs every minute (and once at startup, so a
 * window that expired while the server was down is not forgotten). */
async function processExpired() {
  const now = nowIso();
  const due = db.prepare('SELECT * FROM maintenance_windows WHERE ended_at IS NULL AND ends_at <= ?').all(now);
  for (const w of due) {
    db.prepare('UPDATE maintenance_windows SET ended_at = ? WHERE id = ?').run(now, w.id); // close first, so this window can't mute its own re-check
    try {
      await recheck(w);
    } catch (err) {
      console.error(`[maintenance] re-check after window ${w.id} failed:`, err.message);
    }
  }
  if (due.length) emit();
}

// ── post-window re-check ───────────────────────────────────────────────────
// Alerts are transition-based ("it just went down"). A target that broke while muted and is still broken when
// the window closes would never produce another transition — so it would stay silently down. The re-check
// reports exactly those, once.

function collectProblems(w) {
  const type = w.target_type;
  const all = type === 'all';
  const want = (t) => all || type === t;
  const idClause = (col) => (all ? '' : ` AND ${col} = ${Number(w.target_id)}`);
  const problems = []; // { event, msg, ctx, short }

  if (want('monitor')) {
    for (const m of db.prepare(`SELECT id, label, target FROM monitors WHERE enabled = 1 AND last_status = 'down'${idClause('id')}`).all()) {
      problems.push({ event: 'monitor_down', ctx: { type: 'monitor', id: m.id }, short: `${m.label} (${m.target}) is still down`, msg: `InfraLoom — monitor still DOWN after maintenance: ${m.label} (${m.target}).` });
    }
  }
  if (want('hypervisor')) {
    for (const c of db.prepare(`SELECT id, name FROM hypervisor_connections WHERE enabled = 1 AND health_check_enabled = 1 AND last_health_status = 'down'${idClause('id')}`).all()) {
      problems.push({ event: 'hypervisor_down', ctx: { type: 'hypervisor', id: c.id }, short: `hypervisor "${c.name}" is still unreachable`, msg: `Hypervisor connection "${c.name}" is still unreachable after maintenance.` });
    }
  }
  if (want('ups')) {
    const { eventsFor } = require('./upsService');
    for (const u of db.prepare(`SELECT * FROM ups_devices WHERE enabled = 1${idClause('id')}`).all()) {
      let reading = null;
      try { reading = u.last_reading ? JSON.parse(u.last_reading) : null; } catch { /* no numbers in the message */ }
      for (const [event, msg] of eventsFor(null, u.last_status, u.name, reading)) {
        problems.push({ event, ctx: { type: 'ups', id: u.id }, short: msg, msg: `${msg} (still the case after maintenance)` });
      }
    }
  }
  for (const [t, table, label] of [['switch', 'switches', 'Switch'], ['access_point', 'access_points', 'Access point']]) {
    if (!want(t)) continue;
    for (const d of db.prepare(`SELECT id, name FROM ${table} WHERE discovered_from_router_id IS NOT NULL AND (controller_status = 'down' OR discovered_missing_at IS NOT NULL)${idClause('id')}`).all()) {
      problems.push({ event: 'monitor_down', ctx: { type: t, id: d.id }, short: `${label.toLowerCase()} "${d.name}" is still offline`, msg: `${label} "${d.name}" is still offline after maintenance (reported by FortiGate).` });
    }
  }
  return problems;
}

async function recheck(w) {
  if (!w) return;
  const { notify } = require('./notificationService');
  const problems = collectProblems(w);
  if (!problems.length) return;
  if (w.target_type === 'all') {
    // one message instead of a burst after a planned shutdown
    await notify(`InfraLoom — maintenance window ended, still not OK:\n${problems.map((p) => `  - ${p.short}`).join('\n')}`, 'monitor_down', null);
  } else {
    for (const p of problems) await notify(p.msg, p.event, p.ctx);
  }
}

// ── automatic windows for patch runs ───────────────────────────────────────

function hostOf(m) {
  const t = String(m.target || '').trim();
  try {
    if (/^[a-z][a-z0-9+.-]*:\/\//i.test(t)) return new URL(t).hostname.toLowerCase();
  } catch { /* fall through */ }
  return t.replace(/^\/\//, '').split('/')[0].split(':')[0].toLowerCase();
}

/** Monitors that point at this guest: same IP, or the guest's name as the host or the first label of an FQDN.
 * Deliberately conservative — muting too much is the dangerous failure, so short names (< 3 characters) are
 * not matched by name. */
function monitorsForGuest(vmName, guestHost) {
  const ip = String(guestHost || '').trim().toLowerCase();
  const name = String(vmName || '').trim().toLowerCase();
  const rows = db.prepare("SELECT id, label, type, target FROM monitors WHERE enabled = 1 AND type IN ('http','https','tcp','icmp','keyword','json_query')").all();
  return rows.filter((m) => {
    const h = hostOf(m);
    if (!h) return false;
    if (ip && h === ip) return true;
    return name.length >= 3 && (h === name || h.startsWith(`${name}.`));
  });
}

function startForPatchRun(run) {
  const monitors = monitorsForGuest(run.vm_name, run.guest_host);
  const now = nowIso();
  for (const m of monitors) {
    createWindow({
      target_type: 'monitor', target_id: m.id, target_label: m.label,
      starts_at: now, ends_at: plusMin(now, PATCH_SAFETY_MIN),
      reason: `Patch run #${run.id} on ${run.vm_name || run.vmid}`, source: 'patch', source_ref: String(run.id), created_by: 'patch management',
    });
  }
  return monitors.length;
}

function endForPatchRun(runId) {
  const end = plusMin(nowIso(), PATCH_GRACE_MIN);
  const r = db
    .prepare("UPDATE maintenance_windows SET ends_at = MIN(ends_at, ?) WHERE source = 'patch' AND source_ref = ? AND ended_at IS NULL")
    .run(end, String(runId));
  if (r.changes) emit();
  return r.changes;
}

// ── scheduler ──────────────────────────────────────────────────────────────

let task = null;
function initScheduler() {
  const cron = require('node-cron');
  if (task) task.stop();
  task = cron.schedule('* * * * *', () => {
    processExpired().catch((err) => console.error('[maintenance] processExpired failed:', err.message));
  });
  setTimeout(() => processExpired().catch(() => {}), 10000);
}

module.exports = {
  STATE_EVENTS, TARGET_TYPES, MAX_WINDOW_MIN,
  activeFor, activeWindows, lookup, brief, statusOf, suppress,
  createWindow, endNow, processExpired, recheck,
  monitorsForGuest, startForPatchRun, endForPatchRun, initScheduler,
};
