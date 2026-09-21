'use strict';

const express = require('express');
const crypto = require('crypto');
const bcrypt = require('bcryptjs');
const db = require('../db/database');
const { writeAuditLog } = require('../middleware/audit');
const { requireAuth, TOTP_MANDATORY_ROLES } = require('../middleware/auth');
const totp = require('../lib/totp');

const router = express.Router();
router.use(requireAuth);

// GET /api/profile
router.get('/', (req, res) => {
  const user = db.prepare('SELECT * FROM users WHERE id = ?').get(req.user.id);
  res.json({
    user: {
      id: user.id,
      username: user.username,
      role: user.role,
      totpEnabled: !!user.totp_enabled,
      totpMandatory: TOTP_MANDATORY_ROLES.includes(user.role),
      createdAt: user.created_at,
    },
  });
});

// PUT /api/profile/password
router.put('/password', (req, res) => {
  const { currentPassword, newPassword } = req.body || {};
  if (!currentPassword || !newPassword) {
    return res.status(400).json({ error: 'currentPassword and newPassword are required' });
  }
  if (newPassword.length < 10) {
    return res.status(400).json({ error: 'New password must be at least 10 characters' });
  }

  const user = db.prepare('SELECT * FROM users WHERE id = ?').get(req.user.id);
  if (!bcrypt.compareSync(currentPassword, user.password_hash)) {
    return res.status(401).json({ error: 'Current password is incorrect' });
  }

  const hash = bcrypt.hashSync(newPassword, 12);
  db.prepare("UPDATE users SET password_hash = ?, updated_at = datetime('now') WHERE id = ?").run(hash, user.id);

  writeAuditLog({ user_id: user.id, username: user.username, action: 'profile.password_change', module: 'profile', ip_address: req.ip });

  res.json({ ok: true });
});

// POST /api/profile/totp/setup — generates a new secret + QR, does NOT enable yet
router.post('/totp/setup', (req, res) => {
  const user = db.prepare('SELECT * FROM users WHERE id = ?').get(req.user.id);
  const secret = totp.generateSecret(user.username);
  db.prepare('UPDATE users SET totp_secret = ? WHERE id = ?').run(secret.base32, user.id);

  totp.generateQrCodeDataUrl(secret.otpauth_url).then((qr) => {
    res.json({ qrCode: qr, secret: secret.base32 });
  });
});

// POST /api/profile/totp/verify — confirms enrollment with a code, enables TOTP
router.post('/totp/verify', (req, res) => {
  const { code } = req.body || {};
  if (!code) return res.status(400).json({ error: 'code is required' });

  const user = db.prepare('SELECT * FROM users WHERE id = ?').get(req.user.id);
  if (!user.totp_secret) return res.status(400).json({ error: 'Run TOTP setup first' });
  if (!totp.verifyCode(user.totp_secret, code)) {
    return res.status(401).json({ error: 'Invalid authentication code' });
  }

  db.prepare('UPDATE users SET totp_enabled = 1 WHERE id = ?').run(user.id);
  writeAuditLog({ user_id: user.id, username: user.username, action: 'profile.totp_enabled', module: 'profile', ip_address: req.ip });

  res.json({ ok: true });
});

// POST /api/profile/totp/disable — requires current password; blocked for mandatory roles
router.post('/totp/disable', (req, res) => {
  const { currentPassword } = req.body || {};
  const user = db.prepare('SELECT * FROM users WHERE id = ?').get(req.user.id);

  if (TOTP_MANDATORY_ROLES.includes(user.role)) {
    return res.status(403).json({ error: 'Two-factor authentication is mandatory for your role' });
  }
  if (!currentPassword || !bcrypt.compareSync(currentPassword, user.password_hash)) {
    return res.status(401).json({ error: 'Current password is incorrect' });
  }

  db.prepare('UPDATE users SET totp_enabled = 0, totp_secret = NULL WHERE id = ?').run(user.id);
  writeAuditLog({ user_id: user.id, username: user.username, action: 'profile.totp_disabled', module: 'profile', ip_address: req.ip });

  res.json({ ok: true });
});

// GET /api/profile/sessions
router.get('/sessions', (req, res) => {
  const rows = db
    .prepare(
      `SELECT id, ip_address, user_agent, created_at, last_seen_at, expires_at
       FROM sessions WHERE user_id = ? AND revoked_at IS NULL AND expires_at > datetime('now')
       ORDER BY last_seen_at DESC`
    )
    .all(req.user.id);
  res.json({
    sessions: rows.map((s) => ({ ...s, isCurrent: s.id === req.user.sessionId })),
  });
});

// DELETE /api/profile/sessions/:id
router.delete('/sessions/:id', (req, res) => {
  const session = db.prepare('SELECT * FROM sessions WHERE id = ? AND user_id = ?').get(req.params.id, req.user.id);
  if (!session) return res.status(404).json({ error: 'Session not found' });

  db.prepare("UPDATE sessions SET revoked_at = datetime('now') WHERE id = ?").run(session.id);
  writeAuditLog({ user_id: req.user.id, username: req.user.username, action: 'profile.session_revoke', module: 'profile', ip_address: req.ip });

  res.json({ ok: true });
});

// GET /api/profile/api-keys
router.get('/api-keys', (req, res) => {
  const rows = db
    .prepare(
      `SELECT id, name, key_prefix, created_at, last_used_at, revoked_at
       FROM api_keys WHERE user_id = ? ORDER BY created_at DESC`
    )
    .all(req.user.id);
  res.json({ apiKeys: rows });
});

// POST /api/profile/api-keys — { name } → returns the full key ONCE
router.post('/api-keys', (req, res) => {
  const { name } = req.body || {};
  if (!name) return res.status(400).json({ error: 'name is required' });

  const rawKey = 'il_' + crypto.randomBytes(24).toString('hex');
  const prefix = rawKey.slice(0, 11);
  const hash = bcrypt.hashSync(rawKey, 10);

  const result = db
    .prepare('INSERT INTO api_keys (user_id, name, key_prefix, key_hash) VALUES (?, ?, ?, ?)')
    .run(req.user.id, name, prefix, hash);

  writeAuditLog({ user_id: req.user.id, username: req.user.username, action: 'profile.api_key_create', module: 'profile', details: { name }, ip_address: req.ip });

  res.status(201).json({ id: result.lastInsertRowid, name, key: rawKey });
});

// DELETE /api/profile/api-keys/:id
router.delete('/api-keys/:id', (req, res) => {
  const key = db.prepare('SELECT * FROM api_keys WHERE id = ? AND user_id = ?').get(req.params.id, req.user.id);
  if (!key) return res.status(404).json({ error: 'API key not found' });

  db.prepare("UPDATE api_keys SET revoked_at = datetime('now') WHERE id = ?").run(key.id);
  writeAuditLog({ user_id: req.user.id, username: req.user.username, action: 'profile.api_key_revoke', module: 'profile', details: { name: key.name }, ip_address: req.ip });

  res.json({ ok: true });
});

module.exports = router;
