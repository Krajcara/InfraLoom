'use strict';

const express = require('express');
const db = require('../db/database');
const { requireAuth, requireRole } = require('../middleware/auth');
const { writeAuditLog } = require('../middleware/audit');
const { sendTestNotification } = require('../services/notificationService');

const router = express.Router();

// Keys whose values are masked on read and left untouched on save if the
// incoming value is still the mask (the client never re-sends a secret it
// only ever saw masked).
const SECRET_KEYS = [
  'smtp_pass',
  'telegram_bot_token',
  'slack_webhook_url',
  'discord_webhook_url',
  'pushover_app_token',
  'pushover_user_key',
];

const ALL_KEYS = [
  'app_name',
  'smtp_host',
  'smtp_port',
  'smtp_user',
  'smtp_pass',
  'smtp_from',
  'smtp_secure',
  'audit_retention_days',
  'telegram_bot_token',
  'telegram_chat_id',
  'slack_webhook_url',
  'discord_webhook_url',
  'ntfy_url',
  'ntfy_topic',
  'pushover_app_token',
  'pushover_user_key',
  'quiet_hours_enabled',
  'quiet_hours_start',
  'quiet_hours_end',
];

const MASK = '***';

function getSettings(maskSecrets = true) {
  const rows = db.prepare('SELECT key, value FROM settings').all();
  const s = {};
  rows.forEach((r) => {
    s[r.key] = maskSecrets && SECRET_KEYS.includes(r.key) && r.value ? MASK : r.value;
  });
  if (!s.app_name) s.app_name = 'InfraLoom';
  return s;
}

// GET /api/settings — full settings, secrets masked
router.get('/', requireAuth, (req, res) => {
  res.json(getSettings());
});

// GET /api/settings/app — public, used by the login page for branding
router.get('/app', (req, res) => {
  const get = (k) => db.prepare('SELECT value FROM settings WHERE key = ?').get(k)?.value;
  res.json({ app_name: get('app_name') || 'InfraLoom' });
});

// POST /api/settings — save (admin/superadmin)
router.post('/', requireAuth, requireRole('superadmin', 'admin'), (req, res) => {
  const stmt = db.prepare(
    "INSERT INTO settings (key, value, updated_at) VALUES (?, ?, datetime('now')) ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at"
  );
  const applied = [];
  db.transaction(() => {
    for (const [key, val] of Object.entries(req.body || {})) {
      if (!ALL_KEYS.includes(key)) continue;
      if (val === MASK) continue; // unchanged secret — leave as-is
      const storeVal = val === '' || val === null || val === undefined ? null : String(val);
      stmt.run(key, storeVal);
      applied.push(key);
    }
  })();

  writeAuditLog({
    user_id: req.user.id,
    username: req.user.username,
    action: 'settings.update',
    module: 'settings',
    details: { keys: applied },
    ip_address: req.ip,
  });

  res.json({ ok: true });
});

// POST /api/settings/test/smtp
router.post('/test/smtp', requireAuth, requireRole('superadmin', 'admin'), async (req, res) => {
  try {
    const nodemailer = require('nodemailer');
    const s = getSettings(false);
    const host = req.body?.smtp_host || s.smtp_host;
    const port = parseInt(req.body?.smtp_port || s.smtp_port || 587, 10);
    const user = req.body?.smtp_user || s.smtp_user;
    const pass = req.body?.smtp_pass && req.body.smtp_pass !== MASK ? req.body.smtp_pass : s.smtp_pass;
    const from = req.body?.smtp_from || s.smtp_from || user;

    if (!host) return res.json({ ok: false, error: 'SMTP host not configured' });

    const transporter = nodemailer.createTransport({
      host,
      port,
      secure: port === 465,
      auth: user ? { user, pass } : undefined,
      tls: { rejectUnauthorized: false },
    });
    await transporter.verify();
    res.json({ ok: true, message: `SMTP connection successful (from: ${from})` });
  } catch (err) {
    res.json({ ok: false, error: err.message });
  }
});

// POST /api/settings/test/notification — { channel: 'telegram'|'slack'|'discord'|'ntfy'|'pushover' }
router.post('/test/notification', requireAuth, requireRole('superadmin', 'admin'), async (req, res) => {
  const { channel } = req.body || {};
  if (!channel) return res.status(400).json({ error: 'channel is required' });
  try {
    await sendTestNotification(channel);
    res.json({ ok: true, message: `Test message sent via ${channel}.` });
  } catch (err) {
    res.json({ ok: false, error: err.message });
  }
});

// GET /api/settings/notification-rules — matrix metadata + saved rules + quiet hours
router.get('/notification-rules', requireAuth, (req, res) => {
  const { EVENT_TYPES, CHANNEL_NAMES, getNotificationRules } = require('../services/notificationService');
  const s = getSettings(false);
  res.json({
    eventTypes: EVENT_TYPES,
    channels: CHANNEL_NAMES,
    rules: getNotificationRules(),
    quietHours: {
      enabled: s.quiet_hours_enabled === '1',
      start: s.quiet_hours_start || '22:00',
      end: s.quiet_hours_end || '07:00',
    },
  });
});

// POST /api/settings/notification-rules — { rules: {channel: {eventType: bool}}, quietHours: {enabled,start,end} }
router.post('/notification-rules', requireAuth, requireRole('superadmin', 'admin'), (req, res) => {
  const { rules, quietHours } = req.body || {};
  const stmt = db.prepare(
    "INSERT INTO settings (key, value, updated_at) VALUES (?, ?, datetime('now')) ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at"
  );

  if (rules && typeof rules === 'object') {
    stmt.run('notification_rules', JSON.stringify(rules));
  }
  if (quietHours) {
    stmt.run('quiet_hours_enabled', quietHours.enabled ? '1' : '0');
    if (quietHours.start) stmt.run('quiet_hours_start', quietHours.start);
    if (quietHours.end) stmt.run('quiet_hours_end', quietHours.end);
  }

  writeAuditLog({
    user_id: req.user.id, username: req.user.username, action: 'settings.notification_rules_update',
    module: 'settings', ip_address: req.ip,
  });

  res.json({ ok: true });
});

module.exports = router;
