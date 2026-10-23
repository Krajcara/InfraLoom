'use strict';

// Network diagnostics run from the InfraLoom server: ping, traceroute, DNS (several servers side by side), TCP ports, TLS certificate,
// an HTTP request with timings, and the path MTU. Commands are started without a shell (execFile) and every target is validated;
// at most four run at once, and each has a time limit. Who may run them is decided by the route.

const { execFile } = require('node:child_process');
const dns = require('node:dns');
const net = require('node:net');
const tls = require('node:tls');
const http = require('node:http');
const https = require('node:https');
const { validServer } = require('../lib/domainResolver');

class DiagError extends Error {
  constructor(message, status = 400) { super(message); this.status = status; }
}

const MAX_RUNNING = 4;
let running = 0;
async function limited(fn) {
  if (running >= MAX_RUNNING) throw new DiagError('Too many diagnostics are running at the moment; try again in a few seconds', 429);
  running += 1;
  try { return await fn(); } finally { running -= 1; }
}

const num = (v, label, min, max, dflt) => {
  if (v === undefined || v === null || v === '') return dflt;
  const n = Number(v);
  if (!Number.isInteger(n) || n < min || n > max) throw new DiagError(`${label} must be a whole number from ${min} to ${max}`);
  return n;
};

/** A host name or an IP address; never anything a command could take for an option or a shell could read. */
function validateHost(host) {
  const h = String(host ?? '').trim().replace(/^\[|\]$/g, '');
  if (!h) throw new DiagError('Give a host name or an IP address');
  if (h.length > 253) throw new DiagError('That host name is too long');
  if (h.includes('%')) { // an IPv6 address with a zone (fe80::1%eth0): the zone is only letters, digits and a few signs
    const [base, zone, extra] = h.split('%');
    if (net.isIPv6(base) && extra === undefined && /^[A-Za-z0-9_.-]{1,15}$/.test(zone)) return h;
    throw new DiagError('That is not a host name or an IP address');
  }
  if (net.isIP(h)) return h;
  if (!/^[A-Za-z0-9_]([A-Za-z0-9_.-]*[A-Za-z0-9_])?$/.test(h)) throw new DiagError('That is not a host name or an IP address');
  return h;
}

function run(cmd, args, timeoutMs) {
  return new Promise((resolve) => {
    execFile(cmd, args, { timeout: timeoutMs, maxBuffer: 1024 * 1024, killSignal: 'SIGKILL' }, (err, stdout, stderr) => {
      resolve({
        stdout: String(stdout || ''), stderr: String(stderr || ''),
        code: !err ? 0 : typeof err.code === 'number' ? err.code : null,
        missing: !!err && err.code === 'ENOENT', timedOut: !!err && !!err.killed,
      });
    });
  });
}

// ── ping ──────────────────────────────────────────────────────────────────

function parsePing(out) {
  const r = { resolved: null, size: null, replies: [], sent: null, received: null, loss: null, rtt: null, hints: [], error: null };
  const head = /^PING \S+ \(([^)]+)\) (\d+)\((\d+)\) bytes of data/m.exec(out);
  if (head) { r.resolved = head[1]; r.size = Number(head[2]); }
  for (const m of out.matchAll(/^(\d+) bytes from \S+: icmp_seq=(\d+) ttl=(\d+) time=([\d.]+) ms/gm)) r.replies.push({ seq: Number(m[2]), ttl: Number(m[3]), time: Number(m[4]) });
  const sum = /(\d+) packets transmitted, (\d+) (?:packets )?received.*?([\d.]+)% packet loss/.exec(out);
  if (sum) { r.sent = Number(sum[1]); r.received = Number(sum[2]); r.loss = Number(sum[3]); }
  const rtt = /rtt min\/avg\/max\/mdev = ([\d.]+)\/([\d.]+)\/([\d.]+)\/([\d.]+) ms/.exec(out);
  if (rtt) r.rtt = { min: Number(rtt[1]), avg: Number(rtt[2]), max: Number(rtt[3]), mdev: Number(rtt[4]) };
  for (const m of out.matchAll(/^From (\S+) icmp_seq=\d+ (Frag needed and DF set|Destination Host Unreachable|Destination Net Unreachable|Time to live exceeded|Packet filtered)(?: \(mtu = (\d+)\))?/gm)) {
    r.hints.push(`${m[1]}: ${m[2]}${m[3] ? ` (mtu = ${m[3]})` : ''}`);
  }
  const err = /^ping: (.+)$/m.exec(out);
  if (err && !r.sent) r.error = err[1];
  return r;
}

async function ping({ host, count, size, dontFragment }) {
  const h = validateHost(host); const c = num(count, 'Count', 1, 10, 4); const s = num(size, 'Size', 0, 9000, 56);
  const args = ['-n', '-c', String(c), '-W', '2', '-w', '20', '-s', String(s)];
  if (c > 1) args.push('-i', '0.3');
  if (dontFragment) args.push('-M', 'do');
  args.push(h);
  const r = await run('ping', args, 30_000);
  if (r.missing) throw new DiagError('ping is not installed on the server (package iputils-ping)', 501);
  const p = parsePing(r.stdout + r.stderr);
  return { tool: 'ping', host: h, ...p, dontFragment: !!dontFragment, raw: (r.stdout + r.stderr).trim() };
}

// ── traceroute ────────────────────────────────────────────────────────────

function parseTraceroute(out) {
  const hops = [];
  for (const line of out.split('\n')) {
    const m = /^\s*(\d+)\s+(.*)$/.exec(line);
    if (!m) continue;
    const rest = m[2].trim();
    const addr = /^(\d{1,3}(?:\.\d{1,3}){3}|[0-9a-f:]{2,39})\s+([\d.]+) ms(?:\s+(![A-Z]*))?/i.exec(rest);
    if (addr) hops.push({ hop: Number(m[1]), address: addr[1], rtt: Number(addr[2]), note: addr[3] || null });
    else hops.push({ hop: Number(m[1]), address: null, rtt: null, note: rest.startsWith('*') ? 'no answer' : rest });
  }
  return hops;
}
function parseTracepath(out) {
  const hops = []; let pmtu = null;
  for (const line of out.split('\n')) {
    const m = /^\s*(\d+)[?:]+\s+(\S.*)$/.exec(line);
    if (m) {
      const ok = /^(\S+)\s+([\d.]+)ms(?:\s+(reached|asymm \d+))?/.exec(m[2]);
      if (ok && !/^\[/.test(ok[1])) hops.push({ hop: Number(m[1]), address: ok[1], rtt: Number(ok[2]), note: ok[3] || null });
      else if (/no reply/.test(m[2])) hops.push({ hop: Number(m[1]), address: null, rtt: null, note: 'no answer' });
      else if (ok) hops.push({ hop: Number(m[1]), address: ok[1].replace(/^\[|\]$/g, ''), rtt: Number(ok[2]), note: ok[3] || null });
    }
    const r = /Resume: pmtu (\d+)/.exec(line); if (r) pmtu = Number(r[1]);
  }
  return { hops, pmtu };
}

async function traceroute({ host, maxHops }) {
  const h = validateHost(host); const m = num(maxHops, 'Maximum hops', 1, 30, 15);
  let r = await run('traceroute', ['-n', '-w', '2', '-q', '1', '-m', String(m), h], m * 2500 + 5000);
  let how = 'traceroute';
  if (r.missing) {
    how = 'tracepath';
    r = await run('tracepath', ['-n', '-m', String(m), h], m * 3500 + 5000);
    if (r.missing) throw new DiagError('Neither traceroute nor tracepath is installed on the server (sudo apt install traceroute)', 501);
  }
  const out = r.stdout + r.stderr;
  const parsed = how === 'traceroute' ? { hops: parseTraceroute(out), pmtu: null } : parseTracepath(out);
  if (!parsed.hops.length && /Name or service not known|unknown host|Temporary failure/i.test(out)) throw new DiagError(`Could not resolve ${h}`);
  return { tool: 'traceroute', host: h, method: how, maxHops: m, hops: parsed.hops, pmtu: parsed.pmtu, timedOut: r.timedOut, raw: out.trim() };
}

// ── DNS, several servers side by side ─────────────────────────────────────

const DNS_TYPES = ['A', 'AAAA', 'MX', 'TXT', 'NS', 'SOA', 'CNAME', 'PTR', 'SRV', 'CAA'];

function normalizeAnswers(type, a) {
  if (!Array.isArray(a)) a = a ? [a] : [];
  switch (type) {
    case 'MX': return a.slice().sort((x, y) => x.priority - y.priority).map((r) => `${r.priority} ${r.exchange}`);
    case 'TXT': return a.map((r) => (Array.isArray(r) ? r.join('') : String(r))).sort();
    case 'SOA': return a.map((r) => `${r.nsname} ${r.hostmaster} serial=${r.serial} refresh=${r.refresh} retry=${r.retry} expire=${r.expire} minttl=${r.minttl}`);
    case 'SRV': return a.map((r) => `${r.priority} ${r.weight} ${r.port} ${r.name}`).sort();
    case 'CAA': return a.map((r) => { const tag = Object.keys(r).find((k) => k !== 'critical' && r[k] !== undefined); return `${r.critical} ${tag} ${r[tag]}`; }).sort();
    default: return a.map(String).sort();
  }
}

async function dnsLookup({ name, type, servers }) {
  const t = String(type || 'A').toUpperCase();
  if (!DNS_TYPES.includes(t)) throw new DiagError(`Type must be one of ${DNS_TYPES.join(', ')}`);
  const q = String(name ?? '').trim().replace(/\.$/, '');
  if (!q) throw new DiagError('Give a name to look up');
  const isIp = net.isIP(q) !== 0;
  if (!isIp && !/^[A-Za-z0-9_*]([A-Za-z0-9_*.-]*[A-Za-z0-9_])?$/.test(q)) throw new DiagError('That is not a valid name');
  if (isIp && t !== 'PTR') throw new DiagError('An IP address can only be looked up as PTR (reverse)');
  const list = Array.isArray(servers) && servers.length ? servers.map(String) : ['system'];
  if (list.length > 4) throw new DiagError('At most four DNS servers at a time');
  for (const s of list) if (s !== 'system' && !validServer(s)) throw new DiagError(`“${s}” is not an IP address`);

  const one = async (server) => {
    const started = process.hrtime.bigint();
    const ms = () => Math.round(Number(process.hrtime.bigint() - started) / 1e5) / 10;
    let resolver = dns.promises;
    if (server !== 'system') { resolver = new dns.promises.Resolver({ timeout: 3000, tries: 1 }); resolver.setServers([server]); }
    try {
      const answers = isIp ? await resolver.reverse(q) : await resolver.resolve(q, t);
      return { server, status: 'ok', answers: normalizeAnswers(t, answers), ms: ms() };
    } catch (e) {
      const status = e.code === 'ENOTFOUND' ? 'nxdomain' : e.code === 'ENODATA' ? 'nodata' : e.code === 'ETIMEOUT' ? 'timeout' : e.code === 'ECONNREFUSED' ? 'refused' : 'error';
      return { server, status, answers: [], ms: ms(), error: ['nxdomain', 'nodata'].includes(status) ? null : (e.code || e.message) };
    }
  };
  const results = await Promise.all(list.map(one));
  const comparable = results.filter((r) => ['ok', 'nodata', 'nxdomain'].includes(r.status));
  const differs = comparable.length > 1 && new Set(comparable.map((r) => `${r.status}|${r.answers.join('\n')}`)).size > 1;
  return { tool: 'dns', name: q, type: t, results, differs };
}

// ── TCP ports ─────────────────────────────────────────────────────────────

function probePort(host, port, timeoutMs) {
  return new Promise((resolve) => {
    const started = Date.now();
    const s = net.connect({ host, port });
    const done = (status, extra = {}) => { s.destroy(); resolve({ port, status, ms: Date.now() - started, ...extra }); };
    s.setTimeout(timeoutMs, () => done('filtered'));
    s.once('connect', () => done('open'));
    s.once('error', (e) => done(e.code === 'ECONNREFUSED' ? 'closed' : 'error', e.code === 'ECONNREFUSED' ? {} : { error: e.code || e.message }));
  });
}

async function ports({ host, ports: list, timeout }) {
  const h = validateHost(host);
  const arr = (Array.isArray(list) ? list : String(list ?? '').split(/[\s,;]+/)).filter((x) => x !== '' && x != null);
  if (!arr.length) throw new DiagError('Give at least one port');
  if (arr.length > 10) throw new DiagError('At most ten ports at a time');
  const nums = arr.map((p) => num(p, 'A port', 1, 65535));
  const ms = num(timeout, 'Timeout (ms)', 500, 10_000, 3000);
  const results = await Promise.all([...new Set(nums)].map((p) => probePort(h, p, ms)));
  return { tool: 'port', host: h, results: results.sort((a, b) => a.port - b.port) };
}

// ── TLS certificate ───────────────────────────────────────────────────────

const certName = (x) => (x ? (x.CN || x.O || Object.values(x).join(', ')) : null);

function tlsCheck({ host, port, servername }) {
  const h = validateHost(host); const p = num(port, 'Port', 1, 65535, 443);
  const sni = servername ? validateHost(servername) : (net.isIP(h) ? undefined : h);
  return new Promise((resolve, reject) => {
    const s = tls.connect({ host: h, port: p, servername: sni, rejectUnauthorized: false, timeout: 6000 }, () => {
      try {
        const c = s.getPeerCertificate(true);
        if (!c || !c.subject) { s.destroy(); return reject(new DiagError('The server presented no certificate', 502)); }
        const chain = []; const seen = new Set(); let cur = c;
        while (cur && cur.fingerprint256 && !seen.has(cur.fingerprint256) && chain.length < 6) { seen.add(cur.fingerprint256); chain.push({ subject: certName(cur.subject), issuer: certName(cur.issuer) }); cur = cur.issuerCertificate; }
        const to = new Date(c.valid_to); const from = new Date(c.valid_from);
        const sans = String(c.subjectaltname || '').split(/,\s*/).map((x) => x.replace(/^(DNS|IP Address):/, '')).filter(Boolean);
        const out = {
          tool: 'tls', host: h, port: p, servername: sni || null, protocol: s.getProtocol(), cipher: s.getCipher()?.name || null,
          subject: certName(c.subject), issuer: certName(c.issuer), sans, serial: c.serialNumber, fingerprint256: c.fingerprint256,
          validFrom: from.toISOString(), validTo: to.toISOString(), daysLeft: Math.floor((to.getTime() - Date.now()) / 86400_000), expired: to.getTime() < Date.now(),
          trusted: s.authorized, trustError: s.authorized ? null : (s.authorizationError || 'not trusted'),
          nameMatches: sni ? tls.checkServerIdentity(sni, c) === undefined : null, chain,
        };
        s.destroy(); resolve(out);
      } catch (e) { s.destroy(); reject(new DiagError(`Could not read the certificate: ${e.message}`, 502)); }
    });
    s.on('timeout', () => { s.destroy(); reject(new DiagError(`No TLS answer from ${h}:${p} within 6 s`, 504)); });
    s.on('error', (e) => reject(new DiagError(`TLS to ${h}:${p} failed: ${e.code || e.message}`, 502)));
  });
}

// ── HTTP(S) with timings ──────────────────────────────────────────────────

const KEEP_HEADERS = ['server', 'content-type', 'content-length', 'location', 'strict-transport-security', 'cache-control', 'set-cookie', 'via', 'x-powered-by'];

function httpStep(url, { method, timeout, ignoreCertErrors }) {
  return new Promise((resolve, reject) => {
    const mod = url.protocol === 'https:' ? https : http;
    const t0 = process.hrtime.bigint(); const at = () => Math.round(Number(process.hrtime.bigint() - t0) / 1e5) / 10;
    const marks = {};
    const req = mod.request(url, { method, timeout, rejectUnauthorized: !ignoreCertErrors, headers: { 'User-Agent': 'InfraLoom-Diagnostics/1', Accept: '*/*' } }, (res) => {
      marks.ttfb = at();
      let bytes = 0;
      res.on('data', (d) => { bytes += d.length; if (bytes > 65536) res.destroy(); });
      const finish = () => resolve({
        url: url.toString(), status: res.statusCode, statusText: res.statusMessage, remote: res.socket?.remoteAddress || null, httpVersion: res.httpVersion,
        headers: Object.fromEntries(KEEP_HEADERS.filter((k) => res.headers[k] !== undefined).map((k) => [k, Array.isArray(res.headers[k]) ? res.headers[k].join('; ') : String(res.headers[k]).slice(0, 300)])),
        timings: { dns: marks.dns ?? null, connect: marks.connect ?? null, tls: marks.tls ?? null, firstByte: marks.ttfb, total: at() },
      });
      res.on('end', finish); res.on('close', finish);
    });
    req.on('socket', (sock) => {
      sock.once('lookup', () => { marks.dns = at(); });
      sock.once('connect', () => { marks.connect = at(); });
      sock.once('secureConnect', () => { marks.tls = at(); });
    });
    req.on('timeout', () => req.destroy(Object.assign(new Error('timeout'), { code: 'ETIMEDOUT' })));
    req.on('error', (e) => reject(new DiagError(`${e.code || 'Error'}: ${e.message}`, 502)));
    req.end();
  });
}

async function httpCheck({ url, method, followRedirects, timeout, ignoreCertErrors }) {
  let u;
  const text = String(url ?? '').trim();
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(text) && !/^https?:\/\//i.test(text)) throw new DiagError('Only http and https addresses');
  try { u = new URL(/^https?:\/\//i.test(text) ? text : `https://${text}`); } catch { throw new DiagError('That is not a valid address'); }
  if (!['http:', 'https:'].includes(u.protocol)) throw new DiagError('Only http and https addresses');
  validateHost(u.hostname);
  const m = ['GET', 'HEAD'].includes(String(method || 'GET').toUpperCase()) ? String(method || 'GET').toUpperCase() : (() => { throw new DiagError('Method must be GET or HEAD'); })();
  const ms = num(timeout, 'Timeout (ms)', 1000, 20_000, 10_000);
  const steps = [];
  for (let i = 0; i < 6; i++) {
    const step = await httpStep(u, { method: m, timeout: ms, ignoreCertErrors: !!ignoreCertErrors });
    steps.push(step);
    if (followRedirects === false || ![301, 302, 303, 307, 308].includes(step.status) || !step.headers.location) break;
    try { u = new URL(step.headers.location, u); } catch { break; }
    validateHost(u.hostname);
    if (!['http:', 'https:'].includes(u.protocol)) break;
  }
  return { tool: 'http', method: m, steps, final: steps[steps.length - 1], redirects: steps.length - 1 };
}

// ── path MTU ──────────────────────────────────────────────────────────────

async function pingOnce(host, size) {
  const r = await run('ping', ['-n', '-c', '1', '-W', '2', '-w', '4', '-M', 'do', '-s', String(size), host], 8000);
  if (r.missing) throw new DiagError('ping is not installed on the server (package iputils-ping)', 501);
  const p = parsePing(r.stdout + r.stderr);
  const mtu = /mtu = (\d+)/.exec(r.stdout + r.stderr);
  return { ok: p.received > 0, hint: mtu ? Number(mtu[1]) : null, error: p.error };
}

async function mtu({ host }) {
  const h = validateHost(host);
  const steps = [];
  const test = async (size) => { const r = await pingOnce(h, size); steps.push({ payload: size, mtu: size + 28, ok: r.ok }); return r; };
  const first = await test(1472);
  if (first.error && !first.ok && /Name or service not known|Temporary failure/i.test(first.error)) throw new DiagError(`Could not resolve ${h}`);
  if (first.ok) {
    const jumbo = await test(8972);
    if (jumbo.ok) return { tool: 'mtu', host: h, mtu: 9000, payload: 8972, steps, note: 'Jumbo frames (9000) pass.' };
    return { tool: 'mtu', host: h, mtu: 1500, payload: 1472, steps, note: 'A full 1500-byte packet passes.' };
  }
  let lo = 0; let hi = 1472;
  if (first.hint && first.hint >= 576 && first.hint < 1500) { lo = first.hint - 28 - 1; const t = await test(first.hint - 28); if (t.ok) return { tool: 'mtu', host: h, mtu: first.hint, payload: first.hint - 28, steps, note: 'A router on the path reported this MTU.' }; }
  for (let i = 0; i < 11 && hi - lo > 1; i++) {
    const mid = Math.floor((lo + hi) / 2);
    const r = await test(mid);
    if (r.ok) lo = mid; else hi = mid;
  }
  if (lo === 0) return { tool: 'mtu', host: h, mtu: null, payload: null, steps, note: 'No packet got through with the don\'t-fragment bit set: the host does not answer ping, or ICMP is blocked.' };
  return { tool: 'mtu', host: h, mtu: lo + 28, payload: lo, steps, note: 'The largest packet that passes without fragmentation.' };
}

const TOOLS = {
  ping, traceroute, dns: dnsLookup, port: ports, tls: tlsCheck, http: httpCheck, mtu,
};
const TIMEOUT_MS = { ping: 40_000, traceroute: 90_000, dns: 15_000, port: 15_000, tls: 15_000, http: 80_000, mtu: 60_000 };

async function runTool(tool, params) {
  const fn = TOOLS[tool];
  if (!fn) throw new DiagError(`Unknown tool “${tool}”`, 404);
  return limited(() => Promise.race([
    fn(params || {}),
    new Promise((_, rej) => { setTimeout(() => rej(new DiagError('The diagnostic took too long and was stopped', 504)), TIMEOUT_MS[tool]).unref(); }),
  ]));
}

module.exports = { runTool, validateHost, parsePing, parseTraceroute, parseTracepath, normalizeAnswers, DiagError, DNS_TYPES, MAX_RUNNING };
