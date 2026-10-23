'use strict';

// NetFlow v5, v9 and IPFIX (v10) packets → flows { src, dst, sport, dport, proto, bytes, packets, inIf, outIf }.
// v9 and IPFIX describe their records in templates that arrive now and then: they are remembered for each exporter.

const MAX_TEMPLATES = 2000;
const FIELDS = { 1: 'bytes', 2: 'packets', 4: 'proto', 7: 'sport', 8: 'src', 10: 'inIf', 11: 'dport', 12: 'dst', 14: 'outIf', 23: 'bytes2', 27: 'src', 28: 'dst', 85: 'bytes3', 86: 'packets2' };

const uint = (buf, o, len) => { let n = 0n; for (let i = 0; i < len; i++) n = (n << 8n) | BigInt(buf[o + i]); return Number(n); };
const ipv4 = (buf, o) => `${buf[o]}.${buf[o + 1]}.${buf[o + 2]}.${buf[o + 3]}`;
function ipv6(buf, o) {
  const g = []; for (let i = 0; i < 8; i++) g.push(buf.readUInt16BE(o + i * 2).toString(16));
  const s = g.join(':'); return s.replace(/(^|:)0(:0)+(:|$)/, '::').replace(/:{3,}/, '::');
}

function readValue(kind, buf, o, len) {
  if (kind === 'src' || kind === 'dst') return len === 4 ? ipv4(buf, o) : len === 16 ? ipv6(buf, o) : null;
  return len >= 1 && len <= 8 ? uint(buf, o, len) : null;
}
function finish(r) {
  const bytes = r.bytes ?? r.bytes2 ?? r.bytes3; const packets = r.packets ?? r.packets2;
  if (!r.src || !r.dst || !(bytes >= 0)) return null;
  return { src: r.src, dst: r.dst, sport: r.sport ?? null, dport: r.dport ?? null, proto: r.proto ?? null, bytes, packets: packets ?? 0, inIf: r.inIf ?? null, outIf: r.outIf ?? null };
}

function decodeV5(buf) {
  const count = buf.readUInt16BE(2); const flows = [];
  for (let i = 0; i < count; i++) {
    const o = 24 + i * 48; if (o + 48 > buf.length) break;
    flows.push({ src: ipv4(buf, o), dst: ipv4(buf, o + 4), inIf: buf.readUInt16BE(o + 12), outIf: buf.readUInt16BE(o + 14), packets: buf.readUInt32BE(o + 16), bytes: buf.readUInt32BE(o + 20), sport: buf.readUInt16BE(o + 32), dport: buf.readUInt16BE(o + 34), proto: buf[o + 38] });
  }
  return flows;
}

/** Walks the flowsets of a v9 packet or the sets of an IPFIX message. */
function decodeTemplated(buf, ver, exporter, cache, stats) {
  const hdr = ver === 9 ? 20 : 16; const domain = ver === 9 ? buf.readUInt32BE(16) : buf.readUInt32BE(12);
  const end = ver === 10 ? Math.min(buf.length, buf.readUInt16BE(2)) : buf.length; const flows = [];
  let o = hdr;
  while (o + 4 <= end) {
    const id = buf.readUInt16BE(o); const len = buf.readUInt16BE(o + 2);
    if (len < 4 || o + len > end) break;
    const body = o + 4; const stop = o + len;
    if (id === (ver === 9 ? 0 : 2)) {                                    // templates
      let p = body;
      while (p + 4 <= stop) {
        const tid = buf.readUInt16BE(p); const n = buf.readUInt16BE(p + 2); p += 4; const fields = []; let ok = true;
        for (let i = 0; i < n; i++) {
          if (p + 4 > stop) { ok = false; break; }
          let type = buf.readUInt16BE(p); const flen = buf.readUInt16BE(p + 2); p += 4;
          if (ver === 10 && (type & 0x8000)) { type &= 0x7fff; p += 4; fields.push({ kind: null, len: flen }); continue; } // an enterprise field: skipped, but its length counts
          fields.push({ kind: FIELDS[type] || null, len: flen });
        }
        if (!ok) break;
        const key = `${exporter}|${domain}|${tid}`;
        if (!cache.has(key) && cache.size >= MAX_TEMPLATES) cache.delete(cache.keys().next().value);
        cache.set(key, fields);
      }
    } else if (id >= 256) {                                              // data
      const fields = cache.get(`${exporter}|${domain}|${id}`);
      if (!fields) { stats.unknownTemplate += 1; }
      else {
        let p = body;
        while (p < stop) {
          const rec = {}; let q = p; let ok = true;
          for (const f of fields) {
            let len = f.len;
            if (len === 65535) { if (q >= stop) { ok = false; break; } len = buf[q]; q += 1; if (len === 255) { if (q + 2 > stop) { ok = false; break; } len = buf.readUInt16BE(q); q += 2; } }
            if (q + len > stop) { ok = false; break; }
            if (f.kind) rec[f.kind] = readValue(f.kind, buf, q, len);
            q += len;
          }
          if (!ok) break;
          const flow = finish(rec); if (flow) flows.push(flow);
          if (q === p) break; p = q;
          if (stop - p < 4 && ver === 9) break;                           // padding at the end of the flowset
          if (stop - p < 4 && ver === 10) break;
        }
      }
    }
    o = stop;
  }
  return flows;
}

/** @returns {{ version: number, flows: object[], unknownTemplate: number }} — never throws on a bad packet (version 0 then). */
function decode(buf, exporter, cache) {
  const stats = { unknownTemplate: 0 };
  try {
    if (buf.length < 16) return { version: 0, flows: [], ...stats };
    const ver = buf.readUInt16BE(0);
    if (ver === 5 && buf.length >= 24) return { version: 5, flows: decodeV5(buf), ...stats };
    if ((ver === 9 && buf.length >= 20) || ver === 10) return { version: ver, flows: decodeTemplated(buf, ver, exporter, cache, stats), ...stats };
  } catch { /* a packet that cannot be read is dropped */ }
  return { version: 0, flows: [], ...stats };
}

module.exports = { decode, MAX_TEMPLATES };
