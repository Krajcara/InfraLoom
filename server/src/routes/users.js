'use strict';

const express = require('express');
const crypto = require('crypto');
const bcrypt = require('bcryptjs');
const db = require('../db/database');
const { writeAuditLog } = require('../middleware/audit');
const { requireAuth, requireRole } = require('../middleware/auth');

const router = express.Router();

const ROLES = ['superadmin', 'admin', 'operator', 'viewer'];

// What each acting role is allowed to assign/manage.
// superadmin: everyone. admin: operator & viewer only (not admin/superadmin, not self-elevation).
function canManage(actorRole, targetRole) {
  if (actorRole === 'superadmin') return true;
  if (actorRole === 'admin') return targetRole === 'operator' || targetRole === 'viewer';
  return false;
}

function generatePassword(length = 16) {
  const chars = 'ABCDEFGHJKMNPQRSTUVWXYZabcdefghijkmnpqrstuvwxyz23456789!@#$%';
  return Array.from(crypto.randomFillSync(new Uint8Array(length)))
    .map((b) => chars[b % chars.length])
    .join('');
}

router.use(requireAuth, requireRole('superadmin', 'admin'));

// GET /api/users
router.get('/', (req, res) => {
  const rows = db
    .prepare(
      `SELECT id, username, role, totp_enabled, is_active, failed_attempts, locked_until, created_at
       FROM users ORDER BY created_at ASC`
    )
    .all();
  res.json({ users: rows });
});

// POST /api/users
router.post('/', (req, res) => {
  const { username, role } = req.body || {};
  if (!username || !role) return res.status(400).json({ error: 'username and role are required' });
  if (!ROLES.includes(role)) return res.status(400).json({ error: 'Invalid role' });
  if (!canManage(req.user.role, role)) return res.status(403).json({ error: 'You cannot assign this role' });

  const existing = db.prepare('SELECT id FROM users WHERE username = ?').get(username);
  if (existing) return res.status(409).json({ error: 'Username already exists' });

  const tempPassword = generatePassword();
  const hash = bcrypt.hashSync(tempPassword, 12);
  const result = db
    .prepare('INSERT INTO users (username, password_hash, role, is_active) VALUES (?, ?, ?, 1)')
    .run(username, hash, role);

  writeAuditLog({
    user_id: req.user.id,
    username: req.user.username,
    action: 'user.create',
    entity_type: 'user',
    entity_id: result.lastInsertRowid,
    module: 'users',
    details: { createdUsername: username, role },
    ip_address: req.ip,
  });

  res.status(201).json({
    user: { id: result.lastInsertRowid, username, role },
    temporaryPassword: tempPassword,
  });
});

// PUT /api/users/:id
router.put('/:id', (req, res) => {
  const target = db.prepare('SELECT * FROM users WHERE id = ?').get(req.params.id);
  if (!target) return res.status(404).json({ error: 'User not found' });
  if (!canManage(req.user.role, target.role)) return res.status(403).json({ error: 'Insufficient permissions' });

  const { role, is_active } = req.body || {};
  const updates = [];
  const values = [];

  if (role !== undefined) {
    if (!ROLES.includes(role)) return res.status(400).json({ error: 'Invalid role' });
    if (!canManage(req.user.role, role)) return res.status(403).json({ error: 'You cannot assign this role' });
    if (target.role === 'superadmin' && role !== 'superadmin') {
      const superadminCount = db.prepare("SELECT COUNT(*) AS n FROM users WHERE role = 'superadmin'").get().n;
      if (superadminCount <= 1) return res.status(400).json({ error: 'Cannot remove the last superadmin' });
    }
    updates.push('role = ?');
    values.push(role);
  }

  if (is_active !== undefined) {
    if (target.role === 'superadmin' && !is_active) {
      const activeSuperadmins = db
        .prepare("SELECT COUNT(*) AS n FROM users WHERE role = 'superadmin' AND is_active = 1")
        .get().n;
      if (activeSuperadmins <= 1) return res.status(400).json({ error: 'Cannot disable the last active superadmin' });
    }
    updates.push('is_active = ?');
    values.push(is_active ? 1 : 0);
  }

  if (updates.length === 0) return res.status(400).json({ error: 'Nothing to update' });

  updates.push("updated_at = datetime('now')");
  db.prepare(`UPDATE users SET ${updates.join(', ')} WHERE id = ?`).run(...values, target.id);

  writeAuditLog({
    user_id: req.user.id,
    username: req.user.username,
    action: 'user.update',
    entity_type: 'user',
    entity_id: target.id,
    module: 'users',
    details: { targetUsername: target.username, role, is_active },
    ip_address: req.ip,
  });

  res.json({ ok: true });
});

// DELETE /api/users/:id
router.delete('/:id', (req, res) => {
  const target = db.prepare('SELECT * FROM users WHERE id = ?').get(req.params.id);
  if (!target) return res.status(404).json({ error: 'User not found' });
  if (!canManage(req.user.role, target.role)) return res.status(403).json({ error: 'Insufficient permissions' });
  if (target.id === req.user.id) return res.status(400).json({ error: 'You cannot delete your own account' });

  if (target.role === 'superadmin') {
    const superadminCount = db.prepare("SELECT COUNT(*) AS n FROM users WHERE role = 'superadmin'").get().n;
    if (superadminCount <= 1) return res.status(400).json({ error: 'Cannot delete the last superadmin' });
  }

  db.prepare('DELETE FROM users WHERE id = ?').run(target.id);

  writeAuditLog({
    user_id: req.user.id,
    username: req.user.username,
    action: 'user.delete',
    entity_type: 'user',
    entity_id: target.id,
    module: 'users',
    details: { deletedUsername: target.username },
    ip_address: req.ip,
  });

  res.json({ ok: true });
});

// POST /api/users/:id/reset-password
router.post('/:id/reset-password', (req, res) => {
  const target = db.prepare('SELECT * FROM users WHERE id = ?').get(req.params.id);
  if (!target) return res.status(404).json({ error: 'User not found' });
  if (!canManage(req.user.role, target.role)) return res.status(403).json({ error: 'Insufficient permissions' });

  const tempPassword = generatePassword();
  const hash = bcrypt.hashSync(tempPassword, 12);
  db.prepare("UPDATE users SET password_hash = ?, updated_at = datetime('now') WHERE id = ?").run(hash, target.id);

  writeAuditLog({
    user_id: req.user.id,
    username: req.user.username,
    action: 'user.reset_password',
    entity_type: 'user',
    entity_id: target.id,
    module: 'users',
    details: { targetUsername: target.username },
    ip_address: req.ip,
  });

  res.json({ temporaryPassword: tempPassword });
});

// POST /api/users/:id/unlock
router.post('/:id/unlock', (req, res) => {
  const target = db.prepare('SELECT * FROM users WHERE id = ?').get(req.params.id);
  if (!target) return res.status(404).json({ error: 'User not found' });
  if (!canManage(req.user.role, target.role)) return res.status(403).json({ error: 'Insufficient permissions' });

  db.prepare('UPDATE users SET failed_attempts = 0, locked_until = NULL WHERE id = ?').run(target.id);

  writeAuditLog({
    user_id: req.user.id,
    username: req.user.username,
    action: 'user.unlock',
    entity_type: 'user',
    entity_id: target.id,
    module: 'users',
    ip_address: req.ip,
  });

  res.json({ ok: true });
});

module.exports = router;
