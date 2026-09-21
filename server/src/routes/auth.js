'use strict';

const express = require('express');
const { v4: uuidv4 } = require('uuid');
const bcrypt = require('bcryptjs');
const rateLimit = require('express-rate-limit');
const db = require('../db/database');
const { writeAuditLog } = require('../middleware/audit');
const totp = require('../lib/totp');
const {
  requireAuth,
  signSessionToken,
  signPendingToken,
  verifyToken,
  setSessionCookie,
  clearSessionCookie,
  SESSION_TTL_HOURS,
  TOTP_MANDATORY_ROLES,
} = require('../middleware/auth');

const router = express.Router();

const LOCKOUT_THRESHOLD = 5;
const LOCKOUT_MINUTES = 15;

const loginLimiter = rateLimit({
  windowMs: 5 * 60 * 1000,
  max: 20,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too many attempts — please wait a few minutes.' },
});

const getUserByUsername = db.prepare('SELECT * FROM users WHERE username = ?');
const getUserById = db.prepare('SELECT * FROM users WHERE id = ?');

function createSession(userId, req) {
  const id = uuidv4();
  const expiresAt = new Date(Date.now() + SESSION_TTL_HOURS * 60 * 60 * 1000).toISOString();
  db.prepare(
    `INSERT INTO sessions (id, user_id, ip_address, user_agent, expires_at)
     VALUES (?, ?, ?, ?, ?)`
  ).run(id, userId, req.ip, req.headers['user-agent'] || null, expiresAt);
  return id;
}

function issueFullSession(user, req, res) {
  const sessionId = createSession(user.id, req);
  const token = signSessionToken({
    userId: user.id,
    username: user.username,
    role: user.role,
    sessionId,
  });
  setSessionCookie(res, token);
  writeAuditLog({
    user_id: user.id,
    username: user.username,
    action: 'auth.login_success',
    module: 'auth',
    ip_address: req.ip,
  });
  return { id: user.id, username: user.username, role: user.role, totpEnabled: !!user.totp_enabled };
}

// POST /api/auth/login — step 1: username + password
router.post('/login', loginLimiter, (req, res) => {
  const { username, password } = req.body || {};
  if (!username || !password) return res.status(400).json({ error: 'Username and password are required' });

  const user = getUserByUsername.get(username);
  if (!user) return res.status(401).json({ error: 'Invalid username or password' });

  if (!user.is_active) return res.status(403).json({ error: 'Account is disabled' });

  if (user.locked_until && new Date(user.locked_until) > new Date()) {
    return res.status(423).json({ error: 'Account temporarily locked — try again later' });
  }

  const valid = bcrypt.compareSync(password, user.password_hash);
  if (!valid) {
    const attempts = user.failed_attempts + 1;
    const lockedUntil =
      attempts >= LOCKOUT_THRESHOLD
        ? new Date(Date.now() + LOCKOUT_MINUTES * 60 * 1000).toISOString()
        : null;
    db.prepare('UPDATE users SET failed_attempts = ?, locked_until = ? WHERE id = ?').run(
      attempts,
      lockedUntil,
      user.id
    );
    writeAuditLog({
      username,
      action: 'auth.login_failed',
      module: 'auth',
      ip_address: req.ip,
      details: lockedUntil ? 'Account locked after repeated failures' : null,
    });
    if (lockedUntil) return res.status(423).json({ error: 'Too many failed attempts — account locked for 15 minutes' });
    return res.status(401).json({ error: 'Invalid username or password' });
  }

  db.prepare('UPDATE users SET failed_attempts = 0, locked_until = NULL WHERE id = ?').run(user.id);

  if (user.totp_enabled) {
    const pendingToken = signPendingToken({ userId: user.id, stage: 'totp' });
    return res.json({ requiresTotp: true, pendingToken });
  }

  if (TOTP_MANDATORY_ROLES.includes(user.role)) {
    const pendingToken = signPendingToken({ userId: user.id, stage: 'totp_setup' });
    const secret = totp.generateSecret(user.username);
    db.prepare('UPDATE users SET totp_secret = ? WHERE id = ?').run(secret.base32, user.id);
    return totp.generateQrCodeDataUrl(secret.otpauth_url).then((qr) => {
      res.json({ requiresTotpSetup: true, pendingToken, qrCode: qr, secret: secret.base32 });
    });
  }

  const userInfo = issueFullSession(user, req, res);
  res.json({ user: userInfo });
});

// POST /api/auth/login/totp — step 2a: verify existing TOTP code
router.post('/login/totp', loginLimiter, (req, res) => {
  const { pendingToken, code } = req.body || {};
  if (!pendingToken || !code) return res.status(400).json({ error: 'pendingToken and code are required' });

  let payload;
  try {
    payload = verifyToken(pendingToken);
  } catch {
    return res.status(401).json({ error: 'Pending login expired — please log in again' });
  }
  if (payload.stage !== 'totp') return res.status(400).json({ error: 'Invalid login stage' });

  const user = getUserById.get(payload.sub);
  if (!user) return res.status(401).json({ error: 'Account not found' });

  if (!totp.verifyCode(user.totp_secret, code)) {
    writeAuditLog({ user_id: user.id, username: user.username, action: 'auth.totp_failed', module: 'auth', ip_address: req.ip });
    return res.status(401).json({ error: 'Invalid authentication code' });
  }

  const userInfo = issueFullSession(user, req, res);
  res.json({ user: userInfo });
});

// POST /api/auth/login/totp-setup — step 2b: confirm TOTP enrollment forced by role
router.post('/login/totp-setup', loginLimiter, (req, res) => {
  const { pendingToken, code } = req.body || {};
  if (!pendingToken || !code) return res.status(400).json({ error: 'pendingToken and code are required' });

  let payload;
  try {
    payload = verifyToken(pendingToken);
  } catch {
    return res.status(401).json({ error: 'Pending login expired — please log in again' });
  }
  if (payload.stage !== 'totp_setup') return res.status(400).json({ error: 'Invalid login stage' });

  const user = getUserById.get(payload.sub);
  if (!user) return res.status(401).json({ error: 'Account not found' });

  if (!totp.verifyCode(user.totp_secret, code)) {
    return res.status(401).json({ error: 'Invalid authentication code' });
  }

  db.prepare('UPDATE users SET totp_enabled = 1 WHERE id = ?').run(user.id);
  user.totp_enabled = 1;
  writeAuditLog({ user_id: user.id, username: user.username, action: 'auth.totp_enabled', module: 'auth', ip_address: req.ip });

  const userInfo = issueFullSession(user, req, res);
  res.json({ user: userInfo });
});

// POST /api/auth/logout
router.post('/logout', requireAuth, (req, res) => {
  db.prepare("UPDATE sessions SET revoked_at = datetime('now') WHERE id = ?").run(req.user.sessionId);
  clearSessionCookie(res);
  writeAuditLog({ user_id: req.user.id, username: req.user.username, action: 'auth.logout', module: 'auth', ip_address: req.ip });
  res.json({ ok: true });
});

// GET /api/auth/me
router.get('/me', requireAuth, (req, res) => {
  const user = getUserById.get(req.user.id);
  res.json({
    user: { id: user.id, username: user.username, role: user.role, totpEnabled: !!user.totp_enabled },
  });
});

module.exports = router;
