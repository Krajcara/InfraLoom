'use strict';

// NetFlow v5, v9 and IPFIX packets as exporters build them, for the tests.

const u = (n, len) => { const b = Buffer.alloc(len); let v = BigInt(n); for (let i = len - 1; i >= 0; i--) { b[i] = Number(v & 0xffn); v >>= 8n; } return b; };
const ip4 = (s) => Buffer.from(s.split('.').map(Number));
const ip6 = (s) => { const [a, b] = s.split('::'); const h = a ? a.split(':') : []; const t = b ? b.split(':') : []; const g = [...h, ...Array(8 - h.length - t.length).fill('0'), ...t]; return Buffer.concat(g.map((x) => u(parseInt(x, 16), 2))); };

function v5(flows) {
  const head = Buffer.concat([u(5, 2), u(flows.length, 2), u(123456, 4), u(1798020000, 4), u(0, 4), u(1, 4), u(0, 2), u(0, 2)]);
  return Buffer.concat([head, ...flows.map((f) => Buffer.concat([ip4(f.src), ip4(f.dst), ip4('0.0.0.0'), u(f.inIf || 1, 2), u(f.outIf || 2, 2), u(f.packets || 1, 4), u(f.bytes, 4), u(0, 4), u(0, 4), u(f.sport, 2), u(f.dport, 2), u(0, 1), u(0, 1), u(f.proto, 1), u(0, 1), u(0, 2), u(0, 2), u(0, 1), u(0, 1), u(0, 2)]))]);
}

// the template of a MikroTik: bytes, packets, protocol, source port, source address, input interface, destination port, destination address, output interface
const MIKROTIK = [[1, 4], [2, 4], [4, 1], [7, 2], [8, 4], [10, 4], [11, 2], [12, 4], [14, 4]];
const record = (f) => Buffer.concat([u(f.bytes, 4), u(f.packets || 1, 4), u(f.proto, 1), u(f.sport, 2), ip4(f.src), u(f.inIf || 1, 4), u(f.dport, 2), ip4(f.dst), u(f.outIf || 2, 4)]);

const set = (id, body, align = 4) => { const pad = (align - ((body.length + 4) % align)) % align; return Buffer.concat([u(id, 2), u(body.length + 4 + pad, 2), body, Buffer.alloc(pad)]); };
const template = (tid, fields, ipfix = false) => Buffer.concat([u(tid, 2), u(fields.length, 2), ...fields.map(([t, l, ent]) => (ipfix && ent ? Buffer.concat([u(t | 0x8000, 2), u(l, 2), u(ent, 4)]) : Buffer.concat([u(t, 2), u(l, 2)])))]);

/** parts: Buffers made by set(). */
function v9(parts, { sourceId = 0, count = 1 } = {}) {
  return Buffer.concat([u(9, 2), u(count, 2), u(5000, 4), u(1798020000, 4), u(1, 4), u(sourceId, 4), ...parts]);
}
function ipfix(parts, { domain = 0 } = {}) {
  const body = Buffer.concat(parts);
  return Buffer.concat([u(10, 2), u(16 + body.length, 2), u(1798020000, 4), u(1, 4), u(domain, 4), body]);
}

module.exports = { u, ip4, ip6, v5, v9, ipfix, set, template, record, MIKROTIK };
