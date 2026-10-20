'use strict';

// Which DNS servers the checks of a domain ask (MX, SPF, DKIM, DMARC; and the DMARC record of a domain added by hand).
// The server's own resolver is usually the local DNS of the network, and that often holds its own copy of the zone (split-horizon):
// then the check shows the inside view, not what the rest of the world — Google, Microsoft — sees. So the default is a public resolver.
//   public : 1.1.1.1 and 8.8.8.8      system : whatever the server is set up to use      custom : the addresses given

const dns = require('node:dns');
const net = require('node:net');
const db = require('../db/database');

const PUBLIC_SERVERS = ['1.1.1.1', '8.8.8.8'];
const MODES = ['public', 'system', 'custom'];

const get = (key) => db.prepare('SELECT value FROM settings WHERE key = ?').get(key)?.value ?? '';

/** "1.1.1.1", "9.9.9.9:5353", "2606:4700:4700::1111" or "[2606:4700:4700::1111]:53" — the address and an optional port. */
function validServer(s) {
  const m = /^\[([^\]]+)\](?::(\d{1,5}))?$/.exec(s);
  if (m) return net.isIPv6(m[1]) && (!m[2] || +m[2] <= 65535);
  if (net.isIPv6(s)) return true;
  const [ip, port, extra] = s.split(':');
  return extra === undefined && net.isIPv4(ip) && (port === undefined || (/^\d{1,5}$/.test(port) && +port >= 1 && +port <= 65535));
}
const parseServers = (text) => String(text || '').split(/[\s,;]+/).map((s) => s.trim()).filter(Boolean);

function config() {
  let mode = get('domain_check_dns');
  if (!MODES.includes(mode)) mode = 'public';
  const custom = parseServers(get('domain_check_dns_servers')).filter(validServer);
  const servers = mode === 'public' ? PUBLIC_SERVERS : mode === 'custom' ? (custom.length ? custom : PUBLIC_SERVERS) : null;
  return { mode, custom: get('domain_check_dns_servers'), servers };
}

/** A resolver with the methods of dns.promises (resolveMx, resolveTxt, ...). */
function getResolver() {
  const { servers } = config();
  if (!servers) return dns.promises;
  const r = new dns.promises.Resolver({ timeout: 3000, tries: 2 });
  r.setServers(servers);
  return r;
}

/** Validates and stores the choice. Throws an Error with a readable message. */
function save({ mode, servers }) {
  if (!MODES.includes(mode)) throw new Error('Choose public, system or custom');
  const list = parseServers(servers);
  if (mode === 'custom') {
    if (!list.length) throw new Error('Give at least one DNS server address');
    if (list.length > 4) throw new Error('At most four DNS servers');
    const bad = list.find((s) => !validServer(s));
    if (bad) throw new Error(`“${bad}” is not an IP address`);
  }
  const put = db.prepare("INSERT INTO settings (key, value, updated_at) VALUES (?, ?, datetime('now')) ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at");
  db.transaction(() => { put.run('domain_check_dns', mode); put.run('domain_check_dns_servers', mode === 'custom' ? list.join(', ') : ''); })();
}

module.exports = { getResolver, config, save, validServer, PUBLIC_SERVERS, MODES };
