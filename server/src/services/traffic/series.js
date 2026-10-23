'use strict';

// The numbers behind a chart: a range of time as points, and the summary of that range.

const db = require('../../db/database');
const { percentile } = require('./rates');

// raw: from the samples of every poll; hourly: from the hourly summaries (plus the hour that is still going on, from the samples)
const RANGES = {
  '1h': { span: 3600, bucket: 60, src: 'raw' },
  '6h': { span: 6 * 3600, bucket: 300, src: 'raw' },
  '24h': { span: 86400, bucket: 600, src: 'raw' },
  '7d': { span: 7 * 86400, bucket: 3600, src: 'hourly' },
  '30d': { span: 30 * 86400, bucket: 3 * 3600, src: 'hourly' },
  '1y': { span: 365 * 86400, bucket: 86400, src: 'hourly' },
};

function series(interfaceId, range, nowSec = Math.floor(Date.now() / 1000)) {
  const r = RANGES[range];
  if (!r) throw new Error(`Range must be one of ${Object.keys(RANGES).join(', ')}`);
  const from = nowSec - r.span;
  const points = new Map(); // bucket → { ts, in, out, max_in, max_out }
  const bucketOf = (ts) => Math.floor(ts / r.bucket) * r.bucket;

  const rawRows = (since) => db.prepare('SELECT ts, dt, in_bps, out_bps FROM traffic_samples WHERE interface_id = ? AND ts >= ? ORDER BY ts').all(interfaceId, since);
  const hourRows = r.src === 'hourly' ? db.prepare('SELECT * FROM traffic_hourly WHERE interface_id = ? AND hour >= ? ORDER BY hour').all(interfaceId, from - 3600) : [];
  const lastHour = hourRows.length ? hourRows[hourRows.length - 1].hour : null;
  const raw = rawRows(r.src === 'raw' ? from : Math.max(from, lastHour == null ? from : lastHour + 3600));

  const acc = new Map(); // bucket → sums for the average
  const add = (ts, i, o, mi, mo, w) => {
    const b = bucketOf(ts); const a = acc.get(b) || { w: 0, i: 0, o: 0, mi: 0, mo: 0 };
    a.w += w; a.i += i * w; a.o += o * w; a.mi = Math.max(a.mi, mi); a.mo = Math.max(a.mo, mo); acc.set(b, a);
  };
  for (const h of hourRows) if (h.hour + 3600 > from) add(h.hour, h.avg_in || 0, h.avg_out || 0, h.max_in || 0, h.max_out || 0, h.samples || 1);
  for (const s of raw) add(s.ts, s.in_bps, s.out_bps, s.in_bps, s.out_bps, 1);
  for (const [b, a] of [...acc].sort((x, y) => x[0] - y[0])) points.set(b, { ts: b, in: a.i / a.w, out: a.o / a.w, max_in: a.mi, max_out: a.mo });

  // the summary: from the samples when they cover the range, else from the hourly summaries
  let basis; let totals; let ins; let outs;
  if (r.src === 'raw') {
    basis = 'the samples of the polls';
    ins = raw.map((s) => s.in_bps); outs = raw.map((s) => s.out_bps);
    totals = { bytes_in: raw.reduce((t, s) => t + (s.in_bps * s.dt) / 8, 0), bytes_out: raw.reduce((t, s) => t + (s.out_bps * s.dt) / 8, 0) };
  } else {
    basis = 'the hourly averages';
    const usable = hourRows.filter((h) => h.hour + 3600 > from);
    ins = usable.map((h) => h.avg_in || 0).concat(raw.length ? [raw.reduce((t, s) => t + s.in_bps, 0) / raw.length] : []);
    outs = usable.map((h) => h.avg_out || 0).concat(raw.length ? [raw.reduce((t, s) => t + s.out_bps, 0) / raw.length] : []);
    totals = {
      bytes_in: usable.reduce((t, h) => t + (h.bytes_in || 0), 0) + raw.reduce((t, s) => t + (s.in_bps * s.dt) / 8, 0),
      bytes_out: usable.reduce((t, h) => t + (h.bytes_out || 0), 0) + raw.reduce((t, s) => t + (s.out_bps * s.dt) / 8, 0),
    };
  }
  const mean = (a) => (a.length ? a.reduce((t, v) => t + v, 0) / a.length : null);
  const pts = [...points.values()];
  return {
    range, from, to: nowSec, bucket: r.bucket, points: pts,
    summary: {
      basis, samples: ins.length,
      avg_in: mean(ins), avg_out: mean(outs),
      max_in: pts.length ? Math.max(...pts.map((p) => p.max_in)) : null, max_out: pts.length ? Math.max(...pts.map((p) => p.max_out)) : null,
      p95_in: percentile(ins, 95), p95_out: percentile(outs, 95), ...totals,
    },
  };
}

/** The last hour as a short list for a small chart in the list: 5-minute averages of the larger of in and out. */
function spark(interfaceId, nowSec = Math.floor(Date.now() / 1000)) {
  return db.prepare('SELECT (ts / 300) * 300 AS t, MAX(in_bps, out_bps) AS v FROM (SELECT ts, in_bps, out_bps FROM traffic_samples WHERE interface_id = ? AND ts >= ?) GROUP BY t ORDER BY t')
    .all(interfaceId, nowSec - 3600).map((r) => r.v);
}

module.exports = { series, spark, RANGES };
