'use strict';

const express = require('express');
const dnsLib = require('dns').promises;
const axios = require('axios');
const https = require('https');
const db = require('../db/database');
const { requireAuth, requireRole } = require('../middleware/auth');
const { writeAuditLog } = require('../middleware/audit');

const router = express.Router();
router.use(requireAuth);

const DNS_TYPES = {
  technitium: 'Technitium DNS',
  pihole: 'Pi-hole',
  adguard: 'AdGuard Home',
  bind9: 'BIND9',
  windows_dns: 'Windows Server DNS',
  other: 'DNS Server',
};

const insecureAgent = new https.Agent({ rejectUnauthorized: false });

// ── Local DNS servers ────────────────────────────────────────────────────

// GET /api/dns/local
router.get('/local', (req, res) => {
  res.json(db.prepare('SELECT id, role, type, ip, label, created_at FROM dns_local ORDER BY role ASC').all());
});

// POST /api/dns/local — one row per role (primary/backup); upserts
router.post('/local', requireRole('superadmin', 'admin', 'operator'), (req, res) => {
  const { role, type, ip, api_key, label } = req.body || {};
  if (!ip?.trim()) return res.status(400).json({ error: 'IP is required' });
  if (!['primary', 'backup'].includes(role)) return res.status(400).json({ error: 'role must be primary or backup' });

  const existing = db.prepare('SELECT id FROM dns_local WHERE role = ?').get(role);
  if (existing) {
    db.prepare("UPDATE dns_local SET type=?, ip=?, api_key=?, label=?, updated_at=datetime('now') WHERE role=?").run(
      type || 'other', ip.trim(), api_key && api_key !== '***' ? api_key : undefined, label || null, role
    );
    writeAuditLog({ user_id: req.user.id, username: req.user.username, action: 'dns.local_update', module: 'dns', details: { role }, ip_address: req.ip });
    return res.json({ ok: true, id: existing.id });
  }

  const r = db
    .prepare('INSERT INTO dns_local (role, type, ip, api_key, label) VALUES (?,?,?,?,?)')
    .run(role, type || 'other', ip.trim(), api_key || null, label || null);
  writeAuditLog({ user_id: req.user.id, username: req.user.username, action: 'dns.local_create', module: 'dns', details: { role }, ip_address: req.ip });
  res.status(201).json({ ok: true, id: r.lastInsertRowid });
});

// DELETE /api/dns/local/:id
router.delete('/local/:id', requireRole('superadmin', 'admin'), (req, res) => {
  db.prepare('DELETE FROM dns_local WHERE id = ?').run(req.params.id);
  writeAuditLog({ user_id: req.user.id, username: req.user.username, action: 'dns.local_delete', module: 'dns', entity_id: req.params.id, ip_address: req.ip });
  res.json({ ok: true });
});

// GET /api/dns/local/:id/status — reachability + basic stats where supported
router.get('/local/:id/status', async (req, res) => {
  const server = db.prepare('SELECT * FROM dns_local WHERE id = ?').get(req.params.id);
  if (!server) return res.status(404).json({ error: 'Not found' });

  const { type, ip, api_key } = server;
  const baseUrl = ip.startsWith('http') ? ip.replace(/\/$/, '') : `http://${ip}`;
  const dnsIp = ip.replace(/^https?:\/\//, '').split(':')[0];
  const typeLabel = DNS_TYPES[type] || type;

  async function fallbackRawDns() {
    try {
      const resolver = new dnsLib.Resolver();
      resolver.setServers([dnsIp]);
      await new Promise((resolve, reject) => {
        const t = setTimeout(() => reject(new Error('timeout')), 3000);
        resolver.resolve4('cloudflare.com', (err) => {
          clearTimeout(t);
          err ? reject(err) : resolve();
        });
      });
      return { online: true };
    } catch (e) {
      return { online: false, error: e.message };
    }
  }

  try {
    if (type === 'pihole') {
      try {
        const r = await axios.post(`${baseUrl}/api/auth`, { password: api_key || '' }, { timeout: 5000, httpsAgent: insecureAgent });
        if (r.status === 200) return res.json({ online: true, type_label: typeLabel, version: 6 });
      } catch {
        // fall through to v5 / raw
      }
      try {
        const r = await axios.get(`${baseUrl}/admin/api.php?status&auth=${api_key || ''}`, { timeout: 5000, httpsAgent: insecureAgent });
        if (r.data?.status) return res.json({ online: true, type_label: typeLabel, version: 5 });
      } catch {
        // fall through to raw
      }
      return res.json({ ...(await fallbackRawDns()), type_label: typeLabel });
    }

    if (type === 'technitium' && api_key) {
      try {
        const r = await axios.get(`${baseUrl}/api/user/session/get?token=${api_key}`, { timeout: 5000, httpsAgent: insecureAgent });
        if (r.data?.status === 'ok' || r.status === 200) {
          try {
            const s = await axios.get(`${baseUrl}/api/dashboard/stats/get?token=${api_key}&type=LastHour`, { timeout: 5000, httpsAgent: insecureAgent });
            const stats = s.data?.response?.stats;
            return res.json({
              online: true, type_label: typeLabel,
              stats: stats ? { totalQueries: stats.totalQueries || 0, totalBlocked: stats.totalBlocked || 0, totalClients: stats.totalClients || 0 } : null,
            });
          } catch {
            return res.json({ online: true, type_label: typeLabel });
          }
        }
      } catch {
        // fall through to raw
      }
    }

    if (type === 'adguard') {
      try {
        const r = await axios.get(`${baseUrl}/control/status`, { timeout: 5000, httpsAgent: insecureAgent });
        if (r.status === 200) return res.json({ online: true, type_label: typeLabel, running: r.data?.running });
      } catch {
        // fall through to raw
      }
    }

    return res.json({ ...(await fallbackRawDns()), type_label: typeLabel });
  } catch (err) {
    res.json({ online: false, type_label: typeLabel, error: err.message });
  }
});

// ── Monitored domains ────────────────────────────────────────────────────

// GET /api/dns/domains
router.get('/domains', (req, res) => {
  res.json(db.prepare('SELECT * FROM dns_domains ORDER BY domain').all());
});

// POST /api/dns/domains
router.post('/domains', requireRole('superadmin', 'admin', 'operator'), (req, res) => {
  const { domain, notes } = req.body || {};
  if (!domain?.trim()) return res.status(400).json({ error: 'domain is required' });
  try {
    const r = db.prepare('INSERT OR IGNORE INTO dns_domains (domain, notes) VALUES (?, ?)').run(domain.trim().toLowerCase(), notes || null);
    writeAuditLog({ user_id: req.user.id, username: req.user.username, action: 'dns.domain_add', module: 'dns', entity_id: r.lastInsertRowid, details: { domain }, ip_address: req.ip });
    res.status(201).json({ id: r.lastInsertRowid });
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

// DELETE /api/dns/domains/:id
router.delete('/domains/:id', requireRole('superadmin', 'admin', 'operator'), (req, res) => {
  db.prepare('DELETE FROM dns_domains WHERE id = ?').run(req.params.id);
  res.json({ ok: true });
});

// ── Domain email/DNS record check (SPF/DKIM/DMARC/MX/A/NS) ─────────────

async function checkDomain(domain) {
  const result = { domain, spf: null, dkim: null, dmarc: null, mx: [], a: [], ns: [], checked_at: new Date().toISOString() };
  try {
    const [mx, a, txt, ns, dmarc] = await Promise.allSettled([
      dnsLib.resolveMx(domain),
      dnsLib.resolve4(domain),
      dnsLib.resolveTxt(domain),
      dnsLib.resolveNs(domain),
      dnsLib.resolveTxt(`_dmarc.${domain}`),
    ]);
    result.mx = mx.status === 'fulfilled' ? mx.value.sort((x, y) => x.priority - y.priority) : [];
    result.a = a.status === 'fulfilled' ? a.value : [];
    result.ns = ns.status === 'fulfilled' ? ns.value : [];
    const txts = txt.status === 'fulfilled' ? txt.value.map((t) => t.join('')) : [];
    result.spf = txts.find((t) => t.startsWith('v=spf1')) || null;
    result.dmarc = dmarc.status === 'fulfilled' ? dmarc.value.flat().find((t) => t.startsWith('v=DMARC1')) || null : null;

    for (const sel of ['default', 'selector1', 'selector2', 'google', 'k1', 'dkim', 'mail']) {
      try {
        const d = await dnsLib.resolveTxt(`${sel}._domainkey.${domain}`);
        const val = d.flat().join('');
        if (val.includes('v=DKIM1')) {
          result.dkim = { selector: sel, value: val };
          break;
        }
      } catch {
        // selector not present — try the next one
      }
    }
    result.status = 'ok';
  } catch (e) {
    result.status = 'error';
    result.error = e.message;
  }
  return result;
}

// POST /api/dns/check — { domain }
router.post('/check', async (req, res) => {
  const { domain } = req.body || {};
  if (!domain?.trim()) return res.status(400).json({ error: 'domain is required' });
  res.json(await checkDomain(domain.trim().toLowerCase()));
});

// GET /api/dns/check-all — checks every monitored domain
router.get('/check-all', async (req, res) => {
  const domains = db.prepare('SELECT domain FROM dns_domains').all().map((r) => r.domain);
  if (domains.length === 0) return res.json([]);
  res.json(await Promise.all(domains.map(checkDomain)));
});

// ── Cloudflare integration ───────────────────────────────────────────────

// GET /api/dns/cloudflare/config
router.get('/cloudflare/config', (req, res) => {
  const token = db.prepare("SELECT value FROM settings WHERE key='cloudflare_api_token'").get()?.value;
  const zoneId = db.prepare("SELECT value FROM settings WHERE key='cloudflare_zone_id'").get()?.value;
  res.json({ configured: !!token, has_zone_id: !!zoneId });
});

// POST /api/dns/cloudflare/config — { token, zone_id }
router.post('/cloudflare/config', requireRole('superadmin', 'admin'), (req, res) => {
  const { token, zone_id } = req.body || {};
  if (token && token !== '***') {
    db.prepare("INSERT INTO settings (key,value,updated_at) VALUES ('cloudflare_api_token',?,datetime('now')) ON CONFLICT(key) DO UPDATE SET value=excluded.value, updated_at=excluded.updated_at").run(token);
  }
  if (zone_id !== undefined) {
    db.prepare("INSERT INTO settings (key,value,updated_at) VALUES ('cloudflare_zone_id',?,datetime('now')) ON CONFLICT(key) DO UPDATE SET value=excluded.value, updated_at=excluded.updated_at").run(zone_id || null);
  }
  writeAuditLog({ user_id: req.user.id, username: req.user.username, action: 'dns.cloudflare_config', module: 'dns', ip_address: req.ip });
  res.json({ ok: true });
});

// GET /api/dns/cloudflare/zones — zones + email DNS record check per zone
router.get('/cloudflare/zones', async (req, res) => {
  const token = db.prepare("SELECT value FROM settings WHERE key='cloudflare_api_token'").get()?.value;
  const zoneId = db.prepare("SELECT value FROM settings WHERE key='cloudflare_zone_id'").get()?.value;
  if (!token) return res.status(400).json({ error: 'Cloudflare API token not configured' });

  const hdrs = { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' };
  const opts = { timeout: 15000 };

  try {
    let zones = [];
    if (zoneId) {
      try {
        const r = await axios.get(`https://api.cloudflare.com/client/v4/zones/${zoneId}`, { headers: hdrs, ...opts });
        if (r.data.success) zones = [r.data.result];
      } catch {
        // fall through to listing all zones
      }
    }
    if (!zones.length) {
      const r = await axios.get('https://api.cloudflare.com/client/v4/zones?per_page=50&status=active', { headers: hdrs, ...opts });
      if (!r.data.success) return res.status(502).json({ error: r.data.errors?.[0]?.message || 'Cloudflare API error' });
      zones = r.data.result || [];
    }

    const results = await Promise.all(
      zones.map(async (z) => {
        const domainName = z.name;
        const [mxR, txtR, dmarcR] = await Promise.allSettled([
          dnsLib.resolveMx(domainName),
          dnsLib.resolveTxt(domainName),
          dnsLib.resolveTxt(`_dmarc.${domainName}`),
        ]);
        const txts = txtR.status === 'fulfilled' ? txtR.value.flat() : [];
        const dmarcs = dmarcR.status === 'fulfilled' ? dmarcR.value.flat() : [];
        const mxs = mxR.status === 'fulfilled' ? mxR.value.sort((a, b) => a.priority - b.priority) : [];

        let dkim = null;
        for (const sel of ['default', 'selector1', 'selector2', 'google', 'k1', 'dkim', 'mail']) {
          try {
            const d = await dnsLib.resolveTxt(`${sel}._domainkey.${domainName}`);
            const val = d.flat().join('');
            if (val.includes('v=DKIM1')) {
              dkim = { selector: sel, value: val };
              break;
            }
          } catch {
            // try next selector
          }
        }

        return {
          zone_id: z.id, domain: domainName, status: z.status,
          spf: txts.find((t) => t.startsWith('v=spf1')) || null,
          dmarc: dmarcs.find((t) => t.startsWith('v=DMARC1')) || null,
          dkim, mx: mxs, checked_at: new Date().toISOString(),
        };
      })
    );
    res.json(results);
  } catch (err) {
    if (err.code === 'ETIMEDOUT' || err.code === 'ECONNRESET') {
      return res.status(502).json({ error: 'Cloudflare API unreachable from this server' });
    }
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
