'use strict';

// Is an address inside one of some networks. IPv4 and IPv6, no libraries.

const net = require('node:net');

function toBig(ip) {
  if (net.isIPv4(ip)) return { v: 4, n: ip.split('.').reduce((a, o) => (a << 8n) + BigInt(o), 0n) };
  if (net.isIPv6(ip)) {
    let s = ip.split('%')[0]; const m4 = /(\d+\.\d+\.\d+\.\d+)$/.exec(s);
    if (m4) { const o = m4[1].split('.').map(Number); s = s.replace(m4[1], `${((o[0] << 8) | o[1]).toString(16)}:${((o[2] << 8) | o[3]).toString(16)}`); }
    const [a, b] = s.split('::'); const head = a ? a.split(':') : []; const tail = b ? b.split(':') : [];
    const groups = b === undefined ? head : [...head, ...Array(8 - head.length - tail.length).fill('0'), ...tail];
    return { v: 6, n: groups.reduce((acc, g) => (acc << 16n) + BigInt(parseInt(g || '0', 16)), 0n) };
  }
  return null;
}

/** "10.0.0.0/8, 192.168.0.0/16, fc00::/7" → [{ v, net, mask }]; an entry that is not valid is an Error. */
function parseNetworks(text) {
  return String(text || '').split(/[\s,;]+/).filter(Boolean).map((e) => {
    const parts = e.split('/'); const [ip, bitsText] = parts; const a = parts.length > 2 ? null : toBig(ip); const max = a ? (a.v === 4 ? 32 : 128) : 0;
    const bits = bitsText === undefined ? max : Number(bitsText);
    if (!a || !Number.isInteger(bits) || bits < 0 || bits > max || (bitsText !== undefined && !/^\d+$/.test(bitsText))) throw new Error(`“${e}” is not a network like 192.168.1.0/24`);
    const mask = bits === 0 ? 0n : ((1n << BigInt(bits)) - 1n) << BigInt(max - bits);
    return { v: a.v, net: a.n & mask, mask };
  });
}

const contains = (nets, ip) => { const a = toBig(ip); return !!a && nets.some((n) => n.v === a.v && (a.n & n.mask) === n.net); };

module.exports = { parseNetworks, contains };
