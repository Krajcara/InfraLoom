'use strict';

const jwt = require('jsonwebtoken');
const bcrypt = require('bcryptjs');
const db = require('../db/database');

const APP_SECRET = process.env.APP_SECRET;
if (!APP_SECRET) {
  console.error('[auth] FATAL: APP_SECRET is not set in .env — refusing to start.');
  process.exit(1);
}

const SESSION_TTL_HOURS = 12;
const PENDING_TTL_MINUTES = 5;

const getSessionById = db.prepare('SELECT * FROM sessions WHERE id = ?');
const touchSession = db.prepare("UPDATE sessions SET last_seen_at = datetime('now') WHERE id = ?");
const getUserById = db.prepare('SELECT * FROM users WHERE id = ?');

function signSessionToken({ userId, username, role, sessionId }) {
  return jwt.sign({ sub: userId, username, role, sid: sessionId, stage: 'full' }, APP_SECRET, {
    expiresIn: `${SESSION_TTL_HOURS}h`,
  });
}

function signPendingToken({ userId, stage }) {
  // stage: 'totp' (must enter existing TOTP code) or 'totp_setup' (must enroll TOTP)
  return jwt.sign({ sub: userId, stage }, APP_SECRET, { expiresIn: `${PENDING_TTL_MINUTES}m` });
}

function verifyToken(token) {
  return jwt.verify(token, APP_SECRET);
}

const COOKIE_NAME = 'infraloom_token';

function setSessionCookie(res, token) {
  res.cookie(COOKIE_NAME, token, {
    httpOnly: true,
    sameSite: 'lax',
    secure: process.env.COOKIE_SECURE === 'true', // enable once served over HTTPS
    maxAge: SESSION_TTL_HOURS * 60 * 60 * 1000,
    path: '/',
  });
}

function clearSessionCookie(res) {
  res.clearCookie(COOKIE_NAME, { path: '/' });
}

/**
 * Requires a valid, non-revoked, non-expired full session.
 * Attaches req.user = { id, username, role, sessionId }.
 */
function requireAuth(req, res, next) {
  const token = req.cookies?.[COOKIE_NAME];
  if (!token) return res.status(401).json({ error: 'Not authenticated' });

  let payload;
  try {
    payload = verifyToken(token);
  } catch {
    return res.status(401).json({ error: 'Session expired or invalid' });
  }

  if (payload.stage !== 'full') {
    return res.status(401).json({ error: 'Login not complete' });
  }

  const session = getSessionById.get(payload.sid);
  if (!session || session.revoked_at) {
    return res.status(401).json({ error: 'Session revoked' });
  }
  if (new Date(session.expires_at) < new Date()) {
    return res.status(401).json({ error: 'Session expired' });
  }

  const user = getUserById.get(payload.sub);
  if (!user || !user.is_active) {
    return res.status(401).json({ error: 'Account disabled' });
  }

  touchSession.run(session.id);

  req.user = { id: user.id, username: user.username, role: user.role, sessionId: session.id };
  next();
}

/** Restricts a route to one or more roles. Use after requireAuth. */
function requireRole(...roles) {
  return (req, res, next) => {
    if (!req.user) return res.status(401).json({ error: 'Not authenticated' });
    if (!roles.includes(req.user.role)) {
      return res.status(403).json({ error: 'Insufficient permissions' });
    }
    next();
  };
}

/**
 * Alternate auth method for future module integrations: Authorization: Bearer <key>.
 * Not wired into any routes yet in Phase 1 — available for later phases.
 */
function requireApiKey(req, res, next) {
  const header = req.headers.authorization || '';
  const key = header.startsWith('Bearer ') ? header.slice(7) : null;
  if (!key || !key.startsWith('il_')) return res.status(401).json({ error: 'Missing API key' });

  const prefix = key.slice(0, 11); // 'il_' + 8 chars
  const candidates = db
    .prepare('SELECT * FROM api_keys WHERE key_prefix = ? AND revoked_at IS NULL')
    .all(prefix);

  for (const candidate of candidates) {
    if (bcrypt.compareSync(key, candidate.key_hash)) {
      const user = getUserById.get(candidate.user_id);
      if (!user || !user.is_active) break;
      db.prepare("UPDATE api_keys SET last_used_at = datetime('now') WHERE id = ?").run(candidate.id);
      req.user = { id: user.id, username: user.username, role: user.role, apiKeyId: candidate.id };
      return next();
    }
  }
  return res.status(401).json({ error: 'Invalid API key' });
}

/**
 * Roles that are required to have TOTP enabled before completing login.
 * Currently empty — TOTP is optional for everyone and can be turned on
 * voluntarily from Profile. Add role names back here if mandatory 2FA
 * is reinstated later.
 */
const TOTP_MANDATORY_ROLES = [];

module.exports = {
  requireAuth,
  requireRole,
  requireApiKey,
  signSessionToken,
  signPendingToken,
  verifyToken,
  setSessionCookie,
  clearSessionCookie,
  SESSION_TTL_HOURS,
  TOTP_MANDATORY_ROLES,
};
