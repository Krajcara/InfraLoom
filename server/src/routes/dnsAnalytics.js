'use strict';

const express = require('express');
const axios = require('axios');
const https = require('https');
const db = require('../db/database');
const { requireAuth } = require('../middleware/auth');

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

module.exports = router;
