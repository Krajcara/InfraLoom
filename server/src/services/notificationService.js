'use strict';

const db = require('../db/database');

// Event types the app can notify about. Keep this list in sync with every
// place that calls notify(message, eventType) — the Settings UI reads it
// via GET /api/settings/notification-rules to build the toggle matrix.
const EVENT_TYPES = [
  { id: 'monitor_down', label: 'Monitor down' },
  { id: 'monitor_up', label: 'Monitor recovered' },
  { id: 'ssl_expiring', label: 'SSL certificate expiring/expired' },
  { id: 'licence_expiring', label: 'Licence expiring/expired' },
  { id: 'entra_expiring', label: 'Entra ID secret expiring/expired' },
  { id: 'network_new_device', label: 'New device on the network' },
  { id: 'network_device_offline', label: 'Known device went offline' },
  { id: 'hypervisor_down', label: 'Hypervisor connection unreachable' },
  { id: 'hypervisor_up', label: 'Hypervisor connection recovered' },
];

const CHANNEL_NAMES = ['telegram', 'slack', 'discord', 'ntfy', 'pushover', 'email'];

function getRawSettings() {
  const rows = db.prepare('SELECT key, value FROM settings').all();
  const s = {};
  rows.forEach((r) => {
    s[r.key] = r.value;
  });
  return s;
}

/** Per-channel-per-event toggle matrix. Defaults to "everything enabled"
 * for any channel/event combination not explicitly set — so existing
 * installs keep working exactly as before until someone opts out. */
function getNotificationRules() {
  const raw = db.prepare("SELECT value FROM settings WHERE key = 'notification_rules'").get()?.value;
  if (!raw) return {};
  try {
    return JSON.parse(raw);
  } catch {
    return {};
  }
}

function isChannelEventEnabled(rules, channel, eventType) {
  const channelRules = rules[channel];
  if (!channelRules || channelRules[eventType] === undefined) return true; // default: on
  return !!channelRules[eventType];
}

/** True if "now" falls inside the configured quiet-hours window (local
 * server time, HH:MM). Handles windows that cross midnight. */
function isQuietHours() {
  const s = getRawSettings();
  if (s.quiet_hours_enabled !== '1') return false;
  const start = s.quiet_hours_start || '22:00';
  const end = s.quiet_hours_end || '07:00';

  const now = new Date();
  const nowMinutes = now.getHours() * 60 + now.getMinutes();
  const [sh, sm] = start.split(':').map(Number);
  const [eh, em] = end.split(':').map(Number);
  const startMinutes = sh * 60 + sm;
  const endMinutes = eh * 60 + em;

  if (startMinutes === endMinutes) return false; // zero-length window = disabled
  if (startMinutes < endMinutes) {
    return nowMinutes >= startMinutes && nowMinutes < endMinutes;
  }
  // window crosses midnight, e.g. 22:00 -> 07:00
  return nowMinutes >= startMinutes || nowMinutes < endMinutes;
}

async function sendTelegram(s, message) {
  if (!s.telegram_bot_token || !s.telegram_chat_id) throw new Error('Telegram is not configured');
  const url = `https://api.telegram.org/bot${s.telegram_bot_token}/sendMessage`;
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ chat_id: s.telegram_chat_id, text: message }),
  });
  if (!res.ok) throw new Error(`Telegram API returned ${res.status}`);
}

async function sendSlack(s, message) {
  if (!s.slack_webhook_url) throw new Error('Slack is not configured');
  const res = await fetch(s.slack_webhook_url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ text: message }),
  });
  if (!res.ok) throw new Error(`Slack webhook returned ${res.status}`);
}

async function sendDiscord(s, message) {
  if (!s.discord_webhook_url) throw new Error('Discord is not configured');
  const res = await fetch(s.discord_webhook_url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ content: message }),
  });
  if (!res.ok) throw new Error(`Discord webhook returned ${res.status}`);
}

async function sendNtfy(s, message) {
  if (!s.ntfy_url || !s.ntfy_topic) throw new Error('ntfy is not configured');
  const base = s.ntfy_url.replace(/\/+$/, '');
  const res = await fetch(`${base}/${s.ntfy_topic}`, {
    method: 'POST',
    body: message,
  });
  if (!res.ok) throw new Error(`ntfy returned ${res.status}`);
}

async function sendPushover(s, message) {
  if (!s.pushover_app_token || !s.pushover_user_key) throw new Error('Pushover is not configured');
  const res = await fetch('https://api.pushover.net/1/messages.json', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      token: s.pushover_app_token,
      user: s.pushover_user_key,
      message,
    }),
  });
  if (!res.ok) throw new Error(`Pushover API returned ${res.status}`);
}

async function getGraphAccessToken(s) {
  const url = `https://login.microsoftonline.com/${s.graph_tenant_id}/oauth2/v2.0/token`;
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'client_credentials',
      client_id: s.graph_client_id,
      client_secret: s.graph_client_secret,
      scope: 'https://graph.microsoft.com/.default',
    }),
  });
  const raw = await res.text();
  let data;
  try {
    data = JSON.parse(raw);
  } catch {
    throw new Error(`Microsoft identity platform returned a non-JSON response (HTTP ${res.status}): ${raw.slice(0, 200)}`);
  }
  if (!res.ok) throw new Error(data.error_description || `Microsoft identity platform returned ${res.status}`);
  return data.access_token;
}

async function sendGraphEmail(s, message) {
  if (!s.graph_tenant_id || !s.graph_client_id || !s.graph_client_secret || !s.graph_from_email) {
    throw new Error('Microsoft Graph email is not configured');
  }
  if (!s.notification_email_to) throw new Error('No recipient email configured (notification_email_to)');

  const token = await getGraphAccessToken(s);
  const recipients = s.notification_email_to
    .split(',')
    .map((e) => e.trim())
    .filter(Boolean)
    .map((address) => ({ emailAddress: { address } }));

  const res = await fetch(`https://graph.microsoft.com/v1.0/users/${encodeURIComponent(s.graph_from_email)}/sendMail`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      message: {
        subject: 'InfraLoom notification',
        body: { contentType: 'Text', content: message },
        toRecipients: recipients,
      },
      saveToSentItems: false,
    }),
  });
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    throw new Error(body.error?.message || `Microsoft Graph sendMail returned ${res.status}`);
  }
}

const SENDERS = {
  telegram: sendTelegram,
  slack: sendSlack,
  discord: sendDiscord,
  ntfy: sendNtfy,
  pushover: sendPushover,
  email: sendGraphEmail,
};

/**
 * Sends `message` to every channel that (a) has its required settings
 * filled in, (b) is enabled for `eventType` in the notification rules
 * matrix, and (c) isn't currently inside the quiet-hours window.
 * `eventType` is optional — omitting it (or passing an unknown id) sends
 * to every configured channel unconditionally, for one-off/test messages.
 * Each channel is attempted independently; one failing doesn't stop the
 * others. Never throws.
 */
const SEVERITY_MAP = {
  monitor_down: 'critical',
  monitor_up: 'info',
  hypervisor_down: 'critical',
  hypervisor_up: 'info',
  network_device_offline: 'warning',
  network_new_device: 'info',
  ssl_expiring: 'warning',
  licence_expiring: 'warning',
  entra_expiring: 'warning',
};

function recordInAppNotification(message, eventType) {
  const db = require('../db/database');
  const severity = SEVERITY_MAP[eventType] || 'info';
  const row = db
    .prepare('INSERT INTO app_notifications (event_type, severity, message) VALUES (?, ?, ?)')
    .run(eventType || null, severity, message);
  const notification = db.prepare('SELECT * FROM app_notifications WHERE id = ?').get(row.lastInsertRowid);
  if (global.io) global.io.emit('notification:new', notification);
  return notification;
}

async function notify(message, eventType = null) {
  // In-app notifications are a passive record (you check the bell when
  // you're ready), unlike a phone push — so they're recorded even during
  // quiet hours. Only the noisy external channels below are suppressed.
  recordInAppNotification(message, eventType);

  if (eventType && isQuietHours()) {
    return { skipped: 'quiet_hours' };
  }

  const s = getRawSettings();
  const rules = getNotificationRules();
  const results = {};
  for (const [name, send] of Object.entries(SENDERS)) {
    if (eventType && !isChannelEventEnabled(rules, name, eventType)) continue;
    try {
      await send(s, message);
      results[name] = { ok: true };
    } catch (err) {
      if (err.message.includes('is not configured')) continue; // silently skip unconfigured channels
      console.error(`[notify] ${name} failed:`, err.message);
      results[name] = { ok: false, error: err.message };
    }
  }
  return results;
}

/** Sends a test message via one specific channel — throws on failure. */
async function sendTestNotification(channel) {
  const send = SENDERS[channel];
  if (!send) throw new Error(`Unknown channel: ${channel}`);
  const s = getRawSettings();
  await send(s, `InfraLoom test notification (${new Date().toISOString()})`);
}

module.exports = {
  notify,
  sendTestNotification,
  EVENT_TYPES,
  CHANNEL_NAMES,
  getNotificationRules,
};
