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

// FortiOS monitor endpoints are path/name/ACTION — the bare
// ".../managed-switch" returns a 404 with "action":"" (that's what the
// first version of this hit). The live-status action is "/status"; the
// cmdb (configuration) list is a fallback that at least discovers the
// switches even though it carries no live connection state.
const SWITCH_ENDPOINTS = [
  '/api/v2/monitor/switch-controller/managed-switch/status',
  '/api/v2/cmdb/switch-controller/managed-switch',
];
const AP_ENDPOINTS = ['/api/v2/monitor/wifi/managed_ap'];

/** 'up' | 'down' | null (null = the response doesn't say, don't guess). */
function liveStatus(...values) {
  const v = values.filter((x) => typeof x === 'string').map((x) => x.trim().toLowerCase());
  if (v.some((x) => /disconnect|offline|down|not connected/.test(x))) return 'down';
  if (v.some((x) => /^(connected|online|up)$/.test(x))) return 'up';
  return null;
}

// "S124EP-v7.2.8-build…" / "FP231F-v7.4.5-build…" → "S124EP" / "FP231F"
function modelFromOs(osVersion) {
  const m = /^([A-Za-z0-9]+)-v\d/.exec(osVersion || '');
  return m ? m[1] : null;
}

// FortiLink management addresses are link-local (169.254.x.x) — useless
// as a reachable address, so don't let them overwrite a real/manual IP.
function usableIp(ip) {
  return ip && typeof ip === 'string' && !ip.startsWith('169.254.') && ip !== '0.0.0.0' ? ip : null;
}

async function firstWorking(api, endpoints) {
  let lastErr;
  for (const path of endpoints) {
    try {
      const res = await api.get(path, { params: { vdom: 'root' } });
      return { path, results: res.data?.results || [] };
    } catch (err) {
      lastErr = err;
      if (err.response?.status !== 404) break; // only a 404 means "try the next candidate"
    }
  }
  throw lastErr;
}

function describeError(err) {
  const s = err.response?.status;
  if (s === 401 || s === 403) return `HTTP ${s} — token rejected or its admin profile can't read this (check the REST API admin's profile and Trusted Hosts)`;
  if (s === 404) return '404 — endpoint not found on this FortiGate/FortiOS version';
  return err.message;
}

/** Returns { switches, accessPoints, errors, debug }. Switches and APs are
 * fetched independently so one failing doesn't discard the other. `debug`
 * carries the endpoint that worked and the first raw item of each list, so
 * a field-name mismatch can be diagnosed without guessing. */
async function fetchManagedDevices(router) {
  if (!router.api_token) throw new Error('This router has no API token configured — generate one in FortiGate (System > Administrators > REST API Admin) and add it here.');
  const api = client(router);
  const errors = {};
  const debug = {};

  let switches = [];
  try {
    const { path, results } = await firstWorking(api, SWITCH_ENDPOINTS);
    debug.switchesEndpoint = path;
    debug.switchesSample = results[0] || null;
    switches = results
      .map((s) => ({
        serial: s.serial || s['switch-id'] || s.name,
        name: s.name || s['switch-id'] || s.serial,
        model: s.model || modelFromOs(s.os_version) || null,
        ip_address: usableIp(s.connecting_from || s['connecting-from'] || s.ip),
        status: liveStatus(s.status, s.connection_status, s.connection_state),
      }))
      .filter((s) => s.serial);
  } catch (err) {
    errors.switches = describeError(err);
  }

  let accessPoints = [];
  try {
    const { path, results } = await firstWorking(api, AP_ENDPOINTS);
    debug.accessPointsEndpoint = path;
    debug.accessPointsSample = results[0] || null;
    accessPoints = results
      .map((a) => ({
        serial: a.serial || a.wtp_id || a.name,
        name: a.name || a.serial,
        model: a.model || modelFromOs(a.os_version) || a.wtp_profile || null,
        ip_address: usableIp(a.local_ipv4_addr || a['local-ipv4-addr'] || a.ip),
        status: liveStatus(a.connection_state, a.status, a.state),
      }))
      .filter((a) => a.serial);
  } catch (err) {
    errors.accessPoints = describeError(err);
  }

  return { switches, accessPoints, errors, debug };
}

module.exports = { fetchManagedDevices, liveStatus, modelFromOs, usableIp };
