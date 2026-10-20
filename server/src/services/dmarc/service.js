'use strict';

// DMARC module: builds the Graph client and the ingestor from the current settings, and runs the scheduled jobs
// (read the mailbox, daily clean-up and the client-secret reminder). Settings changes call reload().

const cron = require('node-cron');
const config = require('./config');
const { createStore } = require('./store');
const { createGraphClient } = require('./graph');
const { createIngestor } = require('./ingest');
const { createCloudflareClient } = require('./cloudflare');
const { createDomainService } = require('./domains');

let store = null;
let current = null; // { cfg, graph, ingestor }
let tasks = [];
let initialTimer = null;
let domainsTimer = null;

const getStore = () => store || (store = createStore());

const notify = async (event, message) => require('../notificationService').notify(message, event);

function build() {
  const cfg = config.get();
  let graph = null;
  if (cfg.tenantId && cfg.clientId && cfg.clientSecret && cfg.mailbox) graph = createGraphClient({ ...cfg, logger: console });
  const cloudflare = cfg.cfToken ? createCloudflareClient({ token: cfg.cfToken, logger: console }) : null;
  current = {
    cfg, graph, cloudflare,
    ingestor: createIngestor({ store: getStore(), graph, config: cfg, notify, logger: console }),
    domains: createDomainService({ store: getStore(), cloudflare, config: cfg, notify, logger: console }),
  };
  return current;
}

const state = () => current || build();
const ingestor = () => state().ingestor;
const graph = () => state().graph;
const cloudflare = () => state().cloudflare;
const domains = () => state().domains;

/** Cron expression for "every N minutes" (up to 59), or every N/60 hours. */
function syncExpression(minutes) {
  if (minutes <= 59) return `*/${minutes} * * * *`;
  const h = Math.round(minutes / 60);
  return h >= 24 ? '0 0 * * *' : `0 */${h} * * *`;
}

/** Reminder before the Graph client secret expires: 30 days, 7 days, and when it has expired — each once. */
async function checkSecretExpiry(cfg = config.get(), now = Date.now()) {
  if (!cfg.secretExpires) return null;
  const days = Math.ceil((Date.parse(`${cfg.secretExpires}T23:59:59Z`) - now) / 86400_000);
  const step = [0, 7, 30].find((t) => days <= t);
  if (step === undefined) return null;
  const st = getStore();
  if (st.getState(`secret_alert:${cfg.secretExpires}:${step}`)) return null;
  for (const t of [0, 7, 30]) if (t >= step) st.setState(`secret_alert:${cfg.secretExpires}:${t}`, now);
  const when = days < 0 ? `expired ${-days} day${days === -1 ? '' : 's'} ago` : days === 0 ? 'expires today' : `expires in ${days} day${days === 1 ? '' : 's'}`;
  await notify('dmarc_secret_expiring', `DMARC: the Microsoft Graph client secret ${when} (${cfg.secretExpires}). Create a new one in Entra ID → App registrations → InfraLoom DMARC → Certificates & secrets and enter it in Settings → DMARC.`);
  return { days, step };
}

async function daily() {
  const cfg = config.get();
  try {
    const r = getStore().purge(cfg.retentionDays, cfg.rawXmlDays);
    if (r.reportsDeleted || r.rawCleared || r.messagesDeleted) console.log(`[dmarc] clean-up: ${JSON.stringify(r)}`);
  } catch (e) { console.error('[dmarc] clean-up failed:', e.message); }
  try { await checkSecretExpiry(cfg); } catch (e) { console.error('[dmarc] secret check failed:', e.message); }
}

function stopTasks() {
  tasks.forEach((t) => t.stop());
  tasks = [];
  if (initialTimer) { clearTimeout(initialTimer); initialTimer = null; }
  if (domainsTimer) { clearTimeout(domainsTimer); domainsTimer = null; }
}

function schedule() {
  stopTasks();
  const { cfg, graph: g, ingestor: ing, cloudflare: cf, domains: dom } = state();
  if (!cfg.enabled) return;
  if (g) {
    const run = () => ing.syncMailbox().catch(() => {});
    tasks.push(cron.schedule(syncExpression(cfg.pollMinutes), run));
    initialTimer = setTimeout(run, 30_000); // the first read shortly after the start
    initialTimer.unref?.();
  }
  tasks.push(cron.schedule('17 3 * * *', () => daily()));
  // the domains (Cloudflare zones, and the DMARC record of each): once a night, and a little after the start
  const refreshDomains = () => dom.refresh().catch(() => {});
  tasks.push(cron.schedule('40 3 * * *', refreshDomains));
  if (cf || getStore().listRegistry().length) { domainsTimer = setTimeout(refreshDomains, 45_000); domainsTimer.unref?.(); }
}

/** Called once from the server start. */
function initScheduler() {
  build();
  schedule();
}

/** Called after the settings changed. */
function reload() {
  build();
  schedule();
}

module.exports = { initScheduler, reload, ingestor, graph, cloudflare, domains, getStore, syncExpression, checkSecretExpiry, daily, state };
