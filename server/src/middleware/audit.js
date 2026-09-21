'use strict';

const db = require('../db/database');

const insertAudit = db.prepare(`
  INSERT INTO audit_log (user_id, username, action, entity_type, entity_id, module, details, ip_address)
  VALUES (@user_id, @username, @action, @entity_type, @entity_id, @module, @details, @ip_address)
`);

/**
 * Writes one row to the audit log. Never throws — a failed audit write
 * must not break the request it's attached to.
 *
 * @param {object} entry
 * @param {number|null} entry.user_id
 * @param {string|null} entry.username
 * @param {string} entry.action       e.g. 'user.create', 'monitor.delete'
 * @param {string|null} entry.entity_type
 * @param {string|number|null} entry.entity_id
 * @param {string|null} entry.module  e.g. 'auth', 'hypervisors', 'network-scanner'
 * @param {string|object|null} entry.details
 * @param {string|null} entry.ip_address
 */
function writeAuditLog(entry) {
  try {
    insertAudit.run({
      user_id: entry.user_id ?? null,
      username: entry.username ?? null,
      action: entry.action,
      entity_type: entry.entity_type ?? null,
      entity_id: entry.entity_id != null ? String(entry.entity_id) : null,
      module: entry.module ?? null,
      details: typeof entry.details === 'object' ? JSON.stringify(entry.details) : (entry.details ?? null),
      ip_address: entry.ip_address ?? null,
    });
  } catch (err) {
    console.error('[audit] Failed to write audit log entry:', err.message);
  }
}

module.exports = { writeAuditLog };
