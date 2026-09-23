'use strict';

const axios = require('axios');
const https = require('https');

const httpsAgent = new https.Agent({ rejectUnauthorized: false });
const NODE_NAME = 'host';

function baseUrl(conn) {
  const host = conn.url.replace(/^https?:\/\//, '').replace(/\/$/, '');
  return `https://${host}`;
}

function describeAxiosError(err, context) {
  if (err.response) {
    const body = typeof err.response.data === 'string' ? err.response.data : JSON.stringify(err.response.data);
    return new Error(`${context} — ESXi returned ${err.response.status}: ${(body || '(empty body)').slice(0, 300)}`);
  }
  if (err.request) return new Error(`${context} — no response from ESXi host (${err.code || err.message})`);
  return new Error(`${context} — ${err.message}`);
}

/** Authenticates and returns a session ID, valid for subsequent requests via
 * the `vmware-api-session-id` header. ESXi 7.0+ uses the unprefixed /api/
 * endpoints (the older /rest/ prefix is vCenter-oriented and deprecated). */
async function getSessionId(conn) {
  const auth = Buffer.from(`${conn.username}:${conn.password}`).toString('base64');
  try {
    const res = await axios.post(`${baseUrl(conn)}/api/session`, null, {
      headers: { Authorization: `Basic ${auth}`, 'Content-Type': 'application/json' },
      httpsAgent,
      timeout: 10000,
    });
    return res.data; // a plain JSON string (the session id)
  } catch (err) {
    throw describeAxiosError(err, 'ESXi login failed');
  }
}

async function apiGet(conn, sessionId, path) {
  try {
    const res = await axios.get(`${baseUrl(conn)}${path}`, {
      headers: { 'vmware-api-session-id': sessionId },
      httpsAgent,
      timeout: 15000,
    });
    return res.data;
  } catch (err) {
    throw describeAxiosError(err, `ESXi request failed (GET ${path})`);
  }
}

async function apiPost(conn, sessionId, path, body) {
  try {
    const res = await axios.post(`${baseUrl(conn)}${path}`, body ?? null, {
      headers: { 'vmware-api-session-id': sessionId, 'Content-Type': 'application/json' },
      httpsAgent,
      timeout: 15000,
    });
    return res.data;
  } catch (err) {
    throw describeAxiosError(err, `ESXi request failed (POST ${path})`);
  }
}

/** Fast summary: since standalone ESXi's REST API doesn't expose live host
 * CPU/mem utilization as simply as Proxmox, this reports VM counts (cheap)
 * and marks host-level usage as unavailable rather than guessing. */
async function fetchNodesSummary(conn) {
  const sessionId = await getSessionId(conn);
  const vms = await apiGet(conn, sessionId, '/api/vm');
  const running = vms.filter((v) => v.power_state === 'POWERED_ON').length;

  let hostInfo = {};
  try {
    hostInfo = await apiGet(conn, sessionId, '/api/host');
  } catch {
    // host summary endpoint not available on this ESXi version — VM counts still work
  }

  return [
    {
      node: NODE_NAME, status: 'online',
      cpu_usage: null, mem_usage: null, disk_usage: null,
      mem_used_gb: null, mem_max_gb: null,
      vm_count: vms.length, lxc_count: 0,
      running_count: running,
      host_version: hostInfo?.version || null,
    },
  ];
}

async function fetchNodeDetail(conn) {
  const sessionId = await getSessionId(conn);
  const vms = await apiGet(conn, sessionId, '/api/vm');

  const enriched = await Promise.all(
    vms.map(async (vm) => {
      const running = vm.power_state === 'POWERED_ON';
      let ip = null;
      let os = null;
      if (running) {
        try {
          const identity = await apiGet(conn, sessionId, `/api/vm/${vm.vm}/guest/identity`);
          ip = identity?.ip_address || null;
          os = identity?.full_name?.default || identity?.family || null;
        } catch {
          // VMware Tools not installed/running in the guest — no identity info available
        }
      }
      return {
        vmid: vm.vm, name: vm.name, status: running ? 'running' : 'stopped', type: 'vm',
        os, ip,
        cpu_usage: null, // per-VM live CPU % needs the legacy PerformanceManager API — not exposed here
        mem_used_gb: null, mem_max_gb: vm.memory_size_MiB ? (vm.memory_size_MiB / 1024).toFixed(1) : null,
        mem_usage: null,
        disk_used_gb: null, disk_max_gb: null, disk_usage: 0,
        uptime_s: 0, cpus: vm.cpu_count || 1,
      };
    })
  );

  return { vms: enriched, lxc: [], storages: [] };
}

async function powerAction(conn, node, type, vmid, action) {
  const sessionId = await getSessionId(conn);
  const ACTION_PATH = {
    start: 'start', stop: 'stop', shutdown: 'stop', reboot: 'reset',
    reset: 'reset', suspend: 'suspend', resume: 'start',
  };
  const path = ACTION_PATH[action];
  if (!path) throw new Error(`Unsupported action for ESXi: ${action}`);
  await apiPost(conn, sessionId, `/api/vm/${vmid}/power/${path}`);
}

module.exports = { fetchNodesSummary, fetchNodeDetail, powerAction };
