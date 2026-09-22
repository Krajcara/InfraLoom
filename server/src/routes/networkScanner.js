'use strict';

const express = require('express');
const db = require('../db/database');
const { requireAuth, requireRole } = require('../middleware/auth');
const { writeAuditLog } = require('../middleware/audit');
const scanner = require('../services/networkScanService');
const nmap = require('../lib/nmapScan');
const { sendWol } = require('../lib/wol');

const router = express.Router();
router.use(requireAuth);

// GET /api/network-scanner/devices?online=1&search=
router.get('/devices', (req, res) => {
  const { online, search, favorite } = req.query;
  let sql = 'SELECT * FROM network_devices WHERE is_archived = 0';
  const params = [];
  if (online === '1') sql += ' AND is_online = 1';
  if (online === '0') sql += ' AND is_online = 0';
  if (favorite === '1') sql += ' AND is_favorite = 1';
  if (search?.trim()) {
    sql += ' AND (mac LIKE ? OR ip LIKE ? OR name LIKE ? OR vendor LIKE ?)';
    const term = `%${search.trim()}%`;
    params.push(term, term, term, term);
  }
  sql += ' ORDER BY is_online DESC, last_seen DESC';
  const devices = db.prepare(sql).all(...params);
  res.json({ devices });
});

// GET /api/network-scanner/status
router.get('/status', (req, res) => {
  const total = db.prepare('SELECT COUNT(*) as n FROM network_devices WHERE is_archived = 0').get().n;
  const online = db.prepare('SELECT COUNT(*) as n FROM network_devices WHERE is_archived = 0 AND is_online = 1').get().n;
  const lastRun = db.prepare("SELECT value FROM settings WHERE key = 'netscan_last_run'").get()?.value || null;
  res.json({ total, online, lastRun, scanning: scanner.isRunning() });
});

// POST /api/network-scanner/scan — trigger an arp-scan cycle now
router.post('/scan', requireRole('superadmin', 'admin', 'operator'), async (req, res) => {
  if (scanner.isRunning()) return res.status(409).json({ error: 'A scan is already running' });
  res.json({ ok: true, message: 'Scan started' });
  try {
    await scanner.runScanCycle();
  } catch (err) {
    console.error('[NetworkScanner] Manual scan error:', err.message);
  }
});

// PUT /api/network-scanner/devices/:id — edit name/notes/favorite
router.put('/devices/:id', requireRole('superadmin', 'admin', 'operator'), (req, res) => {
  const { name, notes, is_favorite } = req.body || {};
  const existing = db.prepare('SELECT * FROM network_devices WHERE id = ?').get(req.params.id);
  if (!existing) return res.status(404).json({ error: 'Not found' });

  db.prepare('UPDATE network_devices SET name = ?, notes = ?, is_favorite = ?, is_new = 0 WHERE id = ?').run(
    name !== undefined ? name : existing.name,
    notes !== undefined ? notes : existing.notes,
    is_favorite !== undefined ? (is_favorite ? 1 : 0) : existing.is_favorite,
    req.params.id
  );
  res.json({ ok: true });
});

// DELETE /api/network-scanner/devices/:id — archive (soft-delete, keeps history)
router.delete('/devices/:id', requireRole('superadmin', 'admin'), (req, res) => {
  db.prepare('UPDATE network_devices SET is_archived = 1 WHERE id = ?').run(req.params.id);
  writeAuditLog({ user_id: req.user.id, username: req.user.username, action: 'netscan.device_archive', module: 'network_scanner', entity_id: req.params.id, ip_address: req.ip });
  res.json({ ok: true });
});

// POST /api/network-scanner/devices/:id/dismiss-new — clear the "new" badge
router.post('/devices/:id/dismiss-new', (req, res) => {
  db.prepare('UPDATE network_devices SET is_new = 0 WHERE id = ?').run(req.params.id);
  res.json({ ok: true });
});

// GET /api/network-scanner/devices/:id/scans — deep scan history
router.get('/devices/:id/scans', (req, res) => {
  const scans = db.prepare('SELECT * FROM network_scan_results WHERE device_id = ? ORDER BY scanned_at DESC LIMIT 10').all(req.params.id);
  res.json({ scans: scans.map((s) => ({ ...s, ports: JSON.parse(s.ports || '[]') })) });
});

// POST /api/network-scanner/devices/:id/deep-scan
router.post('/devices/:id/deep-scan', requireRole('superadmin', 'admin', 'operator'), async (req, res) => {
  const device = db.prepare('SELECT * FROM network_devices WHERE id = ?').get(req.params.id);
  if (!device) return res.status(404).json({ error: 'Not found' });
  if (!device.ip) return res.status(400).json({ error: 'Device has no known IP address' });

  try {
    const ports = await nmap.scanHost(device.ip);
    db.prepare('INSERT INTO network_scan_results (device_id, ports) VALUES (?, ?)').run(device.id, JSON.stringify(ports));
    writeAuditLog({ user_id: req.user.id, username: req.user.username, action: 'netscan.deep_scan', module: 'network_scanner', entity_id: device.id, details: { ip: device.ip, ports_found: ports.length }, ip_address: req.ip });
    res.json({ ports });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET /api/network-scanner/devices/:id/events
router.get('/devices/:id/events', (req, res) => {
  const events = db.prepare('SELECT * FROM network_scan_events WHERE device_id = ? ORDER BY created_at DESC LIMIT 50').all(req.params.id);
  res.json({ events });
});

// POST /api/network-scanner/devices/:id/wake
router.post('/devices/:id/wake', requireRole('superadmin', 'admin', 'operator'), async (req, res) => {
  const device = db.prepare('SELECT * FROM network_devices WHERE id = ?').get(req.params.id);
  if (!device) return res.status(404).json({ error: 'Not found' });
  try {
    await sendWol(device.mac);
    writeAuditLog({ user_id: req.user.id, username: req.user.username, action: 'netscan.wake_on_lan', module: 'network_scanner', entity_id: device.id, details: { mac: device.mac }, ip_address: req.ip });
    res.json({ ok: true });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

// GET /api/network-scanner/config
router.get('/config', (req, res) => {
  const get = (k, fb) => db.prepare('SELECT value FROM settings WHERE key = ?').get(k)?.value ?? fb;
  res.json({ cron: get('netscan_cron', '*/5 * * * *'), subnet: get('netscan_subnet', '') });
});

// POST /api/network-scanner/config
router.post('/config', requireRole('superadmin', 'admin'), (req, res) => {
  const { cron, subnet } = req.body || {};
  const stmt = db.prepare(
    "INSERT INTO settings (key, value, updated_at) VALUES (?, ?, datetime('now')) ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at"
  );
  if (subnet !== undefined) stmt.run('netscan_subnet', subnet);
  if (cron) {
    const applied = scanner.reschedule(cron);
    if (!applied) return res.status(400).json({ error: 'Invalid cron expression' });
    stmt.run('netscan_cron', cron);
  }
  res.json({ ok: true });
});

module.exports = router;
