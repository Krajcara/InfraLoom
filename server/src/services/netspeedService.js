'use strict';

const https = require('https');
const http = require('http');
const { spawn } = require('child_process');
const db = require('../db/database');

let testRunning = false;
let cronTask = null;

function getSetting(key, fallback) {
  return db.prepare('SELECT value FROM settings WHERE key = ?').get(key)?.value ?? fallback;
}

// ── Cloudflare provider — raw HTTP, no binary needed (ported from v1) ───

function measurePing(host = 'cloudflare.com', count = 5) {
  return new Promise((resolve) => {
    const { exec } = require('child_process');
    exec(`ping -c ${count} -W 3 ${host}`, { timeout: 15000 }, (err, stdout) => {
      if (err) return resolve(null);
      const m = stdout.match(/rtt min\/avg\/max\/mdev = ([\d.]+)\/([\d.]+)\/([\d.]+)/);
      resolve(m ? parseFloat(m[2]) : null);
    });
  });
}

function measureCloudflareDownload() {
  return new Promise((resolve) => {
    const urls = ['https://speed.cloudflare.com/__down?bytes=25000000', 'http://proof.ovh.net/files/10Mb.dat'];
    let tried = 0;

    function tryUrl() {
      if (tried >= urls.length) return resolve(null);
      const u = urls[tried++];
      const start = Date.now();
      let bytes = 0;
      const proto = u.startsWith('https') ? https : http;

      const req = proto.get(u, { timeout: 30000, headers: { 'User-Agent': 'curl/7.68.0' } }, (res) => {
        if (res.statusCode !== 200) {
          req.destroy();
          return tryUrl();
        }
        res.on('data', (chunk) => (bytes += chunk.length));
        res.on('end', () => {
          const elapsed = (Date.now() - start) / 1000;
          if (elapsed < 0.5 || bytes < 1000) return tryUrl();
          resolve(Math.round(((bytes * 8) / elapsed / 1_000_000) * 10) / 10);
        });
        res.on('error', () => tryUrl());
      });
      req.setTimeout(30000, () => {
        req.destroy();
        tryUrl();
      });
      req.on('error', () => tryUrl());
    }
    tryUrl();
  });
}

function measureCloudflareUpload() {
  return new Promise((resolve) => {
    const SIZE = 5 * 1024 * 1024;
    const data = Buffer.alloc(SIZE, 'x');
    const start = Date.now();
    const req = https.request(
      {
        hostname: 'speed.cloudflare.com',
        path: '/__up',
        method: 'POST',
        timeout: 30000,
        headers: { 'Content-Type': 'application/octet-stream', 'Content-Length': SIZE, 'User-Agent': 'curl/7.68.0' },
      },
      (res) => {
        res.resume();
        res.on('end', () => {
          const elapsed = (Date.now() - start) / 1000;
          if (elapsed < 0.2) return resolve(null);
          resolve(Math.round(((SIZE * 8) / elapsed / 1_000_000) * 10) / 10);
        });
      }
    );
    req.setTimeout(30000, () => {
      req.destroy();
      resolve(null);
    });
    req.on('error', () => resolve(null));
    req.write(data);
    req.end();
  });
}

async function runCloudflareTest() {
  const ping = await measurePing('cloudflare.com', 5);
  const download = await measureCloudflareDownload();
  const upload = await measureCloudflareUpload();
  if (!download) throw new Error('Download test failed — check internet connectivity');
  return { download, upload: upload || null, ping: ping || null, jitter: null, server: 'Cloudflare speed.cloudflare.com' };
}

// ── Ookla / LibreSpeed providers — official CLI, JSON output ────────────

function spawnCli(binaryPath, args, timeoutMs = 60000) {
  return new Promise((resolve, reject) => {
    const child = spawn(binaryPath, args, { windowsHide: true });
    let stdout = '';
    let stderrMsg = null;
    const timer = setTimeout(() => {
      child.kill();
      reject(new Error('Speed test timed out'));
    }, timeoutMs);

    child.stderr.on('data', (buf) => {
      stderrMsg = buf.toString();
    });
    child.stdout.on('data', (buf) => {
      stdout += buf.toString();
    });
    child.on('error', (err) => {
      clearTimeout(timer);
      reject(err);
    });
    child.on('exit', () => {
      clearTimeout(timer);
      const lines = stdout.trim().split('\n');
      for (const line of lines) {
        if (!(line.startsWith('{') || line.startsWith('['))) continue;
        try {
          let data = JSON.parse(line);
          if (Array.isArray(data)) data = data[0];
          if (data.error) return reject(new Error(data.error));
          return resolve(data);
        } catch {
          // not a JSON line we care about — keep scanning
        }
      }
      reject(new Error(stderrMsg || 'No result from speed test CLI'));
    });
  });
}

async function runOoklaTest() {
  const { ensureOokla } = require('../lib/speedtestBinaries');
  const binaryPath = await ensureOokla();
  const data = await spawnCli(binaryPath, ['--accept-license', '--accept-gdpr', '--format=json'], 90000);
  return {
    download: Math.round((data.download.bandwidth / 125000) * 100) / 100, // bytes/s -> Mbps
    upload: Math.round((data.upload.bandwidth / 125000) * 100) / 100,
    ping: Math.round(data.ping.latency),
    jitter: data.ping.jitter ? Math.round(data.ping.jitter * 100) / 100 : null,
    server: data.server?.name || data.server?.host || 'Ookla',
  };
}

async function runLibrespeedTest() {
  const { ensureLibrespeed } = require('../lib/speedtestBinaries');
  const binaryPath = await ensureLibrespeed();
  const data = await spawnCli(binaryPath, ['--json', '--duration=5'], 90000);
  return {
    download: Math.round(data.download * 100) / 100,
    upload: Math.round(data.upload * 100) / 100,
    ping: Math.round(data.ping),
    jitter: data.jitter ? Math.round(parseFloat(data.jitter) * 100) / 100 : null,
    server: data.server?.name || data.server?.url || 'LibreSpeed',
  };
}

async function runTest(provider) {
  switch (provider) {
    case 'ookla':
      return runOoklaTest();
    case 'librespeed':
      return runLibrespeedTest();
    default:
      return runCloudflareTest();
  }
}

// ── Persist + notify + retention ─────────────────────────────────────────

function pruneOld() {
  const days = parseInt(getSetting('netspeed_retention_days', '90'), 10) || 90;
  const cutoff = new Date(Date.now() - days * 86400000).toISOString().replace('T', ' ').substring(0, 19);
  db.prepare('DELETE FROM speed_tests WHERE created_at < ?').run(cutoff);
}

async function executeTest(triggeredBy = 'manual') {
  if (testRunning) throw new Error('A test is already running');
  testRunning = true;

  const provider = getSetting('netspeed_provider', 'cloudflare');
  const row = db
    .prepare("INSERT INTO speed_tests (provider, status, triggered_by, created_at) VALUES (?, 'running', ?, datetime('now'))")
    .run(provider, triggeredBy);
  const id = row.lastInsertRowid;
  const io = global.io;
  if (io) io.emit('netspeed:started', { id, provider });

  try {
    const result = await runTest(provider);
    db.prepare("UPDATE speed_tests SET status='done', download=?, upload=?, ping=?, jitter=?, server=? WHERE id=?").run(
      result.download, result.upload, result.ping, result.jitter || null, result.server, id
    );
    const saved = db.prepare('SELECT * FROM speed_tests WHERE id = ?').get(id);
    if (io) io.emit('netspeed:done', { test: saved });
    pruneOld();
    return saved;
  } catch (err) {
    db.prepare("UPDATE speed_tests SET status='error', error=? WHERE id=?").run(err.message, id);
    if (io) io.emit('netspeed:error', { id, error: err.message });
    throw err;
  } finally {
    testRunning = false;
  }
}

function isRunning() {
  return testRunning;
}

// ── Scheduling — cron expression is user-configurable, re-applied live ──

function reschedule(cronExpr) {
  const cron = require('node-cron');
  if (cronTask) {
    cronTask.stop();
    cronTask = null;
  }
  if (!cronExpr || !cron.validate(cronExpr)) {
    console.error(`[NetSpeed] Invalid cron expression "${cronExpr}" — scheduler disabled`);
    return false;
  }
  cronTask = cron.schedule(cronExpr, () => {
    executeTest('auto').catch((err) => console.error('[NetSpeed] Scheduled test failed:', err.message));
  });
  return true;
}

function initScheduler() {
  reschedule(getSetting('netspeed_cron', '0 * * * *'));
}

module.exports = { executeTest, isRunning, reschedule, initScheduler, pruneOld };
