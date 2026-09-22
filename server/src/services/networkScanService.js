'use strict';

const { spawn } = require('child_process');
const db = require('../db/database');
const { notify } = require('./notificationService');

let scanRunning = false;

function getSetting(key, fallback) {
  return db.prepare('SELECT value FROM settings WHERE key = ?').get(key)?.value ?? fallback;
}

/** Runs `arp-scan` and returns [{ip, mac, vendor}]. Requires either root or
 * the CAP_NET_RAW capability on the arp-scan binary (see install.sh). */
function runArpScan(subnet) {
  return new Promise((resolve, reject) => {
    const args = ['--ignoredups', '--plain', '--format=${ip}\t${mac}\t${vendor}', '--retry=2', '--bandwidth=256k'];
    args.push(subnet && subnet.trim() ? subnet.trim() : '--localnet');

    const child = spawn('arp-scan', args);
    let stdout = '';
    let stderr = '';
    const timer = setTimeout(() => {
      child.kill();
      reject(new Error('arp-scan timed out'));
    }, 60000);

    child.stdout.on('data', (d) => (stdout += d.toString()));
    child.stderr.on('data', (d) => (stderr += d.toString()));
    child.on('error', (err) => {
      clearTimeout(timer);
      reject(new Error(`arp-scan could not be started: ${err.message}`));
    });
    child.on('exit', (code) => {
      clearTimeout(timer);
      if (code !== 0 && !stdout) return reject(new Error(stderr.trim() || `arp-scan exited with code ${code}`));

      const devices = [];
      const seenMac = new Set();
      const re = /^((?:\d{1,3}\.){3}\d{1,3})\t([0-9a-fA-F]{2}(?::[0-9a-fA-F]{2}){5})\t(.*)$/;
      for (const line of stdout.split('\n')) {
        const m = re.exec(line.trim());
        if (!m) continue;
        const mac = m[2].toLowerCase();
        if (seenMac.has(mac)) continue;
        seenMac.add(mac);
        devices.push({ ip: m[1], mac, vendor: m[3].trim() || null });
      }
      resolve(devices);
    });
  });
}

function runScanCycle() {
  if (scanRunning) return Promise.resolve({ skipped: true });
  scanRunning = true;

  const subnet = getSetting('netscan_subnet', '');
  return runArpScan(subnet)
    .then((found) => {
      const foundMacs = new Set(found.map((d) => d.mac));
      const existing = db.prepare('SELECT id, mac, is_online FROM network_devices WHERE is_archived = 0').all();
      const existingByMac = new Map(existing.map((d) => [d.mac.toLowerCase(), d]));
      const io = global.io;

      const upsert = db.prepare(
        `INSERT INTO network_devices (mac, ip, vendor, first_seen, last_seen, is_online, is_new)
         VALUES (?, ?, ?, datetime('now'), datetime('now'), 1, 1)
         ON CONFLICT(mac) DO UPDATE SET ip=excluded.ip, vendor=COALESCE(excluded.vendor, network_devices.vendor),
           last_seen=datetime('now'), is_online=1`
      );
      const logEvent = db.prepare(
        "INSERT INTO network_scan_events (device_id, mac, event_type, ip) VALUES (?, ?, ?, ?)"
      );
      const markOffline = db.prepare("UPDATE network_devices SET is_online = 0 WHERE id = ?");

      for (const d of found) {
        const wasKnown = existingByMac.has(d.mac);
        const wasOnline = wasKnown ? !!existingByMac.get(d.mac).is_online : false;
        upsert.run(d.mac, d.ip, d.vendor);
        const row = db.prepare('SELECT id, name FROM network_devices WHERE mac = ?').get(d.mac);

        if (!wasKnown) {
          logEvent.run(row.id, d.mac, 'new_device', d.ip);
          notify(`New device on the network: ${row.name || d.vendor || d.mac} (${d.ip})`, 'network_new_device');
        } else if (!wasOnline) {
          logEvent.run(row.id, d.mac, 'connected', d.ip);
        }
        if (io) io.emit('netscan:device', { mac: d.mac, ip: d.ip, online: true });
      }

      for (const d of existing) {
        if (d.is_online && !foundMacs.has(d.mac.toLowerCase())) {
          markOffline.run(d.id);
          logEvent.run(d.id, d.mac, 'disconnected', null);
          notify(`Device went offline: ${d.mac}`, 'network_device_offline');
          if (io) io.emit('netscan:device', { mac: d.mac, online: false });
        }
      }

      db.prepare("UPDATE settings SET value = datetime('now') WHERE key = 'netscan_last_run'").run();
      if (io) io.emit('netscan:complete', { found: found.length });
      return { found: found.length };
    })
    .finally(() => {
      scanRunning = false;
    });
}

function isRunning() {
  return scanRunning;
}

let cronTask = null;
function reschedule(cronExpr) {
  const cron = require('node-cron');
  if (cronTask) {
    cronTask.stop();
    cronTask = null;
  }
  if (!cronExpr || !cron.validate(cronExpr)) {
    console.error(`[NetworkScanner] Invalid cron expression "${cronExpr}" — scheduler disabled`);
    return false;
  }
  cronTask = cron.schedule(cronExpr, () => {
    runScanCycle().catch((err) => console.error('[NetworkScanner] Scheduled scan failed:', err.message));
  });
  return true;
}

function initScheduler() {
  reschedule(getSetting('netscan_cron', '*/5 * * * *'));
}

module.exports = { runScanCycle, isRunning, reschedule, initScheduler };
