'use strict';

const db = require('../db/database');
const proxmox = require('../lib/proxmoxClient');
const hyperv = require('../lib/hypervClient');
const esxi = require('../lib/esxiClient');

function getSetting(key, fallback) {
  return db.prepare('SELECT value FROM settings WHERE key = ?').get(key)?.value ?? fallback;
}

function clientFor(type) {
  if (type === 'proxmox') return proxmox;
  if (type === 'hyperv') return hyperv;
  if (type === 'esxi') return esxi;
  return null;
}

const insertStmt = db.prepare(
  'INSERT INTO hypervisor_node_metrics (connection_id, node, cpu_usage, mem_usage, disk_usage) VALUES (?, ?, ?, ?, ?)'
);

async function collectOne(conn) {
  const client = clientFor(conn.type);
  if (!client) return;
  try {
    const nodes = await client.fetchNodesSummary(conn);
    for (const n of nodes) {
      if (n.status !== 'online') continue;
      insertStmt.run(conn.id, n.node, n.cpu_usage ?? null, n.mem_usage ?? null, n.disk_usage ?? null);
    }
  } catch {
    // connection unreachable this tick — health check already tracks/alerts
    // on this separately, so metrics collection just skips silently.
  }
}

async function collectAll() {
  const connections = db.prepare('SELECT * FROM hypervisor_connections WHERE enabled = 1').all();
  await Promise.allSettled(connections.map(collectOne));

  const retentionHours = parseInt(getSetting('hypervisor_metrics_retention_hours', '24'), 10) || 24;
  db.prepare("DELETE FROM hypervisor_node_metrics WHERE recorded_at < datetime('now', ?)").run(`-${retentionHours} hours`);
}

let cronTask = null;
function reschedule(cronExpr) {
  const cron = require('node-cron');
  if (cronTask) {
    cronTask.stop();
    cronTask = null;
  }
  if (!cronExpr || !cron.validate(cronExpr)) {
    console.error(`[HypervisorMetrics] Invalid cron expression "${cronExpr}" — scheduler disabled`);
    return false;
  }
  cronTask = cron.schedule(cronExpr, () => {
    collectAll().catch((err) => console.error('[HypervisorMetrics] Collection failed:', err.message));
  });
  return true;
}

function initScheduler() {
  reschedule(getSetting('hypervisor_metrics_cron', '*/2 * * * *'));
}

module.exports = { collectAll, reschedule, initScheduler };
