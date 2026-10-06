'use strict';

const express = require('express');
const db = require('../db/database');
const { requireAuth, requireRole } = require('../middleware/auth');
const { writeAuditLog } = require('../middleware/audit');
const { AUTH_PROTOCOLS, PRIV_PROTOCOLS } = require('../lib/snmpGeneric');
const { readUps, walkRaw, RFC1628 } = require('../lib/upsSnmp');
const { pollUps } = require('../services/upsService');

const router = express.Router();
router.use(requireAuth);

const MASK = '***';
const VERSIONS = ['1', '2c', '3'];
const LEVELS = ['noAuthNoPriv', 'authNoPriv', 'authPriv'];
const SECRETS = ['snmp_community', 'snmp_auth_password', 'snmp_priv_password'];

function view(u) {
  if (!u) return u;
  const out = { ...u, last_reading: u.last_reading ? JSON.parse(u.last_reading) : null };
  for (const k of SECRETS) out[k] = u[k] ? MASK : null;
  return out;
}

/** Validates + normalises a create/update/test body against the existing row
 * (null for create). A blank or "***" secret means "keep what's stored". */
function buildConfig(body, existing) {
  const b = body || {};
  const pick = (k, dflt) => (b[k] !== undefined && b[k] !== '' ? b[k] : existing ? existing[k] : dflt);
  const secret = (k) => (b[k] && b[k] !== MASK ? b[k] : existing ? existing[k] : null);
  const errors = [];

  const name = String(b.name !== undefined ? b.name : existing?.name || '').trim();
  const ip = String(b.ip_address !== undefined ? b.ip_address : existing?.ip_address || '').trim();
  if (!name) errors.push('name is required');
  if (!ip || !/^[A-Za-z0-9._-]{1,253}$/.test(ip)) errors.push('ip_address must be an IP address or hostname');

  const version = String(pick('snmp_version', '2c'));
  if (!VERSIONS.includes(version)) errors.push('snmp_version must be 1, 2c or 3');
  const port = parseInt(pick('snmp_port', 161), 10);
  if (!(port >= 1 && port <= 65535)) errors.push('snmp_port must be 1-65535');

  const cfg = {
    name, ip_address: ip,
    location: b.location !== undefined ? b.location || null : existing?.location ?? null,
    notes: b.notes !== undefined ? b.notes || null : existing?.notes ?? null,
    enabled: b.enabled !== undefined ? (b.enabled ? 1 : 0) : existing?.enabled ?? 1,
    snmp_version: version, snmp_port: port,
    snmp_community: secret('snmp_community') || (version !== '3' ? 'public' : null),
    snmp_username: b.snmp_username !== undefined ? String(b.snmp_username).trim() || null : existing?.snmp_username ?? null,
    snmp_security_level: pick('snmp_security_level', 'authPriv'),
    snmp_auth_protocol: pick('snmp_auth_protocol', 'SHA'),
    snmp_auth_password: secret('snmp_auth_password'),
    snmp_priv_protocol: pick('snmp_priv_protocol', 'AES'),
    snmp_priv_password: secret('snmp_priv_password'),
  };

  if (version === '3') {
    if (!cfg.snmp_username) errors.push('SNMPv3 needs a username');
    if (!LEVELS.includes(cfg.snmp_security_level)) errors.push('security level must be noAuthNoPriv, authNoPriv or authPriv');
    if (cfg.snmp_security_level !== 'noAuthNoPriv') {
      if (!AUTH_PROTOCOLS[cfg.snmp_auth_protocol]) errors.push(`auth protocol must be one of ${Object.keys(AUTH_PROTOCOLS).join(', ')}`);
      if (!cfg.snmp_auth_password || cfg.snmp_auth_password.length < 8) errors.push('SNMPv3 auth password must be at least 8 characters');
    }
    if (cfg.snmp_security_level === 'authPriv') {
      if (!PRIV_PROTOCOLS[cfg.snmp_priv_protocol]) errors.push(`privacy protocol must be one of ${Object.keys(PRIV_PROTOCOLS).join(', ')}`);
      if (!cfg.snmp_priv_password || cfg.snmp_priv_password.length < 8) errors.push('SNMPv3 privacy password must be at least 8 characters');
    }
  } else if (!cfg.snmp_community) {
    errors.push('community string is required for SNMP v1/v2c');
  }
  return { cfg, errors };
}

const COLS = [
  'name', 'ip_address', 'location', 'notes', 'enabled', 'snmp_version', 'snmp_port', 'snmp_community', 'snmp_username',
  'snmp_security_level', 'snmp_auth_protocol', 'snmp_auth_password', 'snmp_priv_protocol', 'snmp_priv_password',
];

// GET /api/ups
router.get('/', (req, res) => {
  const inMaintenance = require('../services/maintenanceService').lookup();
  res.json({ devices: db.prepare('SELECT * FROM ups_devices ORDER BY name').all().map((u) => ({ ...view(u), in_maintenance: inMaintenance('ups', u.id) })) });
});

// POST /api/ups
router.post('/', requireRole('superadmin', 'admin', 'operator'), async (req, res) => {
  const { cfg, errors } = buildConfig(req.body, null);
  if (errors.length) return res.status(400).json({ error: errors.join('; ') });
  const r = db
    .prepare(`INSERT INTO ups_devices (${COLS.join(',')}) VALUES (${COLS.map(() => '?').join(',')})`)
    .run(...COLS.map((c) => cfg[c]));
  writeAuditLog({ user_id: req.user.id, username: req.user.username, action: 'ups.create', entity_type: 'ups', entity_id: r.lastInsertRowid, module: 'ups', details: { name: cfg.name, ip: cfg.ip_address, snmp: cfg.snmp_version }, ip_address: req.ip });
  const device = await pollUps(r.lastInsertRowid); // first reading right away
  res.status(201).json({ device: view(device) });
});

// PUT /api/ups/:id
router.put('/:id', requireRole('superadmin', 'admin', 'operator'), async (req, res) => {
  const existing = db.prepare('SELECT * FROM ups_devices WHERE id = ?').get(req.params.id);
  if (!existing) return res.status(404).json({ error: 'Not found' });
  const { cfg, errors } = buildConfig(req.body, existing);
  if (errors.length) return res.status(400).json({ error: errors.join('; ') });
  db.prepare(`UPDATE ups_devices SET ${COLS.map((c) => `${c}=?`).join(', ')}, consecutive_failures=0, updated_at=datetime('now') WHERE id=?`).run(...COLS.map((c) => cfg[c]), existing.id);
  writeAuditLog({ user_id: req.user.id, username: req.user.username, action: 'ups.update', entity_type: 'ups', entity_id: existing.id, module: 'ups', details: { name: cfg.name }, ip_address: req.ip });
  const device = cfg.enabled ? await pollUps(existing.id) : db.prepare('SELECT * FROM ups_devices WHERE id = ?').get(existing.id);
  res.json({ device: view(device) });
});

// DELETE /api/ups/:id
router.delete('/:id', requireRole('superadmin', 'admin'), (req, res) => {
  const u = db.prepare('SELECT name FROM ups_devices WHERE id = ?').get(req.params.id);
  if (!u) return res.status(404).json({ error: 'Not found' });
  db.prepare('DELETE FROM ups_devices WHERE id = ?').run(req.params.id);
  writeAuditLog({ user_id: req.user.id, username: req.user.username, action: 'ups.delete', entity_type: 'ups', entity_id: req.params.id, module: 'ups', details: { name: u.name }, ip_address: req.ip });
  res.json({ ok: true });
});

// POST /api/ups/test — try SNMP settings without saving ({ id } lets masked secrets fall back to the stored ones)
router.post('/test', requireRole('superadmin', 'admin', 'operator'), async (req, res) => {
  const existing = req.body?.id ? db.prepare('SELECT * FROM ups_devices WHERE id = ?').get(req.body.id) : null;
  const { cfg, errors } = buildConfig(req.body, existing);
  if (errors.length) return res.status(400).json({ error: errors.join('; ') });
  try {
    const reading = await readUps(cfg.ip_address, cfg);
    res.json({ ok: true, reading });
  } catch (err) {
    res.json({ ok: false, error: err.message });
  }
});

// POST /api/ups/:id/poll — poll now
router.post('/:id/poll', requireRole('superadmin', 'admin', 'operator'), async (req, res) => {
  const device = await pollUps(req.params.id);
  if (!device) return res.status(404).json({ error: 'Not found' });
  res.json({ device: view(device) });
});

// GET /api/ups/:id/history?hours=24
router.get('/:id/history', (req, res) => {
  const hours = Math.min(Math.max(parseInt(req.query.hours, 10) || 24, 1), 24 * 14);
  const rows = db
    .prepare(`SELECT at, status, charge_pct, runtime_min, load_pct, input_v, output_v, battery_temp_c FROM ups_readings WHERE ups_id = ? AND at >= datetime('now', ?) ORDER BY at`)
    .all(req.params.id, `-${hours} hours`);
  // Downsample long ranges to ~300 points so the chart stays light.
  const step = Math.max(1, Math.ceil(rows.length / 300));
  const points = rows.filter((_, i) => i % step === 0 || i === rows.length - 1).map((r) => ({ ...r, at: `${r.at.replace(' ', 'T')}Z` }));
  res.json({ points, hours });
});

// POST /api/ups/:id/walk { oid } — raw SNMP subtree, for UPS cards whose layout isn't recognised
router.post('/:id/walk', requireRole('superadmin', 'admin'), async (req, res) => {
  const u = db.prepare('SELECT * FROM ups_devices WHERE id = ?').get(req.params.id);
  if (!u) return res.status(404).json({ error: 'Not found' });
  const oid = String(req.body?.oid || RFC1628).trim().replace(/^\./, '');
  if (!/^\d+(\.\d+){2,}$/.test(oid)) return res.status(400).json({ error: 'oid must look like 1.3.6.1.2.1.33' });
  try {
    res.json({ oid, ...(await walkRaw(u.ip_address, u, oid)) });
  } catch (err) {
    res.status(502).json({ error: err.message });
  }
});

module.exports = router;
