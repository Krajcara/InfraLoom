'use strict';

const express = require('express');
const dns = require('dns').promises;
const { requireAuth } = require('../middleware/auth');
const { DNS_RESOLVERS, NAME_VALUED_TYPES, DNS_RECORD_TYPES } = require('../lib/dnsResolvers');

const router = express.Router();
router.use(requireAuth);

const IPV4_RE = /^(\d{1,3}\.){3}\d{1,3}$/;
const IPV6_RE = /^[0-9a-fA-F:]+:[0-9a-fA-F:]+$/;

function isValidIp(ip) {
  return IPV4_RE.test(ip) || IPV6_RE.test(ip);
}

async function fetchWithTimeout(url, timeoutMs = 8000, options = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, { ...options, signal: controller.signal });
  } catch (err) {
    if (err.name === 'AbortError') throw new Error(`Timed out after ${timeoutMs}ms reaching ${new URL(url).hostname}`);
    // Node's native fetch throws a generic "fetch failed" and buries the real
    // reason (DNS failure, connection refused, ...) in err.cause — surface it.
    const cause = err.cause;
    const detail = cause ? `${cause.code || cause.name || ''} ${cause.message || ''}`.trim() : err.message;
    throw new Error(`${detail || 'network error'} (${new URL(url).hostname})`);
  } finally {
    clearTimeout(timer);
  }
}

// ── Geo-IP sources (both free, no API key required) ─────────────────────

async function lookupIpApi(ip) {
  const url = `http://ip-api.com/json/${ip || ''}?fields=66842623&lang=en`;
  const res = await fetchWithTimeout(url, 8000);
  const json = await res.json();
  if (json.status === 'fail') throw new Error(json.message || 'Lookup failed');
  const asn = json.as ? json.as.split(' ')[0] : null;
  return {
    source: 'ip-api.com',
    ip: json.query,
    city: json.city,
    region: json.regionName,
    country: json.countryCode,
    country_name: json.country,
    latitude: json.lat,
    longitude: json.lon,
    asn,
    org: json.isp,
    timezone: json.timezone,
  };
}

async function lookupIpSb(ip) {
  const url = `https://api.ip.sb/geoip/${ip || ''}`;
  const res = await fetchWithTimeout(url, 8000);
  if (!res.ok) throw new Error(`ip.sb returned ${res.status}`);
  const json = await res.json();
  if (!json.ip) throw new Error('No data returned');
  return {
    source: 'ip.sb',
    ip: json.ip,
    city: json.city,
    region: json.region || json.city,
    country: json.country_code,
    country_name: json.country,
    latitude: json.latitude,
    longitude: json.longitude,
    asn: json.asn ? `AS${json.asn}` : null,
    org: json.isp,
    timezone: json.timezone,
  };
}

async function multiSourceLookup(ip) {
  const [ipapi, ipsb] = await Promise.allSettled([lookupIpApi(ip), lookupIpSb(ip)]);
  const results = [];
  if (ipapi.status === 'fulfilled') results.push(ipapi.value);
  else results.push({ source: 'ip-api.com', error: ipapi.reason.message });
  if (ipsb.status === 'fulfilled') results.push(ipsb.value);
  else results.push({ source: 'ip.sb', error: ipsb.reason.message });
  return results;
}

// GET /api/myip/cards — this server's own public IP, from multiple sources
router.get('/cards', async (req, res) => {
  try {
    const results = await multiSourceLookup(null);
    res.json({ results });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET /api/myip/query?ip=1.2.3.4
router.get('/query', async (req, res) => {
  const { ip } = req.query;
  if (!ip || !isValidIp(ip)) return res.status(400).json({ error: 'A valid IPv4 or IPv6 address is required' });
  try {
    const results = await multiSourceLookup(ip);
    res.json({ ip, results });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── DNS Resolver — query a hostname against 18 public resolvers ─────────

function withRootDot(name) {
  return name.endsWith('.') ? name : `${name}.`;
}

function formatSoaRecord(r) {
  return [`${r.nsname}.`, `${r.hostmaster}.`, r.serial, r.refresh, r.retry, r.expire, r.minttl].join(' ');
}

const CAA_META_KEYS = new Set(['critical', 'type']);
function formatCaaRecords(records) {
  return records
    .flatMap((record) => {
      const tagged = Object.entries(record).find(([key]) => !CAA_META_KEYS.has(key));
      if (!tagged) return [];
      const [tag, value] = tagged;
      return `${record.critical ?? 0} ${tag} ${JSON.stringify(value)}`;
    })
    .join(', ');
}

async function resolveDns(hostname, type, server) {
  const resolver = new dns.Resolver({ timeout: 3000, tries: 1 });
  resolver.setServers([server]);
  try {
    let addresses;
    switch (type) {
      case 'A':
        addresses = await resolver.resolve4(hostname);
        break;
      case 'AAAA':
        addresses = await resolver.resolve6(hostname);
        break;
      case 'TXT':
        addresses = (await resolver.resolveTxt(hostname)).flat();
        break;
      case 'CNAME':
        addresses = await resolver.resolveCname(hostname);
        break;
      case 'NS':
        addresses = await resolver.resolveNs(hostname);
        break;
      case 'MX':
        addresses = (await resolver.resolveMx(hostname)).map((m) => `${m.priority} ${m.exchange}.`).join(', ');
        break;
      case 'SOA':
        addresses = formatSoaRecord(await resolver.resolveSoa(hostname));
        break;
      case 'CAA':
        addresses = formatCaaRecords(await resolver.resolveCaa(hostname));
        break;
      default:
        throw new Error('Unsupported record type');
    }
    if (NAME_VALUED_TYPES.has(type) && Array.isArray(addresses)) addresses = addresses.map(withRootDot);
    if (!addresses || addresses.length === 0) return 'N/A';
    return addresses;
  } catch {
    return 'N/A';
  }
}

function dohRecords(data, type) {
  if (type !== 'SOA') return data.Answer ?? [];
  const SOA_TYPE = 6;
  const answers = (data.Answer ?? []).filter((r) => r.type === SOA_TYPE);
  if (answers.length) return answers;
  return (data.Authority ?? []).filter((r) => r.type === SOA_TYPE);
}

async function resolveDoh(hostname, type, url) {
  try {
    const res = await fetchWithTimeout(`${url}name=${hostname}&type=${type}`, 5000, {
      headers: { Accept: 'application/dns-json' },
    });
    if (!res.ok) return 'N/A';
    const records = dohRecords(await res.json(), type);
    if (records.length === 0) return 'N/A';
    const addresses = records.map((r) => r.data);
    return NAME_VALUED_TYPES.has(type) ? addresses.map(withRootDot) : addresses;
  } catch {
    return 'N/A';
  }
}

// GET /api/myip/dns-resolver?hostname=example.com&type=A
router.get('/dns-resolver', async (req, res) => {
  const { hostname, type } = req.query;
  if (!hostname?.trim()) return res.status(400).json({ error: 'hostname is required' });
  if (!DNS_RECORD_TYPES.includes(type)) return res.status(400).json({ error: `type must be one of: ${DNS_RECORD_TYPES.join(', ')}` });

  const h = hostname.trim().toLowerCase();
  const lookups = DNS_RESOLVERS.flatMap((server) => {
    const tasks = [];
    if (server.udp) {
      tasks.push(
        resolveDns(h, type, server.udp).then((result) => ({ id: server.id, provider: server.name, country: server.country, transport: 'udp', result }))
      );
    }
    if (server.doh) {
      tasks.push(
        resolveDoh(h, type, server.doh).then((result) => ({ id: server.id, provider: server.name, country: server.country, transport: 'doh', result }))
      );
    }
    return tasks;
  });

  try {
    const results = await Promise.all(lookups);
    res.json({ hostname: h, type, results });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
