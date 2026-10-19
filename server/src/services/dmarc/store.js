'use strict';

// DMARC module: the queries (better-sqlite3, synchronous). The tables come from db/dmarc/001_dmarc.sql.

const UNKNOWN = 'unknown';

function createStore(db = require('../../db/database')) {
  const q = {
    getState: db.prepare('SELECT value FROM dmarc_state WHERE key = ?'),
    setState: db.prepare('INSERT INTO dmarc_state (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value'),
    delState: db.prepare('DELETE FROM dmarc_state WHERE key = ?'),
    messageSeen: db.prepare('SELECT 1 FROM dmarc_messages WHERE graph_id = ?'),
    insertMessage: db.prepare(`
      INSERT OR REPLACE INTO dmarc_messages (graph_id, received_at, subject, from_addr, status, error)
      VALUES (@graph_id, @received_at, @subject, @from_addr, @status, @error)`),
    reportExists: db.prepare('SELECT id FROM dmarc_reports WHERE org_name = ? AND report_id = ?'),
    insertReport: db.prepare(`
      INSERT INTO dmarc_reports (org_name, org_email, report_id, domain, date_begin, date_end,
        policy_p, policy_sp, policy_np, policy_pct, policy_adkim, policy_aspf,
        total_count, pass_count, fail_count, origin, message_id, filename, raw_xml)
      VALUES (@org_name, @org_email, @report_id, @domain, @date_begin, @date_end,
        @policy_p, @policy_sp, @policy_np, @policy_pct, @policy_adkim, @policy_aspf,
        @total_count, @pass_count, @fail_count, @origin, @message_id, @filename, @raw_xml)`),
    insertRecord: db.prepare(`
      INSERT INTO dmarc_records (report_id, source_ip, count, disposition, dkim_eval, spf_eval,
        dmarc_pass, override, header_from, envelope_from, envelope_to,
        dkim_results, spf_results, reasons, spf_permerror)
      VALUES (@report_id, @source_ip, @count, @disposition, @dkim_eval, @spf_eval,
        @dmarc_pass, @override, @header_from, @envelope_from, @envelope_to,
        @dkim_results, @spf_results, @reasons, @spf_permerror)`),
    getSource: db.prepare('SELECT * FROM dmarc_sources WHERE ip = ?'),
    insertSource: db.prepare('INSERT INTO dmarc_sources (ip, ptr, provider, first_seen, last_seen) VALUES (@ip, @ptr, @provider, @seen, @seen)'),
    touchSource: db.prepare('UPDATE dmarc_sources SET last_seen = MAX(COALESCE(last_seen,0), ?) WHERE ip = ?'),
    updateSourceMeta: db.prepare('UPDATE dmarc_sources SET approved = COALESCE(@approved, approved), note = COALESCE(@note, note) WHERE ip = @ip'),
    getGroup: db.prepare('SELECT * FROM dmarc_groups WHERE name = ?'),
    insertGroup: db.prepare('INSERT OR IGNORE INTO dmarc_groups (name, approved, first_seen) VALUES (?, ?, ?)'),
    updateGroup: db.prepare('UPDATE dmarc_groups SET approved = COALESCE(@approved, approved), note = COALESCE(@note, note) WHERE name = @name'),
    purgeOld: db.prepare('DELETE FROM dmarc_reports WHERE date_end < ?'),
    purgeRaw: db.prepare('UPDATE dmarc_reports SET raw_xml = NULL WHERE date_end < ? AND raw_xml IS NOT NULL'),
    purgeMessages: db.prepare('DELETE FROM dmarc_messages WHERE processed_at < ?'),
  };

  const flag = (v) => (v === undefined ? null : v ? 1 : 0);

  return {
    db,

    getState: (key) => q.getState.get(key)?.value ?? null,
    setState: (key, value) => q.setState.run(key, String(value)),
    delState: (key) => q.delState.run(key),

    isMessageProcessed: (graphId) => !!q.messageSeen.get(graphId),
    logMessage: (m) => q.insertMessage.run({ error: null, subject: null, from_addr: null, received_at: null, ...m }),

    // Writes a whole report in one transaction. Returns { inserted, duplicate, reportDbId }.
    saveReport: db.transaction((report, meta) => {
      const existing = q.reportExists.get(report.orgName, report.reportId);
      if (existing) return { inserted: false, duplicate: true, reportDbId: existing.id };

      const total = report.records.reduce((s, r) => s + r.count, 0);
      const pass = report.records.filter((r) => r.dmarcPass).reduce((s, r) => s + r.count, 0);

      const info = q.insertReport.run({
        org_name: report.orgName, org_email: report.orgEmail, report_id: report.reportId, domain: report.policy.domain,
        date_begin: report.dateBegin, date_end: report.dateEnd,
        policy_p: report.policy.p, policy_sp: report.policy.sp, policy_np: report.policy.np, policy_pct: report.policy.pct, policy_adkim: report.policy.adkim, policy_aspf: report.policy.aspf,
        total_count: total, pass_count: pass, fail_count: total - pass,
        origin: meta.origin, message_id: meta.messageId ?? null, filename: meta.filename ?? null, raw_xml: meta.storeRaw ? meta.rawXml : null,
      });
      const reportDbId = info.lastInsertRowid;

      for (const r of report.records) {
        q.insertRecord.run({
          report_id: reportDbId, source_ip: r.sourceIp, count: r.count, disposition: r.disposition, dkim_eval: r.dkimEval, spf_eval: r.spfEval,
          dmarc_pass: r.dmarcPass ? 1 : 0, override: r.override, header_from: r.headerFrom, envelope_from: r.envelopeFrom, envelope_to: r.envelopeTo,
          dkim_results: JSON.stringify(r.dkim), spf_results: JSON.stringify(r.spf), reasons: JSON.stringify(r.reasons), spf_permerror: r.spfPermerror ? 1 : 0,
        });
      }
      return { inserted: true, duplicate: false, reportDbId };
    }),

    getSource: (ip) => q.getSource.get(ip),
    // true if the source is new
    upsertSource: (ip, ptr, provider, seen) => {
      if (q.getSource.get(ip)) { q.touchSource.run(seen, ip); return false; }
      q.insertSource.run({ ip, ptr, provider, seen });
      return true;
    },
    updateSource: (ip, { approved, note }) => q.updateSourceMeta.run({ ip, approved: flag(approved), note: note === undefined ? null : note }),

    getGroup: (name) => q.getGroup.get(name),
    // true if the group is new
    ensureGroup: (name, seen, preApproved = false) => q.insertGroup.run(name, preApproved ? 1 : 0, seen).changes > 0,
    updateGroup: (name, { approved, note }) => q.updateGroup.run({ name, approved: flag(approved), note: note === undefined ? null : note }),
    isApproved: (ip) => !!db.prepare(`
      SELECT 1 FROM dmarc_sources s LEFT JOIN dmarc_groups g ON g.name = s.provider
      WHERE s.ip = ? AND (s.approved = 1 OR g.approved = 1)`).get(ip),

    purge: (retentionDays, rawDays) => {
      const now = Math.floor(Date.now() / 1000);
      const reportsDeleted = q.purgeOld.run(now - retentionDays * 86400).changes;
      const rawCleared = rawDays > 0 ? q.purgeRaw.run(now - rawDays * 86400).changes : 0;
      const messagesDeleted = q.purgeMessages.run(now - retentionDays * 86400).changes;
      return { reportsDeleted, rawCleared, messagesDeleted };
    },

    // ---------- queries for the screens ----------

    summary: (sinceTs, domain) => {
      const dom = domain ? 'AND rp.domain = @domain' : '';
      const p = { since: sinceTs, domain };

      const totals = db.prepare(`
        SELECT COALESCE(SUM(r.count),0) AS total,
               COALESCE(SUM(CASE WHEN r.dmarc_pass=1 THEN r.count END),0) AS pass,
               COALESCE(SUM(CASE WHEN r.dmarc_pass=0 THEN r.count END),0) AS fail,
               COALESCE(SUM(CASE WHEN r.spf_permerror=1 THEN r.count END),0) AS spf_permerror,
               COUNT(DISTINCT rp.id) AS reports,
               COUNT(DISTINCT rp.org_name) AS reporters
        FROM dmarc_records r JOIN dmarc_reports rp ON rp.id = r.report_id
        WHERE rp.date_end >= @since ${dom}`).get(p);

      const daily = db.prepare(`
        SELECT date(rp.date_begin, 'unixepoch') AS day,
               SUM(CASE WHEN r.dmarc_pass=1 THEN r.count ELSE 0 END) AS pass,
               SUM(CASE WHEN r.dmarc_pass=0 THEN r.count ELSE 0 END) AS fail
        FROM dmarc_records r JOIN dmarc_reports rp ON rp.id = r.report_id
        WHERE rp.date_end >= @since ${dom}
        GROUP BY day ORDER BY day`).all(p);

      const sources = db.prepare(`
        SELECT r.source_ip AS ip, s.ptr, s.provider, s.approved AS ip_approved,
               COALESCE(g.approved, 0) AS group_approved,
               CASE WHEN s.approved = 1 OR g.approved = 1 THEN 1 ELSE 0 END AS approved,
               s.note, s.first_seen,
               SUM(r.count) AS total,
               SUM(CASE WHEN r.dmarc_pass=1 THEN r.count ELSE 0 END) AS pass,
               SUM(CASE WHEN r.dmarc_pass=0 THEN r.count ELSE 0 END) AS fail,
               SUM(CASE WHEN r.dkim_eval='pass' THEN r.count ELSE 0 END) AS dkim_pass,
               SUM(CASE WHEN r.spf_eval='pass' THEN r.count ELSE 0 END) AS spf_pass,
               SUM(CASE WHEN r.spf_permerror=1 THEN r.count ELSE 0 END) AS spf_permerror,
               MAX(rp.date_end) AS last_seen,
               GROUP_CONCAT(DISTINCT rp.org_name) AS reporters
        FROM dmarc_records r
        JOIN dmarc_reports rp ON rp.id = r.report_id
        LEFT JOIN dmarc_sources s ON s.ip = r.source_ip
        LEFT JOIN dmarc_groups g ON g.name = s.provider
        WHERE rp.date_end >= @since ${dom}
        GROUP BY r.source_ip
        ORDER BY fail DESC, total DESC`).all(p);

      const reporters = db.prepare(`
        SELECT rp.org_name, COUNT(*) AS reports, SUM(rp.total_count) AS total, SUM(rp.fail_count) AS fail
        FROM dmarc_reports rp WHERE rp.date_end >= @since ${dom}
        GROUP BY rp.org_name ORDER BY total DESC`).all(p);

      const domains = db.prepare('SELECT DISTINCT domain FROM dmarc_reports ORDER BY domain').all().map((d) => d.domain);

      const latestPolicy = db.prepare(`
        SELECT domain, policy_p, policy_sp, policy_np, policy_pct, policy_adkim, policy_aspf, date_end
        FROM dmarc_reports ${domain ? 'WHERE domain = @domain' : ''}
        ORDER BY date_end DESC LIMIT 1`).get(p) ?? null;

      const groups = db.prepare(`
        SELECT COALESCE(s.provider, '${UNKNOWN}') AS name, COALESCE(g.approved, 0) AS approved, g.note,
               COUNT(DISTINCT r.source_ip) AS ips,
               SUM(r.count) AS total,
               SUM(CASE WHEN r.dmarc_pass=1 THEN r.count ELSE 0 END) AS pass,
               SUM(CASE WHEN r.dmarc_pass=0 THEN r.count ELSE 0 END) AS fail,
               SUM(CASE WHEN r.spf_permerror=1 THEN r.count ELSE 0 END) AS spf_permerror
        FROM dmarc_records r
        JOIN dmarc_reports rp ON rp.id = r.report_id
        LEFT JOIN dmarc_sources s ON s.ip = r.source_ip
        LEFT JOIN dmarc_groups g ON g.name = s.provider
        WHERE rp.date_end >= @since ${dom}
        GROUP BY COALESCE(s.provider, '${UNKNOWN}')
        ORDER BY fail DESC, total DESC`).all(p);

      return { totals, daily, groups, sources, reporters, domains, latestPolicy };
    },

    // the numbers on the dashboard card
    dashboard: (sinceTs) => {
      const t = db.prepare(`
        SELECT COALESCE(SUM(r.count),0) AS total,
               COALESCE(SUM(CASE WHEN r.dmarc_pass=1 THEN r.count END),0) AS pass,
               COALESCE(SUM(CASE WHEN r.dmarc_pass=0 THEN r.count END),0) AS fail,
               COUNT(DISTINCT rp.id) AS reports, MAX(rp.date_end) AS last_report
        FROM dmarc_records r JOIN dmarc_reports rp ON rp.id = r.report_id WHERE rp.date_end >= ?`).get(sinceTs);
      const groups = db.prepare(`
        SELECT COALESCE(s.provider, '${UNKNOWN}') AS name,
               SUM(CASE WHEN r.dmarc_pass=0 THEN r.count ELSE 0 END) AS fail
        FROM dmarc_records r JOIN dmarc_reports rp ON rp.id = r.report_id
        LEFT JOIN dmarc_sources s ON s.ip = r.source_ip LEFT JOIN dmarc_groups g ON g.name = s.provider
        WHERE rp.date_end >= ? AND COALESCE(g.approved, 0) = 0 AND COALESCE(s.approved, 0) = 0
        GROUP BY COALESCE(s.provider, '${UNKNOWN}')`).all(sinceTs);
      return { ...t, unapproved: groups.length, unapproved_failing: groups.filter((g) => g.fail > 0).length };
    },

    listReports: ({ sinceTs, limit = 100, offset = 0, domain }) => db.prepare(`
      SELECT id, org_name, org_email, report_id, domain, date_begin, date_end, policy_p, total_count, pass_count, fail_count, origin, created_at
      FROM dmarc_reports
      WHERE date_end >= @since ${domain ? 'AND domain = @domain' : ''}
      ORDER BY date_end DESC, id DESC LIMIT @limit OFFSET @offset`).all({ since: sinceTs, limit, offset, domain }),

    getReport: (id) => {
      const report = db.prepare('SELECT * FROM dmarc_reports WHERE id = ?').get(id);
      if (!report) return null;
      const records = db.prepare(`
        SELECT r.*, s.ptr, s.provider, CASE WHEN s.approved = 1 OR g.approved = 1 THEN 1 ELSE 0 END AS approved
        FROM dmarc_records r
        LEFT JOIN dmarc_sources s ON s.ip = r.source_ip
        LEFT JOIN dmarc_groups g ON g.name = s.provider
        WHERE r.report_id = ? ORDER BY r.dmarc_pass ASC, r.count DESC`).all(id)
        .map((r) => ({ ...r, dkim_results: JSON.parse(r.dkim_results || '[]'), spf_results: JSON.parse(r.spf_results || '[]'), reasons: JSON.parse(r.reasons || '[]') }));
      return { ...report, records };
    },

    recentMessages: (limit = 50) => db.prepare('SELECT * FROM dmarc_messages ORDER BY processed_at DESC, rowid DESC LIMIT ?').all(limit),
  };
}

module.exports = { createStore, UNKNOWN };
