'use strict';

const express = require('express');
const db = require('../db/database');
const proxmox = require('../lib/proxmoxClient');
const hyperv = require('../lib/hypervClient');
const esxi = require('../lib/esxiClient');

const router = express.Router();

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
  const deviceCounts = (table) => {
    const row = db
      .prepare(
        `SELECT COUNT(*) as total, SUM(CASE WHEN m.last_status = 'up' THEN 1 ELSE 0 END) as online
         FROM ${table} d LEFT JOIN monitors m ON m.id = d.monitor_id`
      )
      .get();
    return { total: row.total || 0, online: row.online || 0 };
  };

  const monitorRow = db.prepare("SELECT COUNT(*) as total, SUM(CASE WHEN last_status = 'up' THEN 1 ELSE 0 END) as up FROM monitors WHERE enabled = 1").get();
  const sslExpiring = db
    .prepare("SELECT label, ssl_days FROM monitors WHERE enabled = 1 AND ssl_days IS NOT NULL AND ssl_days <= 14 ORDER BY ssl_days ASC LIMIT 5")
    .all();
  const licencesExpiring = db
    .prepare("SELECT vendor, licence_type, expiry_date, julianday(expiry_date) - julianday('now') as days_left FROM licences WHERE hidden = 0 AND expiry_date IS NOT NULL AND julianday(expiry_date) - julianday('now') <= 14 ORDER BY expiry_date ASC LIMIT 5")
    .all();
  const netscanRow = db.prepare('SELECT COUNT(*) as total, SUM(CASE WHEN is_online = 1 THEN 1 ELSE 0 END) as online FROM network_devices WHERE is_archived = 0').get();
  const lastSpeedTest = db.prepare("SELECT provider, download, upload, ping, created_at FROM speed_tests WHERE status = 'done' ORDER BY created_at DESC LIMIT 1").get();
  const dnsCount = db.prepare('SELECT COUNT(*) as total FROM dns_local').get();
  const pendingPatchesRow = db.prepare("SELECT COUNT(*) as n FROM patch_runs WHERE id IN (SELECT MAX(id) FROM patch_runs GROUP BY connection_id, node, vmid) AND status = 'awaiting_approval'").get();

  // Hypervisor summary — live, same as the internal widget (best-effort per connection).
  const connections = db.prepare('SELECT * FROM hypervisor_connections WHERE enabled = 1').all();
  let vmsRunning = 0;
  let vmsTotal = 0;
  await Promise.allSettled(
    connections.map(async (conn) => {
      const client = conn.type === 'proxmox' ? proxmox : conn.type === 'hyperv' ? hyperv : conn.type === 'esxi' ? esxi : null;
      if (!client) return;
      const nodes = await client.fetchNodesSummary(conn);
      for (const n of nodes) {
        vmsRunning += n.running_count || 0;
        vmsTotal += (n.vm_count || 0) + (n.lxc_count || 0);
      }
    })
  );

  res.json({
    monitors: { total: monitorRow.total || 0, up: monitorRow.up || 0 },
    ssl_expiring: sslExpiring,
    licences_expiring: licencesExpiring,
    routers: deviceCounts('routers'),
    switches: deviceCounts('switches'),
    access_points: deviceCounts('access_points'),
    dns_configured: dnsCount.total || 0,
    network_devices: { total: netscanRow.total || 0, online: netscanRow.online || 0 },
    last_speed_test: lastSpeedTest || null,
    pending_patches: pendingPatchesRow.n || 0,
    hypervisors: { vms_running: vmsRunning, vms_total: vmsTotal, connections: connections.length },
  });
});

// GET /api/status/public/hypervisors — TV/NOC hypervisor overview, no auth.
// Summary only — no VM/LXC names, no IPs, no credentials.
router.get('/public/hypervisors', async (req, res) => {
  const connections = db.prepare('SELECT * FROM hypervisor_connections WHERE enabled = 1').all();

  const results = await Promise.allSettled(
    connections.map(async (conn) => {
      const client = conn.type === 'proxmox' ? proxmox : conn.type === 'hyperv' ? hyperv : conn.type === 'esxi' ? esxi : null;
      if (!client) throw new Error(`Unsupported type: ${conn.type}`);
      const nodes = await client.fetchNodesSummary(conn);
      return {
        name: conn.name,
        type: conn.type,
        nodes: nodes.map((n) => ({
          node: n.node,
          online: n.status === 'online',
          cpu_pct: n.cpu_usage ?? null,
          ram_pct: n.mem_usage ?? null,
          disk_pct: n.disk_usage ?? null,
          vms_running: n.running_count || 0,
          vms_total: (n.vm_count || 0) + (n.lxc_count || 0),
        })),
      };
    })
  );

  const connectionsOut = results.map((r, i) =>
    r.status === 'fulfilled' ? r.value : { name: connections[i].name, type: connections[i].type, error: true, nodes: [] }
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

