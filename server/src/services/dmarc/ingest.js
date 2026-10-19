'use strict';

// Reading the mailbox through Graph, storing the reports, and the alert rules.

const { parseAttachment } = require('./parser');
const { reverseLookup, sourceGroup } = require('./sources');

// reason types where the receiver knowingly let the message through (forwarding, ARC, mailing list)
const BENIGN_OVERRIDES = new Set(['local_policy', 'forwarded', 'trusted_forwarder', 'mailing_list']);
const RECENT_SECONDS = 3 * 86400;   // a failure in a report older than this is history, not news (backfill, old uploads)
const MAX_ALERTS_PER_RUN = 10;
const FAIL_STREAK_ALERT = 3;        // consecutive failed reads of the mailbox before an alert

/**
 * @param {object} deps
 * @param {object} deps.store    from createStore()
 * @param {object|null} deps.graph  from createGraphClient(), or null when only manual import is possible
 * @param {object} deps.config   typed settings (config.get())
 * @param {(event: string, message: string) => Promise<void>} deps.notify
 * @param {(ip: string) => Promise<string|null>} [deps.reverse]  PTR lookup (replaceable in tests)
 */
function createIngestor({ store, graph, config, notify, logger = console, reverse = reverseLookup }) {
  let running = false;

  /** One buffer (an attachment or an upload) → stats and the alerts it raises. */
  async function ingestBuffer(buffer, filename, meta, opts = {}) {
    const result = { reports: 0, duplicates: 0, records: 0, alerts: [] };
    for (const p of parseAttachment(buffer, filename)) {
      const saved = store.saveReport(p.report, { ...meta, filename: p.filename, rawXml: p.rawXml, storeRaw: config.storeRawXml });
      if (saved.duplicate) { result.duplicates++; continue; }
      result.reports++;
      result.records += p.report.records.length;
      result.alerts.push(...(await evaluate(p.report, opts)));
    }
    return result;
  }

  /** Updates sources and groups for a new report and returns the alerts it calls for. */
  async function evaluate(report, { quiet = false } = {}) {
    const alerts = [];
    const nowSec = Math.floor(Date.now() / 1000);
    const seen = report.dateEnd || nowSec;
    const recent = nowSec - seen < RECENT_SECONDS;
    const domain = report.policy.domain;

    for (const r of report.records) {
      let src = store.getSource(r.sourceIp);
      let newGroup = false;
      if (!src) {
        const ptr = await reverse(r.sourceIp);
        const group = sourceGroup(r.sourceIp, ptr);
        newGroup = store.ensureGroup(group, seen, config.trustedGroups.includes(group.toLowerCase()));
        store.upsertSource(r.sourceIp, ptr, group, seen);
        src = store.getSource(r.sourceIp);
      } else {
        store.upsertSource(r.sourceIp, null, null, seen);
      }
      const approved = store.isApproved(r.sourceIp);
      const label = `${r.sourceIp}${src?.ptr ? ` (${src.ptr})` : ''}`;

      if (!r.dmarcPass && !approved) {
        if (BENIGN_OVERRIDES.has(r.override)) {
          if (config.alertOnOverrides && recent && !quiet) {
            alerts.push({ event: 'dmarc_override', key: `override:${r.sourceIp}`, throttleHours: 24,
              title: `DMARC failure let through (${r.override}) — ${domain}`,
              message: `${r.count} messages from ${label}, reported by ${report.orgName}. Probably forwarding or a mailing list.` });
          }
        } else if (recent) {
          alerts.push({ event: 'dmarc_fail', key: `fail:${r.sourceIp}`, throttleHours: 24,
            title: `DMARC failures from an unapproved sender — ${domain}`,
            message: `${r.count} messages from ${label}, header_from=${r.headerFrom}, DKIM=${r.dkimEval}, SPF=${r.spfEval}, disposition=${r.disposition}. Reported by ${report.orgName}.` });
        }
      } else if (newGroup && !approved && !quiet && config.alertOnNewSources) {
        alerts.push({ event: 'dmarc_new_sender', key: `new:${src.provider}`, throttleHours: 0,
          title: `New sender in the name of ${domain}: ${src.provider}`,
          message: `First seen ${label}, ${r.count} messages, DMARC ${r.dmarcPass ? 'pass' : 'fail'}. Approve it on the DMARC page if it is expected.` });
      }

      if (r.spfPermerror && recent) {
        alerts.push({ event: 'dmarc_spf_permerror', key: `permerror:${domain}`, throttleHours: 24,
          title: `SPF permerror for ${domain}`,
          message: `Receivers report an SPF permerror (e.g. ${label}). Usually more than 10 DNS lookups, or more than one v=spf1 record. Check: dig +short TXT ${domain}` });
      }
    }
    return alerts;
  }

  const text = (a) => `DMARC: ${a.title}. ${a.message}`;

  /** Sends the alerts: one per key per run, and a key that was sent in the last throttleHours is not sent again. */
  async function dispatch(alerts) {
    const now = Date.now();
    const unique = [...new Map(alerts.map((a) => [a.key, a])).values()].filter((a) => {
      if (!a.throttleHours) return true;
      const last = Number(store.getState(`alert:${a.key}`) || 0);
      return !last || now - last >= a.throttleHours * 3600_000;
    });
    for (const a of unique.slice(0, MAX_ALERTS_PER_RUN)) {
      try {
        if (a.throttleHours) store.setState(`alert:${a.key}`, now);
        await notify(a.event, text(a));
      } catch (e) {
        logger.error?.('[dmarc] notify failed:', e.message);
      }
    }
    if (unique.length > MAX_ALERTS_PER_RUN) {
      await notify('dmarc_fail', `DMARC: ${unique.length - MAX_ALERTS_PER_RUN} more alerts were not sent one by one — see the DMARC page.`).catch(() => {});
    }
    return unique.length;
  }

  /** One pass over the mailbox. */
  async function syncMailbox() {
    if (!graph) throw new Error('Microsoft Graph is not set up (tenant ID, client ID, client secret and mailbox)');
    if (running) return { skipped: true, reason: 'a read is already running' };
    running = true;
    const started = Date.now();
    const stats = { messages: 0, reports: 0, duplicates: 0, records: 0, errors: 0 };
    const alerts = [];

    try {
      const cursor = store.getState('graph_cursor');
      // overlap of two hours because the mailbox index can lag; duplicates are caught by dmarc_messages
      const since = cursor ? new Date(new Date(cursor).getTime() - 2 * 3600_000) : new Date(Date.now() - config.initialLookbackDays * 86400_000);

      const messages = await graph.listMessagesSince(since.toISOString());
      // the first read is a backfill of history: no "new sender" alerts, so it does not flood the notifications
      const quiet = !cursor;
      let newest = cursor;

      for (const m of messages) {
        if (!newest || m.receivedDateTime > newest) newest = m.receivedDateTime;
        if (store.isMessageProcessed(m.id)) continue;
        stats.messages++;

        const base = { graph_id: m.id, received_at: m.receivedDateTime, subject: m.subject?.slice(0, 300) ?? null, from_addr: m.from?.emailAddress?.address ?? null };
        try {
          if (!m.hasAttachments) { store.logMessage({ ...base, status: 'no-report' }); continue; }
          let found = 0;
          for (const f of await graph.getAttachments(m.id)) {
            const r = await ingestBuffer(f.buffer, f.name, { origin: 'graph', messageId: m.id }, { quiet });
            found += r.reports + r.duplicates;
            stats.reports += r.reports; stats.duplicates += r.duplicates; stats.records += r.records;
            alerts.push(...r.alerts);
          }
          store.logMessage({ ...base, status: found ? 'ok' : 'no-report' });
        } catch (e) {
          stats.errors++;
          logger.error?.(`[dmarc] message "${m.subject}" — ${e.message}`);
          store.logMessage({ ...base, status: 'error', error: e.message.slice(0, 500) });
        }
      }

      if (newest) store.setState('graph_cursor', newest);
      store.setState('last_sync', new Date().toISOString());
      store.setState('last_sync_result', JSON.stringify({ ...stats, ms: Date.now() - started }));
      store.setState('last_sync_error', '');
      store.setState('sync_fail_streak', 0);

      await dispatch(alerts);
      logger.info?.(`[dmarc] read: ${stats.messages} messages, ${stats.reports} new reports, ${stats.errors} errors`);
      return stats;
    } catch (e) {
      store.setState('last_sync', new Date().toISOString());
      store.setState('last_sync_error', e.message);
      const streak = Number(store.getState('sync_fail_streak') || 0) + 1;
      store.setState('sync_fail_streak', streak);
      if (streak === FAIL_STREAK_ALERT) {
        await notify('dmarc_sync_failed', `DMARC: reading the mailbox ${graph.mailbox} has failed ${streak} times in a row (${e.message}). Check Settings → DMARC, and whether the client secret has expired.`).catch(() => {});
      }
      logger.error?.('[dmarc] read failed:', e.message);
      throw e;
    } finally {
      running = false;
    }
  }

  return { syncMailbox, ingestBuffer, dispatch, isRunning: () => running };
}

module.exports = { createIngestor, BENIGN_OVERRIDES, FAIL_STREAK_ALERT, MAX_ALERTS_PER_RUN };
