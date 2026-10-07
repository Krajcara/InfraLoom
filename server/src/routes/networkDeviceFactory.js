'use strict';

const express = require('express');
const maintenance = require('../services/maintenanceService');
const deviceHealth = require('../services/deviceHealthService');
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

  function withMonitor(input) {
    if (!input) return input;
    // the raw device replies are large and only needed on demand
    const { health_raw, health_last, ...row } = input;
    const health = deviceHealth.summaryFor(table, input);
    // FortiGate-discovered devices: status is what the FortiGate reports, not a ping.
    if (row.discovered_from_router_id) {
      return {
        ...row,
        health,
        device_password: row.device_password ? '***' : null,
        api_token: row.api_token ? '***' : null,
        last_status: row.discovered_missing_at ? 'down' : row.controller_status || 'unknown',
        last_latency_ms: null,
        last_checked_at: row.controller_checked_at || null,
        status_source: 'fortigate',
        in_maintenance: maintenance.brief(maintenance.activeFor(table === 'switches' ? 'switch' : 'access_point', row.id)),
      };
    }
    const m = row.monitor_id ? db.prepare('SELECT last_status, last_latency_ms, last_checked_at FROM monitors WHERE id = ?').get(row.monitor_id) : null;
    return {
      ...row,
      health,
      device_password: row.device_password ? '***' : null,
      api_token: row.api_token ? '***' : null,
      last_status: m?.last_status || 'unknown',
      last_latency_ms: m?.last_latency_ms ?? null,
      last_checked_at: m?.last_checked_at || null,
      in_maintenance: row.monitor_id ? maintenance.brief(maintenance.activeFor('monitor', row.monitor_id)) : maintenance.brief(maintenance.activeFor(null, null)),
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
      name, brand, model, ip_address, username, device_password, notes, api_token,
      snmp_version, snmp_community, snmp_port, snmp_username,
      snmp_auth_protocol, snmp_auth_password, snmp_priv_protocol, snmp_priv_password, snmp_security_level,
    } = req.body || {};

    if (!name?.trim()) return res.status(400).json({ error: 'name is required' });
    if (!ip_address?.trim()) return res.status(400).json({ error: 'ip_address is required' });

    // Ping is mandatory: back every device with an icmp monitor.
    const monitorResult = db
      .prepare(`INSERT INTO monitors (label, type, target, interval_s, hidden) VALUES (?, 'icmp', ?, 60, 1)`)
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

    if (table === 'routers' && api_token) {
      db.prepare('UPDATE routers SET api_token = ? WHERE id = ?').run(api_token, r.lastInsertRowid);
    }

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
      name, brand, model, ip_address, username, device_password, notes, api_token,
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

    if (table === 'routers' && api_token !== undefined && api_token !== '***') {
      db.prepare('UPDATE routers SET api_token = ? WHERE id = ?').run(api_token || null, req.params.id);
    }

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
    db.prepare('DELETE FROM device_health_state WHERE device_table = ? AND device_id = ?').run(table, req.params.id);

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

  // ── Health (opt-in) ─────────────────────────────────────────────────────
  const parse = (v) => { try { return v ? JSON.parse(v) : null; } catch { return null; } };
  const healthView = (row) => ({
    ...deviceHealth.summaryFor(table, row),
    method: deviceHealth.methodFor(table, row),
    watch_ifaces: deviceHealth.watchList(row),
    last: parse(row.health_last),
  });

  // GET /api/{table}/:id/health
  router.get('/:id/health', (req, res) => {
    const row = db.prepare(`SELECT * FROM ${table} WHERE id = ?`).get(req.params.id);
    if (!row) return res.status(404).json({ error: 'Not found' });
    res.json(healthView(row));
  });

  // GET /api/{table}/:id/health/raw — what the device actually answered, per section
  router.get('/:id/health/raw', (req, res) => {
    const row = db.prepare(`SELECT health_raw, health_checked_at FROM ${table} WHERE id = ?`).get(req.params.id);
    if (!row) return res.status(404).json({ error: 'Not found' });
    res.json({ checked_at: row.health_checked_at, raw: parse(row.health_raw) });
  });

  // PUT /api/{table}/:id/health { enabled?, watch_ifaces?: [names], reset_ha_baseline? }
  router.put('/:id/health', requireRole('superadmin', 'admin'), (req, res) => {
    const row = db.prepare(`SELECT * FROM ${table} WHERE id = ?`).get(req.params.id);
    if (!row) return res.status(404).json({ error: 'Not found' });
    if (row.discovered_from_router_id) return res.status(400).json({ error: 'FortiGate-discovered devices are not reachable from here; their state comes from the FortiGate' });
    const { enabled, watch_ifaces: watch, reset_ha_baseline: resetHa } = req.body || {};
    if (watch !== undefined) {
      if (!Array.isArray(watch) || watch.length > 64 || watch.some((n) => typeof n !== 'string' || n.length > 64 || n.includes(','))) return res.status(400).json({ error: 'watch_ifaces must be a list of up to 64 interface names' });
      db.prepare(`UPDATE ${table} SET health_watch_ifaces = ? WHERE id = ?`).run(watch.map((n) => n.trim()).filter(Boolean).join(','), row.id);
    }
    if (resetHa) {
      const last = parse(row.health_last);
      if (last?.baselines) { delete last.baselines.ha; db.prepare(`UPDATE ${table} SET health_last = ? WHERE id = ?`).run(JSON.stringify(last), row.id); }
    }
    if (typeof enabled === 'boolean') deviceHealth.setEnabled(table, row.id, enabled);
    writeAuditLog({ user_id: req.user.id, username: req.user.username, action: `${moduleLabel}.health.update`, entity_type: moduleLabel, entity_id: row.id, module: moduleLabel, details: { name: row.name, enabled, watch_ifaces: watch }, ip_address: req.ip });
    res.json(healthView(db.prepare(`SELECT * FROM ${table} WHERE id = ?`).get(row.id)));
  });

  // POST /api/{table}/:id/health/poll — read it now
  router.post('/:id/health/poll', requireRole('superadmin', 'admin', 'operator'), async (req, res) => {
    const row = db.prepare(`SELECT * FROM ${table} WHERE id = ?`).get(req.params.id);
    if (!row) return res.status(404).json({ error: 'Not found' });
    const result = await deviceHealth.pollDevice(table, row.id);
    res.json({ result, ...healthView(db.prepare(`SELECT * FROM ${table} WHERE id = ?`).get(row.id)) });
  });

  // POST /api/{table}/:id/sync — pulls managed switches/APs from this
  // router (FortiGate only). Only registered for the routers table.
  if (table === 'routers') {
    router.post('/:id/sync', requireRole('superadmin', 'admin', 'operator'), async (req, res) => {
      const existing = db.prepare('SELECT * FROM routers WHERE id = ?').get(req.params.id);
      if (!existing) return res.status(404).json({ error: 'Not found' });
      try {
        const { syncRouter } = require('../services/fortigateSyncService');
        const result = await syncRouter(req.params.id);
        writeAuditLog({
          user_id: req.user.id, username: req.user.username, action: 'routers.sync',
          entity_type: 'routers', entity_id: req.params.id, module: 'routers',
          details: result, ip_address: req.ip,
        });
        res.json({ ok: true, ...result });
      } catch (err) {
        res.status(500).json({ error: err.message });
      }
    });
  }

  return router;
}

module.exports = { createDeviceRouter, BRANDS };
