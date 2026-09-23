'use strict';

const db = require('../db/database');
const { notify } = require('./notificationService');
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

async function checkOne(conn) {
  const client = clientFor(conn.type);
  if (!client) return;

  let reachable = true;
  try {
    await client.fetchNodesSummary(conn);
  } catch {
    reachable = false;
  }

  // wasReachable is true both when the last check was 'up' AND when this
  // connection has never been checked before (last_health_status is null) —
  // that second case is what makes a first-ever "down" result still notify
  // (e.g. this connection existed before health checking was added), while
  // a first-ever "up" result stays silent (nothing to recover from yet).
  // Once set, last_health_status is never null again, so this only affects
  // the very first check of a connection's lifetime.
  const wasReachable = conn.last_health_status !== 'down';

  db.prepare('UPDATE hypervisor_connections SET last_health_status = ? WHERE id = ?').run(reachable ? 'up' : 'down', conn.id);

  if (!reachable && wasReachable) {
    await notify(`Hypervisor connection "${conn.name}" is unreachable.`, 'hypervisor_down');
  } else if (reachable && !wasReachable) {
    await notify(`Hypervisor connection "${conn.name}" is reachable again.`, 'hypervisor_up');
  }
}

async function runHealthCheck() {
  const connections = db.prepare('SELECT * FROM hypervisor_connections WHERE enabled = 1 AND health_check_enabled = 1').all();
  await Promise.allSettled(connections.map(checkOne));
}

let cronTask = null;
function reschedule(cronExpr) {
  const cron = require('node-cron');
  if (cronTask) {
    cronTask.stop();
    cronTask = null;
  }
  if (!cronExpr || !cron.validate(cronExpr)) {
    console.error(`[HypervisorHealth] Invalid cron expression "${cronExpr}" — scheduler disabled`);
    return false;
  }
  cronTask = cron.schedule(cronExpr, () => {
    runHealthCheck().catch((err) => console.error('[HypervisorHealth] Check failed:', err.message));
  });
  return true;
}

function initScheduler() {
  reschedule(getSetting('hypervisor_health_cron', '*/5 * * * *'));
}

module.exports = { runHealthCheck, reschedule, initScheduler };
