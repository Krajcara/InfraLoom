'use strict';

// Pure functions: counters → rates, the alert state, percentiles, and the way a speed is shown.

const MAX32 = 2n ** 32n;

/** A counter as a BigInt: the 8 bytes of an SNMP Counter64, a number, or the text kept in the database. */
function toBig(v) {
  if (typeof v === 'bigint') return v;
  if (Buffer.isBuffer(v)) { let r = 0n; for (const b of v) r = (r << 8n) | BigInt(b); return r; }
  if (typeof v === 'number' && Number.isFinite(v) && v >= 0) return BigInt(Math.trunc(v));
  if (typeof v === 'string' && /^\d+$/.test(v)) return BigInt(v);
  return null;
}

/**
 * The rate between two readings of an octet counter. Returns { bps } or { skip: why }:
 * 'first' (nothing to compare with), 'reset' (the counter went down: the device restarted), 'glitch' (faster than the link can be).
 * A 32-bit counter that wrapped is allowed for when the result is plausible.
 */
function counterRate(prev, cur, dtSec, { bits = 64, maxBps = null } = {}) {
  const p = toBig(prev); const c = toBig(cur);
  if (p === null || c === null || !(dtSec > 0)) return { skip: 'first' };
  let delta = c - p;
  if (delta < 0n) {
    if (bits !== 32) return { skip: 'reset' };
    delta = c + MAX32 - p; // wrapped once
    if (maxBps && (Number(delta) * 8) / dtSec > maxBps * 1.5) return { skip: 'reset' };
  }
  const bps = (Number(delta) * 8) / dtSec;
  if (maxBps && bps > maxBps * 1.5) return { skip: 'glitch' };
  return { bps };
}

/**
 * The alert state of one interface after a new rate. A level is entered when the load has stayed at or above it for `sustainSec`,
 * and left when it has stayed below (warning − 5 points) for `clearSec`. Returns { state, changed, patch } (changed = the new state or null).
 */
function nextState(row, utilPct, nowSec, { warn, crit, sustainSec, clearSec }) {
  if (utilPct == null) return { state: row.state, changed: null, patch: {} };
  const aboveCrit = utilPct >= crit; const aboveWarn = utilPct >= warn; const clear = utilPct < warn - 5;
  const patch = {
    above_crit_since: aboveCrit ? (row.above_crit_since || nowSec) : null,
    above_warn_since: aboveWarn ? (row.above_warn_since || nowSec) : null,
    below_since: clear ? (row.below_since || nowSec) : null,
  };
  let state = row.state || 'ok';
  if (patch.above_crit_since && nowSec - patch.above_crit_since >= sustainSec) state = 'critical';
  else if (state === 'ok' && patch.above_warn_since && nowSec - patch.above_warn_since >= sustainSec) state = 'warning';
  if (state !== 'ok' && patch.below_since && nowSec - patch.below_since >= clearSec) state = 'ok';
  return { state, changed: state !== (row.state || 'ok') ? state : null, patch };
}

const percentile = (values, p = 95) => {
  if (!values.length) return null;
  const s = values.slice().sort((a, b) => a - b);
  return s[Math.max(0, Math.ceil((p / 100) * s.length) - 1)];
};

/** 920000000 → "920 Mbps" */
function fmtBps(v) {
  if (v == null || !Number.isFinite(v)) return '—';
  const u = [[1e9, 'Gbps'], [1e6, 'Mbps'], [1e3, 'kbps']];
  for (const [d, n] of u) if (v >= d) return `${(v / d).toFixed(v / d >= 100 ? 0 : 1).replace(/\.0$/, '')} ${n}`;
  return `${Math.round(v)} bps`;
}

module.exports = { toBig, counterRate, nextState, percentile, fmtBps };
