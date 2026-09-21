'use strict';

const net = require('net');
const dns = require('dns').promises;
const http = require('http');
const https = require('https');
const axios = require('axios');
const db = require('../db/database');

const MAX_CONCURRENT = 10;
const timers = new Map();
let running = 0;
let pushSweepTimer = null;

// ── Check functions ──────────────────────────────────────────────────────

async function checkHttp(monitor, { requireKeyword = false, requireJson = false } = {}) {
  const start = Date.now();
  try {
    let url = monitor.target;
    if (!url.startsWith('http://') && !url.startsWith('https://')) {
      url = monitor.type === 'https' ? `https://${url}` : `http://${url}`;
    }
    const agent = url.startsWith('https://') ? new https.Agent({ rejectUnauthorized: false }) : undefined;
    const res = await axios.get(url, {
      timeout: (monitor.timeout_s || 10) * 1000,
      validateStatus: () => true,
      maxRedirects: 5,
      httpsAgent: agent,
      headers: { 'User-Agent': 'InfraLoom/1.0' },
    });
    const latency_ms = Date.now() - start;
    const expectedCode = monitor.expected_status || 200;
    const statusOk = res.status === expectedCode || (expectedCode === 200 && res.status >= 200 && res.status < 400);
    if (!statusOk) {
      return { status: 'down', latency_ms, status_code: res.status, error_msg: `HTTP ${res.status} (expected ${expectedCode})` };
    }

    if (requireKeyword) {
      const body = typeof res.data === 'string' ? res.data : JSON.stringify(res.data);
      if (!monitor.keyword || !body.includes(monitor.keyword)) {
        return { status: 'down', latency_ms, status_code: res.status, error_msg: `Keyword "${monitor.keyword}" not found` };
      }
    }

    if (requireJson) {
      const value = getJsonPath(res.data, monitor.json_path);
      const expected = monitor.json_expected;
      if (String(value) !== String(expected)) {
        return {
          status: 'down', latency_ms, status_code: res.status,
          error_msg: `JSON path "${monitor.json_path}" = ${JSON.stringify(value)}, expected ${JSON.stringify(expected)}`,
        };
      }
    }

    const degraded = latency_ms > (monitor.timeout_s || 10) * 800;
    return { status: degraded ? 'degraded' : 'up', latency_ms, status_code: res.status };
  } catch (err) {
    return { status: 'down', latency_ms: Date.now() - start, error_msg: err.message?.substring(0, 200) };
  }
}

function getJsonPath(obj, path) {
  if (!path) return undefined;
  return path.split('.').reduce((acc, key) => (acc == null ? undefined : acc[key]), obj);
}

async function checkTcp(monitor) {
  const start = Date.now();
  const port = monitor.port || 80;
  return new Promise((resolve) => {
    const socket = new net.Socket();
    const timeout = (monitor.timeout_s || 10) * 1000;
    socket.setTimeout(timeout);
    socket.connect(port, monitor.target, () => {
      socket.destroy();
      resolve({ status: 'up', latency_ms: Date.now() - start });
    });
    socket.on('error', (err) => resolve({ status: 'down', latency_ms: Date.now() - start, error_msg: err.message }));
    socket.on('timeout', () => {
      socket.destroy();
      resolve({ status: 'down', latency_ms: timeout, error_msg: 'Connection timeout' });
    });
  });
}

async function checkIcmp(monitor) {
  const start = Date.now();
  try {
    const { execSync } = require('child_process');
    execSync(`ping -c 1 -W ${monitor.timeout_s || 5} ${monitor.target}`, { timeout: (monitor.timeout_s || 10) * 1000 });
    return { status: 'up', latency_ms: Date.now() - start };
  } catch {
    return { status: 'down', latency_ms: Date.now() - start, error_msg: 'Host not responding to ping' };
  }
}

async function checkDns(monitor) {
  const start = Date.now();
  try {
    await dns.resolve(monitor.target);
    return { status: 'up', latency_ms: Date.now() - start };
  } catch (err) {
    return { status: 'down', latency_ms: Date.now() - start, error_msg: err.message };
  }
}

/** Docker container health via the local Docker Engine API over its unix socket. */
async function checkDocker(monitor) {
  const start = Date.now();
  const containerRef = monitor.docker_container || monitor.target;
  return new Promise((resolve) => {
    const req = http.request(
      {
        socketPath: '/var/run/docker.sock',
        path: `/containers/${encodeURIComponent(containerRef)}/json`,
        method: 'GET',
        timeout: (monitor.timeout_s || 10) * 1000,
      },
      (res) => {
        let data = '';
        res.on('data', (chunk) => (data += chunk));
        res.on('end', () => {
          const latency_ms = Date.now() - start;
          if (res.statusCode !== 200) {
            return resolve({ status: 'down', latency_ms, error_msg: `Docker API returned ${res.statusCode}` });
          }
          try {
            const info = JSON.parse(data);
            const state = info.State || {};
            if (state.Health && state.Health.Status) {
              const healthy = state.Health.Status === 'healthy';
              return resolve({ status: healthy ? 'up' : 'down', latency_ms, error_msg: healthy ? null : `Health: ${state.Health.Status}` });
            }
            const isRunning = !!state.Running;
            return resolve({ status: isRunning ? 'up' : 'down', latency_ms, error_msg: isRunning ? null : 'Container not running' });
          } catch {
            resolve({ status: 'down', latency_ms, error_msg: 'Could not parse Docker response' });
          }
        });
      }
    );
    req.on('error', (err) => resolve({ status: 'down', latency_ms: Date.now() - start, error_msg: `Docker socket error: ${err.message}` }));
    req.on('timeout', () => {
      req.destroy();
      resolve({ status: 'down', latency_ms: Date.now() - start, error_msg: 'Docker check timeout' });
    });
    req.end();
  });
}

// ── Run one check ────────────────────────────────────────────────────────

async function runCheck(monitor) {
  if (monitor.type === 'push') return; // push monitors are updated by the client, not polled
  if (running >= MAX_CONCURRENT) return;
  running++;
  let result;
  try {
    switch (monitor.type) {
      case 'http':
      case 'https':
        result = await checkHttp(monitor);
        break;
      case 'keyword':
        result = await checkHttp(monitor, { requireKeyword: true });
        break;
      case 'json_query':
        result = await checkHttp(monitor, { requireJson: true });
        break;
      case 'tcp':
        result = await checkTcp(monitor);
        break;
      case 'icmp':
        result = await checkIcmp(monitor);
        break;
      case 'dns':
        result = await checkDns(monitor);
        break;
      case 'docker':
        result = await checkDocker(monitor);
        break;
      default:
        result = { status: 'down', error_msg: `Unknown type: ${monitor.type}` };
    }
  } catch (err) {
    result = { status: 'down', error_msg: err.message };
  } finally {
    running--;
  }

  recordResult(monitor, result);
}

function recordResult(monitor, result) {
  const prevStatus = monitor.last_status;
  const newStatus = result.status;

  try {
    db.prepare(
      `INSERT INTO monitor_checks (monitor_id, status, latency_ms, status_code, error_msg, checked_at)
       VALUES (?, ?, ?, ?, ?, datetime('now'))`
    ).run(monitor.id, newStatus, result.latency_ms || null, result.status_code || null, result.error_msg || null);

    db.prepare(`UPDATE monitors SET last_status=?, last_latency_ms=?, last_checked_at=datetime('now') WHERE id=?`).run(
      newStatus,
      result.latency_ms || null,
      monitor.id
    );
  } catch (err) {
    console.error('[Monitor] DB write error:', err.message);
  }

  const io = global.io;
  if (io) {
    io.emit('monitor:status', { monitorId: monitor.id, status: newStatus, latency_ms: result.latency_ms, checked_at: new Date().toISOString() });
  }

  if (prevStatus && prevStatus !== 'unknown' && prevStatus !== newStatus) {
    const { notify } = require('./notificationService');
    if (newStatus === 'down') {
      notify(`InfraLoom — monitor DOWN: ${monitor.label} (${monitor.target}). ${result.error_msg || ''}`.trim());
    } else if (newStatus === 'up') {
      notify(`InfraLoom — monitor RECOVERED: ${monitor.label} (${monitor.target}) is back online.`);
    }
  }
}

// ── Push monitors: staleness sweep ──────────────────────────────────────

function sweepPushMonitors() {
  try {
    const pushMonitors = db.prepare("SELECT * FROM monitors WHERE type = 'push' AND enabled = 1").all();
    for (const m of pushMonitors) {
      const graceMs = ((m.push_interval_s || 60) + 10) * 1000;
      const stale = !m.last_push_at || Date.now() - new Date(m.last_push_at).getTime() > graceMs;
      const shouldBeStatus = stale ? 'down' : 'up';
      if (m.last_status !== shouldBeStatus) {
        recordResult(m, { status: shouldBeStatus, error_msg: stale ? 'No heartbeat received in time' : null });
      }
    }
  } catch (err) {
    console.error('[Monitor] Push sweep error:', err.message);
  }
}

// ── Register / unregister / init ─────────────────────────────────────────

function registerMonitor(monitor) {
  if (timers.has(monitor.id)) clearInterval(timers.get(monitor.id));
  if (!monitor.enabled || monitor.type === 'push') return;
  const ms = (parseInt(monitor.interval_s, 10) || 60) * 1000;
  const t = setInterval(() => {
    try {
      const m = db.prepare('SELECT * FROM monitors WHERE id = ?').get(monitor.id);
      if (m && m.enabled) runCheck(m);
    } catch {
      // monitor may have been deleted between tick and lookup — ignore
    }
  }, ms);
  timers.set(monitor.id, t);
  setTimeout(() => {
    try {
      const m = db.prepare('SELECT * FROM monitors WHERE id = ?').get(monitor.id);
      if (m && m.enabled) runCheck(m);
    } catch {
      // ignore
    }
  }, 1500);
}

function unregisterMonitor(monitorId) {
  if (timers.has(monitorId)) {
    clearInterval(timers.get(monitorId));
    timers.delete(monitorId);
  }
}

function initMonitorWorker() {
  try {
    const monitors = db.prepare('SELECT * FROM monitors WHERE enabled = 1').all();
    for (const m of monitors) registerMonitor(m);
    if (!pushSweepTimer) pushSweepTimer = setInterval(sweepPushMonitors, 30000);
    console.log(`[Monitor] Worker started — ${monitors.length} monitor(s)`);
  } catch (err) {
    console.error('[Monitor] Init error:', err.message);
  }
}

module.exports = { initMonitorWorker, registerMonitor, unregisterMonitor, runCheck, recordResult };
