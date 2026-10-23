'use strict';

// The traffic of an hour, summed up by who, to where, which application, which country, service, policy and user. Bounded: a dimension keeps
// at most MAX_KEYS entries (the rest goes to "(other)"), and only the biggest are written down.

const DIMS = ['src', 'dst', 'app', 'country', 'service', 'policy', 'user'];
const MAX_KEYS = 3000;
const TOP = 40;
const OTHER = '(other)';

const empty = () => ({ sessions: 0, blocked: 0, bytes_out: 0, bytes_in: 0, dims: Object.fromEntries(DIMS.map((d) => [d, new Map()])) });

function bump(map, key, bytes, blocked) {
  if (!key) return;
  let k = key;
  if (!map.has(k) && map.size >= MAX_KEYS) k = OTHER;
  const e = map.get(k) || [0, 0, 0]; // bytes, sessions, blocked
  e[0] += bytes; e[1] += 1; e[2] += blocked ? 1 : 0; map.set(k, e);
}

/** An hour that was already written (the service restarted in the middle of it) goes on from what was stored. */
function hydrate(b, row) {
  b.sessions = row.sessions; b.blocked = row.blocked; b.bytes_out = row.bytes_out; b.bytes_in = row.bytes_in;
  const top = JSON.parse(row.top || '{}');
  for (const d of DIMS) for (const [k, v] of Object.entries(top[d] || {})) b.dims[d].set(k, [v[0], v[1], v[2]]);
  if (top.names) b.names = new Map(Object.entries(top.names));
}

class Aggregator {
  constructor() { this.buckets = new Map(); }
  /** t = trafficOf(...) of one log line; sec = the time of it. */
  add(device, sec, t, loader = null) {
    const hour = Math.floor(sec / 3600) * 3600; const id = `${device}|${hour}`;
    let b = this.buckets.get(id);
    if (!b) { b = Object.assign(empty(), { device, hour }); const row = loader ? loader(device, hour) : null; if (row) hydrate(b, row); this.buckets.set(id, b); }
    const bytes = t.out + t.in;
    b.sessions += 1; b.blocked += t.blocked ? 1 : 0; b.bytes_out += t.out; b.bytes_in += t.in;
    bump(b.dims.src, t.src, bytes, t.blocked); bump(b.dims.dst, t.dst, bytes, t.blocked); bump(b.dims.app, t.app, bytes, t.blocked); bump(b.dims.country, t.country, bytes, t.blocked);
    bump(b.dims.service, t.service, bytes, t.blocked); bump(b.dims.policy, t.policy, bytes, t.blocked); bump(b.dims.user, t.user, bytes, t.blocked);
    if (t.src && t.srcName) { (b.names ||= new Map()).set(t.src, t.srcName); if (b.names.size > 500) b.names.delete(b.names.keys().next().value); }
  }
  /** The buckets whose hour is over (all of them when `all`), removed from memory. */
  take(nowSec, all = false) {
    const current = Math.floor(nowSec / 3600) * 3600; const out = [];
    for (const [id, b] of this.buckets) if (all || b.hour < current) { out.push(b); this.buckets.delete(id); }
    return out;
  }
  live(device) { return [...this.buckets.values()].filter((b) => !device || b.device === device); }
}

/** The biggest entries of a map: by bytes, and those that were blocked the most — { key: [bytes, sessions, blocked] }. */
function topOf(map, n = TOP) {
  const rows = [...map.entries()];
  const keep = new Map(rows.sort((a, b) => b[1][0] - a[1][0]).slice(0, n));
  for (const r of rows.filter((x) => x[1][2] > 0).sort((a, b) => b[1][2] - a[1][2]).slice(0, Math.ceil(n / 4))) keep.set(r[0], r[1]);
  return Object.fromEntries(keep);
}

/** A bucket as it is stored. */
function toRow(b) {
  const top = Object.fromEntries(DIMS.map((d) => [d, topOf(b.dims[d])]));
  if (b.names) top.names = Object.fromEntries([...b.names].filter(([ip]) => top.src[ip]));
  return { device: b.device, hour: b.hour, sessions: b.sessions, blocked: b.blocked, bytes_out: b.bytes_out, bytes_in: b.bytes_in, top: JSON.stringify(top) };
}

/** Rows (or live buckets) added together; the result has the biggest `n` entries of each dimension: { sessions, blocked, bytes_out, bytes_in, top: { dim: [[key, bytes, sessions, blocked]] } }. */
function combine(rows, n = 10) {
  const sum = { sessions: 0, blocked: 0, bytes_out: 0, bytes_in: 0 }; const dims = Object.fromEntries(DIMS.map((d) => [d, new Map()])); const names = {};
  for (const r of rows) {
    sum.sessions += r.sessions; sum.blocked += r.blocked; sum.bytes_out += r.bytes_out; sum.bytes_in += r.bytes_in;
    const top = r.top ? (typeof r.top === 'string' ? JSON.parse(r.top) : r.top) : Object.fromEntries(DIMS.map((d) => [d, Object.fromEntries(r.dims[d])]));
    for (const d of DIMS) for (const [k, v] of Object.entries(top[d] || {})) { const e = dims[d].get(k) || [0, 0, 0]; e[0] += v[0]; e[1] += v[1]; e[2] += v[2]; dims[d].set(k, e); }
    Object.assign(names, top.names || (r.names ? Object.fromEntries(r.names) : {}));
  }
  const out = {};
  for (const d of DIMS) out[d] = [...dims[d]].sort((a, b) => b[1][0] - a[1][0]).slice(0, n).map(([k, v]) => ({ key: k, name: d === 'src' ? names[k] || null : null, bytes: v[0], sessions: v[1], blocked: v[2] }));
  out.blocked_src = [...dims.src].filter(([, v]) => v[2] > 0).sort((a, b) => b[1][2] - a[1][2]).slice(0, n).map(([k, v]) => ({ key: k, name: names[k] || null, bytes: v[0], sessions: v[1], blocked: v[2] }));
  return { ...sum, top: out };
}

module.exports = { Aggregator, toRow, combine, topOf, DIMS, MAX_KEYS, OTHER };
