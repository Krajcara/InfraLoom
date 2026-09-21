'use strict';

const db = require('../db/database');

function getRawSettings() {
  const rows = db.prepare('SELECT key, value FROM settings').all();
  const s = {};
  rows.forEach((r) => {
    s[r.key] = r.value;
  });
  return s;
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

const SENDERS = {
  telegram: sendTelegram,
  slack: sendSlack,
  discord: sendDiscord,
  ntfy: sendNtfy,
  pushover: sendPushover,
};

/**
 * Sends `message` to every channel that has its required settings filled in.
 * Each channel is attempted independently — one failing does not stop the
 * others. Returns a per-channel result summary; never throws.
 */
async function notify(message) {
  const s = getRawSettings();
  const results = {};
  for (const [name, send] of Object.entries(SENDERS)) {
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

module.exports = { notify, sendTestNotification };
