'use strict';

const net = require('net');

/** ::ffff:10.0.0.5 -> 10.0.0.5 */
function normalizeIp(ip) {
  if (!ip) return '';
  return ip.startsWith('::ffff:') && net.isIPv4(ip.slice(7)) ? ip.slice(7) : ip;
}

const ipv4ToInt = (ip) => ip.split('.').reduce((acc, oct) => ((acc << 8) | Number(oct)) >>> 0, 0);

/** Splits "10.0.0.0/8, 192.168.1.15" (commas, spaces or new lines) into entries. */
const parseNetworks = (text) => String(text || '').split(/[\s,;]+/).map((s) => s.trim()).filter(Boolean);

/** Builds a matcher from entries like "10.0.0.0/8", "192.168.1.15", "::1". IPv6 entries match exactly (no prefix maths);
 * loopback is always allowed. Throws on an entry that is not a network. */
function buildMatcher(entries) {
  const v4 = [];
  const v6 = new Set(['::1']);
  for (const raw of entries) {
    const [addr, bitsStr] = raw.split('/');
    if (net.isIPv4(addr)) {
      const bits = bitsStr === undefined ? 32 : Number(bitsStr);
      if (!Number.isInteger(bits) || bits < 0 || bits > 32) throw new Error(`Invalid network: ${raw}`);
      const mask = bits === 0 ? 0 : (~0 << (32 - bits)) >>> 0;
      // `&` yields a SIGNED 32-bit number; without >>> 0 every network from 128.0.0.0 up (192.168.x.x, 172.16.x.x) never matches
      v4.push({ net: (ipv4ToInt(addr) & mask) >>> 0, mask });
    } else if (net.isIPv6(addr)) {
      v6.add(addr.toLowerCase());
    } else {
      throw new Error(`Invalid network: ${raw}`);
    }
  }
  return (ipRaw) => {
    const ip = normalizeIp(ipRaw);
    if (net.isIPv4(ip)) {
      const n = ipv4ToInt(ip);
      return v4.some((r) => ((n & r.mask) >>> 0) === r.net);
    }
    return v6.has(ip.toLowerCase());
  };
}

module.exports = { normalizeIp, parseNetworks, buildMatcher };
