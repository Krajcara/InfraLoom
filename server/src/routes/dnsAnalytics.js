'use strict';

const express = require('express');
const axios = require('axios');
const https = require('https');
const db = require('../db/database');
const { requireAuth, requireRole } = require('../middleware/auth');
const cf = require('../services/cloudflareAnalytics');

const router = express.Router();
router.use(requireAuth);

const insecureAgent = new https.Agent({ rejectUnauthorized: false });

function getServer(id) {
  return db.prepare('SELECT * FROM dns_local WHERE id = ?').get(id);
}

function getApiBase(server) {
  const ip = (server.ip || '').replace(/\/$/, '');
  return ip.startsWith('http') ? ip : `http://${ip}`;
}

// GET /api/dns-analytics/stats?serverId=&period=LastDay
router.get('/stats', async (req, res) => {
  const { serverId, period = 'LastDay' } = req.query;
  if (!serverId) return res.status(400).json({ error: 'serverId is required' });
  const server = getServer(serverId);
  if (!server) return res.status(404).json({ error: 'Server not found' });
  if (!server.api_key) return res.status(400).json({ error: 'This server has no API token configured' });

  try {
    const base = getApiBase(server);
    const r = await axios.get(`${base}/api/dashboard/stats/get?token=${server.api_key}&type=${period}`, {
      timeout: 15000,
      httpsAgent: insecureAgent,
    });
    res.json(r.data.response);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// GET /api/dns-analytics/top?serverId=&period=LastDay&type=TopDomains&limit=10
router.get('/top', async (req, res) => {
  const { serverId, period = 'LastDay', type = 'TopDomains', limit = 10 } = req.query;
  if (!serverId) return res.status(400).json({ error: 'serverId is required' });
  const server = getServer(serverId);
  if (!server) return res.status(404).json({ error: 'Server not found' });
  if (!server.api_key) return res.status(400).json({ error: 'This server has no API token configured' });

  try {
    const base = getApiBase(server);
    const r = await axios.get(
      `${base}/api/dashboard/stats/getTop?token=${server.api_key}&type=${period}&statsType=${type}&limit=${limit}`,
      { timeout: 15000, httpsAgent: insecureAgent }
    );
    res.json(r.data.response);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ── Cloudflare: the DNS analytics of the domains that are hosted there ───────────────────────────────

const cfh = (fn) => (req, res) => Promise.resolve().then(() => fn(req, res)).catch((e) => {
  if (e instanceof cf.CfError) return res.status(e.status).json({ error: e.message });
  console.error('[dns-analytics/cloudflare]', e); return res.status(500).json({ error: 'Internal error' });
});

// GET /api/dns-analytics/cloudflare/zones — the domains the token sees
router.get('/cloudflare/zones', cfh(async (req, res) => { res.json(await cf.listZones()); }));

// GET /api/dns-analytics/cloudflare/stats?zone=<id|all>&range=24h|7d|30d[&refresh=1]
router.get('/cloudflare/stats', cfh(async (req, res) => {
  const range = String(req.query.range || '24h'); const zone = String(req.query.zone || 'all'); const refresh = req.query.refresh === '1';
  if (!cf.RANGES[range]) return res.status(400).json({ error: `Range must be one of ${Object.keys(cf.RANGES).join(', ')}` });
  if (zone === 'all') return res.json(await cf.allStats(range, { refresh }));
  if (!/^[0-9a-f]{32}$/i.test(zone) && !/^[\w-]{1,64}$/.test(zone)) return res.status(400).json({ error: 'That is not a zone id' });
  const zones = await cf.listZones();
  const z = zones.find((x) => x.id === zone); if (!z) return res.status(404).json({ error: 'The token does not see that zone' });
  res.json({ ...(await cf.zoneStats(zone, range, undefined, { refresh })), name: z.name });
}));

// GET /api/dns-analytics/cloudflare/raw[?zone=] — what Cloudflare last answered to each figure (administrators), to find out why one is missing
router.get('/cloudflare/raw', requireRole('superadmin', 'admin'), (req, res) => res.json(cf.raw(req.query.zone ? String(req.query.zone) : null)));

module.exports = router;
