'use strict';

// A tiny DNS server over UDP (A, NS, MX, TXT): the "public" view of a few domains, to show which server a check really asks.

const dgram = require('node:dgram');

const TYPES = { A: 1, NS: 2, MX: 15, TXT: 16 };
const name = (s) => Buffer.concat([...s.split('.').filter(Boolean).map((l) => Buffer.concat([Buffer.from([l.length]), Buffer.from(l)])), Buffer.from([0])]);

function rdata(type, v) {
  if (type === 'A') return Buffer.from(v.split('.').map(Number));
  if (type === 'NS') return name(v);
  if (type === 'MX') return Buffer.concat([Buffer.from([v.pref >> 8, v.pref & 255]), name(v.host)]);
  const chunks = String(v).match(/.{1,255}/g) || [''];
  return Buffer.concat(chunks.map((c) => Buffer.concat([Buffer.from([c.length]), Buffer.from(c)])));
}

/** zones: { 'name': { TXT: [...], MX: [{ pref, host }], A: [...], NS: [...] } } — a name that is not there is NXDOMAIN. */
function startFakeDns(zones = {}) {
  const log = [];
  const sock = dgram.createSocket('udp4');
  sock.on('message', (msg, rinfo) => {
    let o = 12; const labels = [];
    while (msg[o] !== 0) { labels.push(msg.slice(o + 1, o + 1 + msg[o]).toString()); o += msg[o] + 1; }
    const qtypeNum = msg.readUInt16BE(o + 1); const qEnd = o + 5;
    const qname = labels.join('.').toLowerCase();
    const qtype = Object.keys(TYPES).find((k) => TYPES[k] === qtypeNum);
    log.push(`${qtype || qtypeNum} ${qname}`);
    const zone = zones[qname];
    const answers = zone && qtype && zone[qtype] ? zone[qtype] : [];
    const head = Buffer.alloc(12); msg.copy(head, 0, 0, 2);
    head.writeUInt16BE(0x8180 | (zone ? 0 : 3), 2); head.writeUInt16BE(1, 4); head.writeUInt16BE(answers.length, 6);
    const parts = [head, msg.slice(12, qEnd)];
    for (const v of answers) {
      const d = rdata(qtype, v); const rr = Buffer.alloc(12);
      rr.writeUInt16BE(0xc00c, 0); rr.writeUInt16BE(qtypeNum, 2); rr.writeUInt16BE(1, 4); rr.writeUInt32BE(60, 6); rr.writeUInt16BE(d.length, 10);
      parts.push(rr, d);
    }
    sock.send(Buffer.concat(parts), rinfo.port, rinfo.address);
  });
  return new Promise((resolve) => sock.bind(0, '127.0.0.1', () => resolve({ address: `127.0.0.1:${sock.address().port}`, zones, log, close: () => sock.close() })));
}

module.exports = { startFakeDns };
