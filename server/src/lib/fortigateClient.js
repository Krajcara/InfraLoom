'use strict';

const axios = require('axios');
const https = require('https');

const httpsAgent = new https.Agent({ rejectUnauthorized: false });

function client(router) {
  return axios.create({
    baseURL: `https://${router.ip_address}`,
    httpsAgent,
    timeout: 15000,
    headers: { Authorization: `Bearer ${router.api_token}` },
  });
}

/** Returns { switches: [...], accessPoints: [...] }, each item normalized
 * to { serial, name, model, ip_address, status }. Throws with a clear
 * message on auth/network failure. */
async function fetchManagedDevices(router) {
  if (!router.api_token) throw new Error('This router has no API token configured — generate one in FortiGate (System > Administrators > REST API Admin) and add it here.');
  const api = client(router);

  const [switchRes, apRes] = await Promise.all([
    api.get('/api/v2/monitor/switch-controller/managed-switch', { params: { vdom: 'root' } }).catch((err) => {
      throw new Error(`Could not fetch managed switches: ${err.response?.status === 401 ? 'invalid API token' : err.response?.status === 404 ? '404 — endpoint not found (see note below)' : err.message}`);
    }),
    api.get('/api/v2/monitor/wifi/managed_ap', { params: { vdom: 'root' } }).catch((err) => {
      throw new Error(`Could not fetch managed access points: ${err.response?.status === 401 ? 'invalid API token' : err.response?.status === 404 ? '404 — endpoint not found (see note below)' : err.message}`);
    }),
  ]);

  const switches = (switchRes.data?.results || []).map((s) => ({
    serial: s.serial,
    name: s.name || s['switch-id'] || s.serial,
    model: s['switch-id']?.split('-').slice(0, -1).join('-') || s.name || null,
    ip_address: s['connecting-from'] || s.ip || null,
    status: s.status === 'authorized' && s.connection_status === 'connected' ? 'up' : 'down',
  }));

  const accessPoints = (apRes.data?.results || []).map((a) => ({
    serial: a.serial,
    name: a.name || a.serial,
    model: a.wtp_profile || null,
    ip_address: a.local_ipv4_addr || a.ip || null,
    status: a.status === 'connected' || a.connection_state === 'Connected' ? 'up' : 'down',
  }));

  return { switches, accessPoints };
}

module.exports = { fetchManagedDevices };
