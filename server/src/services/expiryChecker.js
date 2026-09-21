'use strict';

const db = require('../db/database');
const { notify } = require('./notificationService');

const WARNING_WINDOW_DAYS = 30;

function daysUntil(dateStr) {
  return Math.ceil((new Date(dateStr) - new Date()) / 86400000);
}

/** Checks licences and Entra ID app secrets for items expiring soon or
 * already expired, and sends a single digest notification if any are found.
 * Never throws — logs and swallows errors so a bad run doesn't crash the
 * scheduler. */
async function checkExpiries() {
  try {
    const licences = db
      .prepare("SELECT vendor, licence_type, expiry_date FROM licences WHERE hidden = 0 AND expiry_date IS NOT NULL")
      .all()
      .map((l) => ({ ...l, days: daysUntil(l.expiry_date) }))
      .filter((l) => l.days <= WARNING_WINDOW_DAYS);

    const entraApps = db
      .prepare("SELECT app_name, secret_expiry FROM entra_apps WHERE hidden = 0 AND secret_expiry IS NOT NULL")
      .all()
      .map((a) => ({ ...a, days: daysUntil(a.secret_expiry) }))
      .filter((a) => a.days <= WARNING_WINDOW_DAYS);

    if (licences.length === 0 && entraApps.length === 0) return;

    const lines = [];
    if (licences.length > 0) {
      lines.push(`Licences (${licences.length}):`);
      licences.forEach((l) => {
        const status = l.days < 0 ? `expired ${-l.days}d ago` : `expires in ${l.days}d`;
        lines.push(`  - ${l.vendor} ${l.licence_type}: ${status}`);
      });
    }
    if (entraApps.length > 0) {
      lines.push(`Entra ID app secrets (${entraApps.length}):`);
      entraApps.forEach((a) => {
        const status = a.days < 0 ? `expired ${-a.days}d ago` : `expires in ${a.days}d`;
        lines.push(`  - ${a.app_name}: ${status}`);
      });
    }

    await notify(`InfraLoom — upcoming expirations:\n${lines.join('\n')}`);
  } catch (err) {
    console.error('[expiryChecker] check failed:', err.message);
  }
}

module.exports = { checkExpiries };
