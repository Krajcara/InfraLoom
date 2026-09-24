'use strict';

const dnsLib = require('dns').promises;
const axios = require('axios');
const https = require('https');

const insecureAgent = new https.Agent({ rejectUnauthorized: false });

async function fallbackRawDns(dnsIp) {
  try {
    const resolver = new dnsLib.Resolver();
    resolver.setServers([dnsIp]);
    await Promise.race([
      resolver.resolve4('cloudflare.com'),
      new Promise((_, reject) => setTimeout(() => reject(new Error('timeout')), 3000)),
    ]);
    return { online: true };
  } catch (e) {
    return { online: false, error: e.message };
  }
}

/** Checks whether a configured local DNS server is reachable, preferring
 * each vendor's own HTTP management API (which is what actually reflects
 * "is this DNS server healthy" for that software) over a raw DNS query —
 * a raw query can fail for reasons unrelated to server health (a
 * blocklist entry for the probe domain, port 53 firewalled from this
 * host while the web UI port isn't, etc.) even when the server is fine. */
async function checkDnsServerOnline(server) {
  const { type, ip, api_key } = server;
  const baseUrl = ip.startsWith('http') ? ip.replace(/\/$/, '') : `http://${ip}`;
  const dnsIp = ip.replace(/^https?:\/\//, '').split(':')[0];

  if (type === 'pihole') {
    try {
      const r = await axios.post(`${baseUrl}/api/auth`, { password: api_key || '' }, { timeout: 5000, httpsAgent: insecureAgent });
      if (r.status === 200) return { online: true, version: 6 };
    } catch {
      // fall through
    }
    try {
      const r = await axios.get(`${baseUrl}/admin/api.php?status&auth=${api_key || ''}`, { timeout: 5000, httpsAgent: insecureAgent });
      if (r.data?.status) return { online: true, version: 5 };
    } catch {
      // fall through
    }
    return fallbackRawDns(dnsIp);
  }

  if (type === 'technitium' && api_key) {
    try {
      const r = await axios.get(`${baseUrl}/api/user/session/get?token=${api_key}`, { timeout: 5000, httpsAgent: insecureAgent });
      if (r.data?.status === 'ok' || r.status === 200) return { online: true };
    } catch {
      // fall through
    }
  }

  if (type === 'adguard') {
    try {
      const r = await axios.get(`${baseUrl}/control/status`, { timeout: 5000, httpsAgent: insecureAgent });
      if (r.status === 200) return { online: true, running: r.data?.running };
    } catch {
      // fall through
    }
  }

  return fallbackRawDns(dnsIp);
}

module.exports = { checkDnsServerOnline };
