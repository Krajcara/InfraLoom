'use strict';

const db = require('../../db/database');

const TABLE = { router: 'routers', switch: 'switches', access_point: 'access_points' };

/** What InfraLoom knows right now about the thing a cabling device points at:
 * { state: 'up'|'down'|'warn'|'unknown'|'missing', alerts, maintenance, name }. Never throws. */
function liveFor(kind, id) {
  try {
    const maintenance = require('../maintenanceService');
    if (TABLE[kind]) {
      const d = db.prepare(`SELECT * FROM ${TABLE[kind]} WHERE id = ?`).get(id);
      if (!d) return { state: 'missing', alerts: 0, maintenance: false, name: null };
      let state = 'unknown';
      let window = null;
      if (d.discovered_from_router_id) {
        state = d.controller_status === 'up' ? 'up' : d.controller_status === 'down' ? 'down' : 'unknown';
        window = maintenance.activeFor(kind, id);
      } else if (d.monitor_id) {
        const m = db.prepare('SELECT last_status FROM monitors WHERE id = ?').get(d.monitor_id);
        state = m?.last_status === 'up' ? 'up' : m?.last_status === 'down' ? 'down' : 'unknown';
        window = maintenance.activeFor('monitor', d.monitor_id);
      }
      const alerts = db.prepare("SELECT COUNT(*) c FROM device_health_state WHERE device_table = ? AND device_id = ? AND level != 'ok'").get(TABLE[kind], id).c;
      return { state, alerts, maintenance: !!window, name: d.name };
    }
    if (kind === 'hypervisor') {
      const c = db.prepare('SELECT name, last_health_status FROM hypervisor_connections WHERE id = ?').get(id);
      if (!c) return { state: 'missing', alerts: 0, maintenance: false, name: null };
      const alerts = db.prepare("SELECT COUNT(*) c FROM hypervisor_threshold_state WHERE connection_id = ? AND level != 'ok'").get(id).c;
      return { state: c.last_health_status === 'up' ? 'up' : c.last_health_status === 'down' ? 'down' : 'unknown', alerts, maintenance: !!maintenance.activeFor('hypervisor', id), name: c.name };
    }
    if (kind === 'ups') {
      const u = db.prepare('SELECT name, last_status FROM ups_devices WHERE id = ?').get(id);
      if (!u) return { state: 'missing', alerts: 0, maintenance: false, name: null };
      const state = u.last_status === 'online' ? 'up' : ['on_battery', 'low_battery'].includes(u.last_status) ? 'warn' : u.last_status === 'offline' ? 'down' : 'unknown';
      return { state, alerts: 0, maintenance: !!maintenance.activeFor('ups', id), name: u.name };
    }
  } catch { /* a status problem must never break the inventory */ }
  return { state: 'unknown', alerts: 0, maintenance: false, name: null };
}

module.exports = { liveFor };
