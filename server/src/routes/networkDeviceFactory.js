'use strict';

const express = require('express');
const db = require('../db/database');
const { requireAuth, requireRole } = require('../middleware/auth');
const { writeAuditLog } = require('../middleware/audit');

const BRANDS = ['mikrotik', 'cisco', 'fortigate', 'ubiquiti', 'juniper', 'hp', 'aruba', 'other'];

function getMonitorWorker() {
  try {
    return require('../services/monitorWorker');
  } catch {
    return null;
  }
}

/** Creates a router mounted at e.g. /api/routers, backed by `table`
 * (routers | switches | access_points) and labeled `moduleLabel` for
 * audit logs. All three device types share identical logic — only the
 * table name and audit-log module tag differ. */
function createDeviceRouter(table, moduleLabel) {
  const router = express.Router();
  router.use(requireAuth);

  function withMonitor(row) {
    if (!row) return row;
    const m = row.monitor_id ? db.prepare('SELECT last_status, last_latency_ms, last_checked_at FROM monitors WHERE id = ?').get(row.monitor_id) : null;
    return {
      ...row,
      device_password: row.device_password ? '***' : null,
      last_status: m?.last_status || 'unknown',
      last_latency_ms: m?.last_latency_ms ?? null,
      last_checked_at: m?.last_checked_at || null,
    };
  }

  // GET /api/{table}
  router.get('/', (req, res) => {
    const rows = db.prepare(`SELECT * FROM ${table} ORDER BY name`).all();
    res.json({ devices: rows.map(withMonitor), brands: BRANDS });
  });

  // POST /api/{table}
  router.post('/', requireRole('superadmin', 'admin', 'operator'), (req, res) => {
    const {
      name, brand, model, ip_address, username, device_password, notes,
      snmp_version, snmp_community, snmp_port, snmp_username,
      snmp_auth_protocol, snmp_auth_password, snmp_priv_protocol, snmp_priv_password, snmp_security_level,
    } = req.body || {};

    if (!name?.trim()) return res.status(400).json({ error: 'name is required' });
    if (!ip_address?.trim()) return res.status(400).json({ error: 'ip_address is required' });

    // Ping is mandatory: back every device with an icmp monitor.
    const monitorResult = db
      .prepare(`INSERT INTO monitors (label, type, target, interval_s) VALUES (?, 'icmp', ?, 60)`)
      .run(name.trim(), ip_address.trim());
    const monitorId = monitorResult.lastInsertRowid;
    const worker = getMonitorWorker();
    worker?.registerMonitor(db.prepare('SELECT * FROM monitors WHERE id = ?').get(monitorId));

    const r = db
      .prepare(
        `INSERT INTO ${table}
          (name, brand, model, ip_address, username, device_password, notes, monitor_id,
           snmp_version, snmp_community, snmp_port, snmp_username,
           snmp_auth_protocol, snmp_auth_password, snmp_priv_protocol, snmp_priv_password, snmp_security_level)
         VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`
      )
      .run(
        name.trim(), brand || 'other', model || null, ip_address.trim(),
        username || null, device_password || null, notes || null, monitorId,
        snmp_version || '2c', snmp_community || 'public', parseInt(snmp_port, 10) || 161,
        snmp_username || null, snmp_auth_protocol || 'SHA', snmp_auth_password || null,
        snmp_priv_protocol || 'AES', snmp_priv_password || null, snmp_security_level || 'authPriv'
      );

    writeAuditLog({
      user_id: req.user.id, username: req.user.username, action: `${moduleLabel}.create`,
      entity_type: moduleLabel, entity_id: r.lastInsertRowid, module: moduleLabel,
      details: { name: name.trim(), ip_address: ip_address.trim() }, ip_address: req.ip,
    });

    res.status(201).json({ device: withMonitor(db.prepare(`SELECT * FROM ${table} WHERE id = ?`).get(r.lastInsertRowid)) });
  });

  // PUT /api/{table}/:id
  router.put('/:id', requireRole('superadmin', 'admin', 'operator'), (req, res) => {
    const existing = db.prepare(`SELECT * FROM ${table} WHERE id = ?`).get(req.params.id);
    if (!existing) return res.status(404).json({ error: 'Not found' });

    const {
      name, brand, model, ip_address, username, device_password, notes,
      snmp_version, snmp_community, snmp_port, snmp_username,
      snmp_auth_protocol, snmp_auth_password, snmp_priv_protocol, snmp_priv_password, snmp_security_level,
    } = req.body || {};

    const newPassword = device_password && device_password !== '***' ? device_password : existing.device_password;
    const newIp = ip_address?.trim() || existing.ip_address;
    const newName = name?.trim() || existing.name;

    db.prepare(
      `UPDATE ${table} SET
        name=?, brand=?, model=?, ip_address=?, username=?, device_password=?, notes=?,
        snmp_version=?, snmp_community=?, snmp_port=?, snmp_username=?,
        snmp_auth_protocol=?, snmp_auth_password=?, snmp_priv_protocol=?, snmp_priv_password=?, snmp_security_level=?
       WHERE id=?`
    ).run(
      newName, brand ?? existing.brand, model !== undefined ? model || null : existing.model,
      newIp, username !== undefined ? username || null : existing.username, newPassword,
      notes !== undefined ? notes || null : existing.notes,
      snmp_version ?? existing.snmp_version, snmp_community ?? existing.snmp_community,
      snmp_port ? parseInt(snmp_port, 10) : existing.snmp_port,
      snmp_username !== undefined ? snmp_username || null : existing.snmp_username,
      snmp_auth_protocol ?? existing.snmp_auth_protocol,
      snmp_auth_password && snmp_auth_password !== '***' ? snmp_auth_password : existing.snmp_auth_password,
      snmp_priv_protocol ?? existing.snmp_priv_protocol,
      snmp_priv_password && snmp_priv_password !== '***' ? snmp_priv_password : existing.snmp_priv_password,
      snmp_security_level ?? existing.snmp_security_level,
      req.params.id
    );

    // Keep the linked monitor's label/target in sync.
    if (existing.monitor_id) {
      db.prepare("UPDATE monitors SET label=?, target=? WHERE id=?").run(newName, newIp, existing.monitor_id);
      const worker = getMonitorWorker();
      const m = db.prepare('SELECT * FROM monitors WHERE id = ?').get(existing.monitor_id);
      worker?.unregisterMonitor(existing.monitor_id);
      if (m?.enabled) worker?.registerMonitor(m);
    }

    writeAuditLog({
      user_id: req.user.id, username: req.user.username, action: `${moduleLabel}.update`,
      entity_type: moduleLabel, entity_id: req.params.id, module: moduleLabel,
      details: { name: newName }, ip_address: req.ip,
    });

    res.json({ device: withMonitor(db.prepare(`SELECT * FROM ${table} WHERE id = ?`).get(req.params.id)) });
  });

  // DELETE /api/{table}/:id
  router.delete('/:id', requireRole('superadmin', 'admin'), (req, res) => {
    const existing = db.prepare(`SELECT * FROM ${table} WHERE id = ?`).get(req.params.id);
    if (!existing) return res.status(404).json({ error: 'Not found' });

    if (existing.monitor_id) {
      getMonitorWorker()?.unregisterMonitor(existing.monitor_id);
      db.prepare('DELETE FROM monitors WHERE id = ?').run(existing.monitor_id);
    }
    db.prepare(`DELETE FROM ${table} WHERE id = ?`).run(req.params.id);

    writeAuditLog({
      user_id: req.user.id, username: req.user.username, action: `${moduleLabel}.delete`,
      entity_type: moduleLabel, entity_id: req.params.id, module: moduleLabel,
      details: { name: existing.name }, ip_address: req.ip,
    });

    res.json({ ok: true });
  });

  // POST /api/{table}/:id/reveal-password
  router.post('/:id/reveal-password', requireRole('superadmin', 'admin', 'operator'), (req, res) => {
    const existing = db.prepare(`SELECT device_password FROM ${table} WHERE id = ?`).get(req.params.id);
    if (!existing) return res.status(404).json({ error: 'Not found' });
    writeAuditLog({
      user_id: req.user.id, username: req.user.username, action: `${moduleLabel}.reveal_password`,
      entity_type: moduleLabel, entity_id: req.params.id, module: moduleLabel, ip_address: req.ip,
    });
    res.json({ password: existing.device_password });
  });

  // GET /api/{table}/:id/snmp-stats — on-demand, not continuously polled
  router.get('/:id/snmp-stats', async (req, res) => {
    const existing = db.prepare(`SELECT * FROM ${table} WHERE id = ?`).get(req.params.id);
    if (!existing) return res.status(404).json({ error: 'Not found' });

    const { pollSnmp } = require('../lib/snmpGeneric');
    const cfg = {
      snmp_version: existing.snmp_version, snmp_community: existing.snmp_community, snmp_port: existing.snmp_port,
      snmp_username: existing.snmp_username, snmp_auth_protocol: existing.snmp_auth_protocol,
      snmp_auth_password: existing.snmp_auth_password, snmp_priv_protocol: existing.snmp_priv_protocol,
      snmp_priv_password: existing.snmp_priv_password, snmp_security_level: existing.snmp_security_level,
    };
    const result = await pollSnmp(existing.ip_address, cfg);
    res.json(result);
  });

  return router;
}

module.exports = { createDeviceRouter, BRANDS };
