'use strict';

// A MikroTik RouterOS log line as the router sends it by syslog:  <30>[Oct 23 11:02:03 ][identity ]topic,topic,topic message
// (the time and the identity are there when "bsd-syslog" is on). What it means is told by the topics and the words of the message.

const TOPICS = /^[a-z][a-z0-9-]*(?:,[a-z0-9!-]+)*$/;
const KNOWN = new Set(['system', 'info', 'error', 'warning', 'critical', 'account', 'firewall', 'interface', 'dhcp', 'ppp', 'l2tp', 'sstp', 'ovpn', 'pptp', 'ipsec', 'wireguard', 'wireless', 'script', 'web-proxy', 'dns', 'event', 'debug', 'ssh', 'telnet', 'hotspot', 'bridge', 'route', 'ospf', 'bgp', 'caps', 'certificate', 'snmp', 'ntp']);
const trim = (v, n = 160) => String(v ?? '').slice(0, n);

/** @returns {{ pri, host, topics: string[], message: string } | null} */
function parseRouterOs(input) {
  let s = (Buffer.isBuffer(input) ? input.toString('utf8') : String(input)).replace(/\0/g, '').trim();
  if (!s) return null;
  let pri = null;
  const p = /^<(\d{1,3})>/.exec(s); if (p) { pri = Number(p[1]); s = s.slice(p[0].length); }
  s = s.replace(/^(?:[A-Z][a-z]{2}\s+\d{1,2}\s+\d{2}:\d{2}:\d{2}|\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:?\d{2})?)\s+/, '');
  let host = null; let rest = s;
  const first = /^(\S+)\s+(.*)$/s.exec(s); if (!first) return null;
  const isTopics = (t) => TOPICS.test(t) && (t.includes(',') || KNOWN.has(t));
  if (!isTopics(first[1])) {
    const second = /^(\S+)\s+(.*)$/s.exec(first[2]);
    if (!second || !isTopics(second[1])) return null;
    host = first[1]; rest = first[2];
  }
  const m = /^(\S+)\s*(.*)$/s.exec(rest); if (!m || !isTopics(m[1])) return null;
  return { pri, host, topics: m[1].split(','), message: m[2].trim() };
}

const portName = { 22: 'SSH', 23: 'Telnet', 53: 'DNS', 80: 'HTTP', 123: 'NTP', 161: 'SNMP', 443: 'HTTPS', 445: 'SMB', 500: 'IKE', 1194: 'OpenVPN', 1723: 'PPTP', 3389: 'RDP', 4500: 'IPsec NAT-T', 5060: 'SIP', 8291: 'Winbox', 8728: 'API', 8729: 'API-SSL', 51820: 'WireGuard' };

/** A firewall rule that logged: "[prefix ]chain: in:IF out:IF, ..., proto TCP (SYN), a.b.c.d:1->e.f.g.h:2, len 60". */
function parseFirewallHit(message) {
  const m = /^(?:(.*?)\s)?(input|forward|output|[\w-]+): in:(\S+) out:(\([^)]*\)|[^,\s]+),.*?proto (\w+)(?: \([^)]*\))?, (\d+\.\d+\.\d+\.\d+)(?::(\d+))?->(\d+\.\d+\.\d+\.\d+)(?::(\d+))?/.exec(message);
  if (!m) return null;
  const dport = m[9] ? Number(m[9]) : null;
  return { prefix: m[1] || null, chain: m[2], inIf: m[3], outIf: m[4], proto: m[5].toUpperCase(), src: m[6], sport: m[7] ? Number(m[7]) : null, dst: m[8], dport, service: dport ? (portName[dport] ? `${portName[dport]}` : `${m[5].toUpperCase()}/${dport}`) : m[5].toUpperCase() };
}

/**
 * What a line means. @returns {{ finding?: { kind, level, summary, user, srcip, attack? }, hit?: object } | null}
 * `blockPrefix` is a RegExp: a rule whose log prefix matches it is one that drops.
 */
function classifyRouterOs(p, blockPrefix = /drop|block|deny|reject|bad|invalid|scan|brute|ban|blacklist/i) {
  const t = new Set(p.topics); const msg = p.message;

  if (t.has('firewall')) {
    const hit = parseFirewallHit(msg);
    if (hit && blockPrefix.test(String(hit.prefix || '').slice(0, 60))) return { hit };
    return null;
  }
  let m;
  if ((m = /^login failure for user (\S+) from (\S+) via (\S+)/i.exec(msg))) return { finding: { kind: 'admin_login_failed', level: 'warning', user: m[1], srcip: m[2], summary: `Admin login failed: ${trim(m[1], 40)} from ${trim(m[2], 45)} (${trim(m[3], 20)})` } };
  if ((m = /^user (\S+) logged in from (\S+) via (\S+)/i.exec(msg))) return { finding: { kind: 'admin_login', level: 'info', user: m[1], srcip: m[2], summary: `Admin ${trim(m[1], 40)} logged in from ${trim(m[2], 45)} (${trim(m[3], 20)})` } };
  if (t.has('ppp') || t.has('l2tp') || t.has('sstp') || t.has('ovpn') || t.has('pptp')) {
    const from = /\bfrom (\d+\.\d+\.\d+\.\d+|[0-9a-f:]{3,39})/i.exec(msg); const src = from ? from[1] : null;
    if (/authentication failed|login failed|bad password|failed to authenticate|auth(?:entication)? failure/i.test(msg)) { const u = /user (\S+)/i.exec(msg) || /^(?:[\w-]+: )?(\S+) /.exec(msg); return { finding: { kind: 'vpn_login_failed', level: 'warning', user: u ? u[1] : null, srcip: src, summary: `VPN login failed: ${trim(msg, 120)}` } }; }
    if ((m = /^(?:[\w-]+: )?(?:user )?(\S+) logged in(?:, (\S+))?/i.exec(msg))) return { finding: { kind: 'vpn_login', level: 'info', user: m[1], srcip: src, summary: `VPN up: ${trim(m[1], 40)}${m[2] ? ` (${trim(m[2], 45)})` : ''}${src ? ` from ${src}` : ''}` } };
    if ((m = /^(?:[\w-]+: )?(?:user )?(\S+) logged out/i.exec(msg))) return { finding: { kind: 'vpn_logout', level: 'info', user: m[1], srcip: src, summary: `VPN down: ${trim(m[1], 40)}${src ? ` from ${src}` : ''}` } };
  }
  if (t.has('system') && (m = /^(.{2,100}?) (added|changed|removed|moved|enabled|disabled|set|unset) by (\S+)/i.exec(msg))) {
    return { finding: { kind: 'config_change', level: 'info', user: m[3], srcip: null, cfg: m[1], summary: `${m[2][0].toUpperCase()}${m[2].slice(1)} ${trim(m[1], 80)} by ${trim(m[3], 60)}` } };
  }
  if (t.has('interface') && (m = /^(\S+) link (down|up)\b(.*)$/i.exec(msg))) {
    const down = m[2].toLowerCase() === 'down';
    return { finding: { kind: 'system_event', level: down ? 'warning' : 'info', user: null, srcip: null, summary: `Interface ${trim(m[1], 40)} link ${m[2].toLowerCase()}${m[3] ? trim(m[3], 60) : ''}` } };
  }
  if (t.has('system') && /router (rebooted|shut ?down)|rebooted because|watchdog|kernel failure|out of memory|disk (error|full)|hardware failure|temperature|power supply/i.test(msg)) return { finding: { kind: 'system_event', level: t.has('critical') || t.has('error') ? 'warning' : 'info', user: null, srcip: null, summary: trim(msg, 140) } };
  if (t.has('system') && (t.has('critical') || t.has('error')) && !/login failure/i.test(msg)) return { finding: { kind: 'system_event', level: 'warning', user: null, srcip: null, summary: trim(msg, 140) } };
  return null;
}

const PROTO = { 1: 'ICMP', 6: 'TCP', 17: 'UDP', 47: 'GRE', 50: 'ESP', 51: 'AH', 58: 'ICMPv6' };
/** "HTTPS", "DNS", or "UDP/40000": the service of a flow, from the smaller of the two ports when it is a known one. */
function serviceOf(proto, sport, dport) {
  const name = PROTO[proto] || (proto == null ? '?' : `IP ${proto}`);
  if (proto !== 6 && proto !== 17) return name;
  const known = [dport, sport].find((p) => p && portName[p]);
  if (known) return portName[known];
  const low = [dport, sport].filter((p) => p && p < 1024).sort((a, b) => a - b)[0];
  return low ? `${name}/${low}` : (dport ? `${name}/${dport}` : name);
}

module.exports = { parseRouterOs, parseFirewallHit, classifyRouterOs, serviceOf };
