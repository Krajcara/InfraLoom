-- DMARC module: aggregate reports (RFC 7489) read from a dedicated mailbox, who sends mail in the name of your domains.
-- The module's own settings live in dmarc_config (not in the general settings table), so that the Graph client secret
-- is never returned by the generic settings API.

CREATE TABLE IF NOT EXISTS dmarc_config (
  key         TEXT PRIMARY KEY,
  value       TEXT NOT NULL DEFAULT '',
  updated_at  TEXT DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS dmarc_reports (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  org_name      TEXT NOT NULL,
  org_email     TEXT,
  report_id     TEXT NOT NULL,
  domain        TEXT,
  date_begin    INTEGER,
  date_end      INTEGER,
  policy_p      TEXT,
  policy_sp     TEXT,
  policy_np     TEXT,
  policy_pct    INTEGER,
  policy_adkim  TEXT,
  policy_aspf   TEXT,
  total_count   INTEGER DEFAULT 0,
  pass_count    INTEGER DEFAULT 0,
  fail_count    INTEGER DEFAULT 0,
  origin        TEXT,             -- 'graph' | 'upload'
  message_id    TEXT,             -- Graph id of the message the report came in
  filename      TEXT,
  raw_xml       TEXT,
  created_at    INTEGER DEFAULT (strftime('%s','now')),
  UNIQUE (org_name, report_id)
);

CREATE TABLE IF NOT EXISTS dmarc_records (
  id             INTEGER PRIMARY KEY AUTOINCREMENT,
  report_id      INTEGER NOT NULL REFERENCES dmarc_reports(id) ON DELETE CASCADE,
  source_ip      TEXT NOT NULL,
  count          INTEGER NOT NULL,
  disposition    TEXT,
  dkim_eval      TEXT,            -- policy_evaluated/dkim (aligned result)
  spf_eval       TEXT,            -- policy_evaluated/spf  (aligned result)
  dmarc_pass     INTEGER NOT NULL,
  override       TEXT,            -- reason/type, e.g. local_policy, forwarded
  header_from    TEXT,
  envelope_from  TEXT,
  envelope_to    TEXT,
  dkim_results   TEXT,            -- JSON
  spf_results    TEXT,            -- JSON
  reasons        TEXT,            -- JSON
  spf_permerror  INTEGER DEFAULT 0
);
CREATE INDEX IF NOT EXISTS idx_dmarc_records_report ON dmarc_records(report_id);
CREATE INDEX IF NOT EXISTS idx_dmarc_records_ip     ON dmarc_records(source_ip);
CREATE INDEX IF NOT EXISTS idx_dmarc_reports_end    ON dmarc_reports(date_end);

CREATE TABLE IF NOT EXISTS dmarc_sources (
  ip          TEXT PRIMARY KEY,
  ptr         TEXT,
  provider    TEXT,             -- name of the group (see dmarc_groups)
  first_seen  INTEGER,
  last_seen   INTEGER,
  approved    INTEGER DEFAULT 0,
  note        TEXT
);

-- a group is the provider found from the PTR record (e.g. "Microsoft 365"), or the network prefix when there is no PTR
CREATE TABLE IF NOT EXISTS dmarc_groups (
  name        TEXT PRIMARY KEY,
  approved    INTEGER DEFAULT 0,
  first_seen  INTEGER,
  note        TEXT
);

CREATE TABLE IF NOT EXISTS dmarc_messages (
  graph_id      TEXT PRIMARY KEY,
  received_at   TEXT,
  subject       TEXT,
  from_addr     TEXT,
  status        TEXT,             -- 'ok' | 'no-report' | 'error'
  error         TEXT,
  processed_at  INTEGER DEFAULT (strftime('%s','now'))
);
CREATE INDEX IF NOT EXISTS idx_dmarc_messages_processed ON dmarc_messages(processed_at);

CREATE TABLE IF NOT EXISTS dmarc_state (
  key   TEXT PRIMARY KEY,
  value TEXT
);
