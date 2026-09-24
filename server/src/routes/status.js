'use strict';

const express = require('express');
const dnsLib = require('dns').promises;
const db = require('../db/database');
const proxmox = require('../lib/proxmoxClient');
const hyperv = require('../lib/hypervClient');
const esxi = require('../lib/esxiClient');

const router = express.Router();

function tvPageEnabled(key) {
  const row = db.prepare('SELECT value FROM settings WHERE key = ?').get(key);
  return row ? row.value !== '0' : true; // default enabled if never set
}

// GET /api/status/public — for the public /status page
router.get('/public', (req, res) => {
  const monitors = db
    .prepare(
      `SELECT id, label, type, last_status, last_latency_ms, last_checked_at, ssl_days, ssl_expiry, ssl_error
       FROM monitors WHERE enabled = 1 ORDER BY label`
    )
    .all();
  res.json({ monitors });
});

// GET /api/status/public/:id/checks — sparkline data, no auth
router.get('/public/:id/checks', (req, res) => {
  const hours = Math.min(parseInt(req.query.hours, 10) || 3, 24);
  const since = new Date(Date.now() - hours * 3600 * 1000).toISOString().replace('T', ' ').substring(0, 19);
  const checks = db
    .prepare('SELECT status, latency_ms, checked_at FROM monitor_checks WHERE monitor_id = ? AND checked_at >= ? ORDER BY checked_at ASC LIMIT 500')
    .all(req.params.id, since);
  res.json({ checks });
});

// GET /api/status/public/dashboard — TV/NOC dashboard summary, no auth.
// Deliberately returns only counts/aggregates — never tokens, credentials,
// or internal IPs — matching the /public pattern above.
router.get('/public/dashboard', async (req, res) => {
  if (!tvPageEnabled('tv_dashboard_enabled')) return res.status(404).json({ error: 'This page is disabled' });

  const deviceList = (table) =>
    db
      .prepare(
        `SELECT d.name, d.ip_address, m.last_status
         FROM ${table} d LEFT JOIN monitors m ON m.id = d.monitor_id
         ORDER BY d.name`
      )
      .all()
      .map((d) => ({ name: d.name, detail: d.ip_address, status: d.last_status === 'up' ? 'up' : d.last_status === 'down' ? 'down' : 'unknown' }));

  const monitors = db
    .prepare("SELECT label, last_status, ssl_days FROM monitors WHERE enabled = 1 ORDER BY label")
    .all()
    .map((m) => ({ name: m.label, status: m.last_status === 'up' ? 'up' : m.last_status === 'down' ? 'down' : m.last_status === 'degraded' ? 'degraded' : 'unknown' }));

  const sslExpiring = db
    .prepare("SELECT label, ssl_days FROM monitors WHERE enabled = 1 AND ssl_days IS NOT NULL AND ssl_days <= 14 ORDER BY ssl_days ASC LIMIT 5")
    .all();
  const licencesExpiring = db
    .prepare("SELECT vendor, licence_type, expiry_date, julianday(expiry_date) - julianday('now') as days_left FROM licences WHERE hidden = 0 AND expiry_date IS NOT NULL AND julianday(expiry_date) - julianday('now') <= 14 ORDER BY expiry_date ASC LIMIT 5")
    .all();
  const netscanRow = db.prepare('SELECT COUNT(*) as total, SUM(CASE WHEN is_online = 1 THEN 1 ELSE 0 END) as online FROM network_devices WHERE is_archived = 0').get();
  const lastSpeedTest = db.prepare("SELECT provider, download, upload, ping, created_at FROM speed_tests WHERE status = 'done' ORDER BY created_at DESC LIMIT 1").get();
  const domainCount = db.prepare('SELECT COUNT(*) as total FROM dns_domains').get();
  const pendingPatchesRow = db.prepare("SELECT COUNT(*) as n FROM patch_runs WHERE id IN (SELECT MAX(id) FROM patch_runs GROUP BY connection_id, node, vmid) AND status = 'awaiting_approval'").get();

  // DNS servers — a quick raw resolve check per server (fast; same fallback
  // technique the internal DNS status check uses), not the full per-vendor
  // API auth flow, so a batch of these stays cheap enough for a 30s poll.
  const dnsServers = db.prepare('SELECT role, type, ip, label FROM dns_local ORDER BY role').all();
  const dnsResults = await Promise.all(
    dnsServers.map(async (s) => {
      const dnsIp = s.ip.replace(/^https?:\/\//, '').split(':')[0];
      try {
        const resolver = new dnsLib.Resolver();
        resolver.setServers([dnsIp]);
        await Promise.race([
          resolver.resolve4('cloudflare.com'),
          new Promise((_, reject) => setTimeout(() => reject(new Error('timeout')), 3000)),
        ]);
        return { name: s.label || `${s.type} (${s.role})`, detail: s.role, status: 'up' };
      } catch {
        return { name: s.label || `${s.type} (${s.role})`, detail: s.role, status: 'down' };
      }
    })
  );

  // Hypervisors — grouped by type, per-node rows (live, best-effort per connection).
  const connections = db.prepare('SELECT * FROM hypervisor_connections WHERE enabled = 1').all();
  const hvByType = { proxmox: [], esxi: [], hyperv: [] };
  await Promise.allSettled(
    connections.map(async (conn) => {
      const client = conn.type === 'proxmox' ? proxmox : conn.type === 'hyperv' ? hyperv : conn.type === 'esxi' ? esxi : null;
      if (!client || !hvByType[conn.type]) return;
      const nodes = await client.fetchNodesSummary(conn);
      for (const n of nodes) {
        hvByType[conn.type].push({
          name: n.node, connection: conn.name, status: n.status === 'online' ? 'up' : 'down',
          cpu_pct: n.cpu_usage ?? null, ram_pct: n.mem_usage ?? null,
          running: n.running_count || 0, total: (n.vm_count || 0) + (n.lxc_count || 0),
        });
      }
    })
  );

  const routers = deviceList('routers');
  const switches = deviceList('switches');
  const accessPoints = deviceList('access_points');
  const allHvNodes = [...hvByType.proxmox, ...hvByType.esxi, ...hvByType.hyperv];

  // Overall Operational/Degraded/Down/Total across every individually-tracked item.
  const allItems = [...monitors, ...routers, ...switches, ...accessPoints, ...dnsResults, ...allHvNodes];
  const operational = allItems.filter((i) => i.status === 'up').length;
  const degraded = allItems.filter((i) => i.status === 'degraded').length;
  const down = allItems.filter((i) => i.status === 'down').length;

  res.json({
    summary: { operational, degraded, down, total: allItems.length },
    monitors,
    routers, switches, access_points: accessPoints,
    dns_servers: dnsResults,
    domains_configured: domainCount.total || 0,
    network_devices: { total: netscanRow.total || 0, online: netscanRow.online || 0 },
    last_speed_test: lastSpeedTest || null,
    pending_patches: pendingPatchesRow.n || 0,
    hypervisors: hvByType,
    ssl_expiring: sslExpiring,
    licences_expiring: licencesExpiring,
  });
});

// GET /api/status/public/hypervisors — TV/NOC hypervisor overview, no auth.
// Summary only — no VM/LXC names, no IPs, no credentials.
// GET /api/status/public/hypervisors/history?hours=3 — cluster-wide CPU/RAM
// time series (averaged across all online nodes at each collection tick)
// for the TV Hypervisors page's charts.
router.get('/public/hypervisors/history', (req, res) => {
  if (!tvPageEnabled('tv_hypervisors_enabled')) return res.status(404).json({ error: 'This page is disabled' });
  const hours = Math.min(parseInt(req.query.hours, 10) || 3, 24);
  const points = db
    .prepare(
      `SELECT strftime('%Y-%m-%d %H:%M', recorded_at) as bucket, AVG(cpu_usage) as cpu, AVG(mem_usage) as mem, AVG(disk_usage) as disk
       FROM hypervisor_node_metrics
       WHERE recorded_at >= datetime('now', ?)
       GROUP BY bucket ORDER BY bucket ASC`
    )
    .all(`-${hours} hours`);
  res.json({ points });
});

router.get('/public/hypervisors', async (req, res) => {
  if (!tvPageEnabled('tv_hypervisors_enabled')) return res.status(404).json({ error: 'This page is disabled' });

  const connections = db.prepare('SELECT * FROM hypervisor_connections WHERE enabled = 1').all();

  const results = await Promise.allSettled(
    connections.map(async (conn) => {
      const client = conn.type === 'proxmox' ? proxmox : conn.type === 'hyperv' ? hyperv : conn.type === 'esxi' ? esxi : null;
      if (!client) throw new Error(`Unsupported type: ${conn.type}`);

      const summary = await client.fetchNodesSummary(conn);
      const nodes = await Promise.all(
        summary.map(async (n) => {
          if (n.status !== 'online') {
            return { node: n.node, online: false, cpu_pct: null, ram_pct: null, disk_pct: null, uptime_s: n.uptime || 0, guests: [], storages: [] };
          }
          // Proxmox needs the node name; Hyper-V/ESXi have one implicit node.
          const detail = conn.type === 'proxmox' ? await client.fetchNodeDetail(conn, n.node) : await client.fetchNodeDetail(conn);
          const guests = [...(detail.vms || []), ...(detail.lxc || [])].map((g) => ({
            vmid: g.vmid, name: g.name, type: g.type,
            status: g.status, os: g.os, ip: g.ip,
            cpu_pct: g.cpu_usage ?? null, mem_pct: g.mem_usage ?? null, disk_pct: g.disk_usage ?? null,
            mem_used_gb: g.mem_used_gb, mem_max_gb: g.mem_max_gb, cpus: g.cpus,
          }));
          const storages = (detail.storages || []).map((s) => ({ name: s.storage, usage_pct: s.usage_pct, used_gb: s.used_gb, total_gb: s.total_gb }));
          return {
            node: n.node, online: true,
            cpu_pct: n.cpu_usage ?? null, ram_pct: n.mem_usage ?? null, disk_pct: n.disk_usage ?? null,
            uptime_s: n.uptime || 0,
            mem_used_gb: n.mem_used_gb, mem_max_gb: n.mem_max_gb, cpus: n.cpus,
            running_count: n.running_count || 0, total_count: (n.vm_count || 0) + (n.lxc_count || 0),
            guests, storages,
          };
        })
      );
      const uniqueStorages = new Map();
      for (const n of nodes) {
        for (const s of n.storages) {
          if (s.usage_pct === null || s.usage_pct === undefined) continue; // no capacity data — nothing useful to show
          if (!uniqueStorages.has(s.name)) uniqueStorages.set(s.name, s);
        }
      }
      return { name: conn.name, type: conn.type, nodes, storages: [...uniqueStorages.values()] };
    })
  );

  const connectionsOut = results.map((r, i) =>
    r.status === 'fulfilled' ? r.value : { name: connections[i].name, type: connections[i].type, error: true, nodes: [], storages: [] }
  );

  res.json({ connections: connectionsOut });
});

// POST/GET /api/status/push/:token — heartbeat ingestion from an external system
function handlePush(req, res) {
  const monitor = db.prepare("SELECT * FROM monitors WHERE push_token = ? AND type = 'push'").get(req.params.token);
  if (!monitor) return res.status(404).json({ error: 'Unknown push token' });
  if (!monitor.enabled) return res.status(403).json({ error: 'Monitor is disabled' });

  const latency = req.query.latency ? parseInt(req.query.latency, 10) : null;

  db.prepare("UPDATE monitors SET last_push_at = datetime('now') WHERE id = ?").run(monitor.id);

  try {
    const { recordResult } = require('../services/monitorWorker');
    recordResult(monitor, { status: 'up', latency_ms: latency });
  } catch {
    // worker unavailable — heartbeat timestamp is still recorded above
  }

  res.json({ ok: true });
}
router.get('/push/:token', handlePush);
router.post('/push/:token', handlePush);

module.exports = router;

