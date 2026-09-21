'use strict';

const tls = require('tls');
const { URL } = require('url');
const db = require('../db/database');

function checkSSL(targetUrl, timeoutMs = 10000) {
  return new Promise((resolve) => {
    let hostname, port;
    try {
      const u = new URL(targetUrl.startsWith('http') ? targetUrl : `https://${targetUrl}`);
      if (u.protocol !== 'https:') return resolve({ skip: true });
      hostname = u.hostname;
      port = parseInt(u.port, 10) || 443;
    } catch {
      return resolve({ error: 'Invalid URL' });
    }

    const timer = setTimeout(() => {
      socket.destroy();
      resolve({ error: 'Timeout' });
    }, timeoutMs);

    const socket = tls.connect({ host: hostname, port, servername: hostname, rejectUnauthorized: false }, () => {
      clearTimeout(timer);
      try {
        const cert = socket.getPeerCertificate();
        socket.destroy();
        if (!cert?.valid_to) return resolve({ error: 'No certificate' });
        const expiry = new Date(cert.valid_to);
        const days = Math.ceil((expiry - new Date()) / 86400000);
        resolve({ expiry: expiry.toISOString(), days, hostname });
      } catch (e) {
        resolve({ error: e.message });
      }
    });

    socket.on('error', (e) => {
      clearTimeout(timer);
      resolve({ error: e.message });
    });
  });
}

/** Checks SSL for all enabled http/https/keyword/json_query monitors and
 * updates ssl_expiry / ssl_days / ssl_error on each.
 *
 * @param {boolean} sendNotification - When true (the daily 02:00 cron),
 *   also sends a digest notification for certs expiring soon/expired.
 *   Ad-hoc callers (server startup, a newly created monitor) pass false —
 *   they only need the data refreshed immediately, not a fresh alert every
 *   time the server happens to restart.
 */
async function checkAllSSL(sendNotification = true) {
  const monitors = db
    .prepare("SELECT id, label, target, type FROM monitors WHERE enabled = 1 AND type IN ('http','https','keyword','json_query')")
    .all();

  for (const m of monitors) {
    try {
      const url = m.target.startsWith('http') ? m.target : `https://${m.target}`;
      if (!url.startsWith('https')) {
        db.prepare("UPDATE monitors SET ssl_days=NULL, ssl_expiry=NULL, ssl_error='Not HTTPS' WHERE id=?").run(m.id);
        continue;
      }
      const r = await checkSSL(url, 8000);
      if (r.skip) {
        db.prepare('UPDATE monitors SET ssl_days=NULL, ssl_expiry=NULL, ssl_error=NULL WHERE id=?').run(m.id);
      } else if (r.error) {
        db.prepare('UPDATE monitors SET ssl_days=NULL, ssl_expiry=NULL, ssl_error=? WHERE id=?').run(r.error, m.id);
      } else {
        db.prepare('UPDATE monitors SET ssl_days=?, ssl_expiry=?, ssl_error=NULL WHERE id=?').run(r.days, r.expiry, m.id);
      }
    } catch (e) {
      console.error(`[SSL] Monitor ${m.id} error:`, e.message);
    }
  }
  console.log(`[SSL] Checked ${monitors.length} monitor(s)`);

  if (!sendNotification) return;

  try {
    const expiring = db
      .prepare("SELECT label, ssl_days FROM monitors WHERE ssl_days IS NOT NULL AND ssl_days <= 30 ORDER BY ssl_days ASC")
      .all();
    if (expiring.length > 0) {
      const { notify } = require('./notificationService');
      const lines = expiring.map((m) => `  - ${m.label}: ${m.ssl_days < 0 ? `expired ${-m.ssl_days}d ago` : `expires in ${m.ssl_days}d`}`);
      await notify(`InfraLoom — SSL certificates expiring soon:\n${lines.join('\n')}`, 'ssl_expiring');
    }
  } catch (e) {
    console.error('[SSL] Digest notification failed:', e.message);
  }
}

module.exports = { checkAllSSL, checkSSL };
