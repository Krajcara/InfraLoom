-- Firewall logs received as syslog: an hourly summary of the traffic (the logs themselves are not kept), the security events that were
-- recognised (kept for a while, with the log line), and how much arrived. Nothing here is a copy of the firewall's own log.

CREATE TABLE IF NOT EXISTS syslog_config (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL DEFAULT ''
);

CREATE TABLE IF NOT EXISTS syslog_hourly (
  device     TEXT NOT NULL,
  hour       INTEGER NOT NULL,                 -- the start of the hour, epoch seconds
  sessions   INTEGER NOT NULL DEFAULT 0,
  blocked    INTEGER NOT NULL DEFAULT 0,
  bytes_out  REAL NOT NULL DEFAULT 0,          -- sent by the source of the session
  bytes_in   REAL NOT NULL DEFAULT 0,          -- received by the source of the session
  top        TEXT NOT NULL DEFAULT '{}',       -- JSON: for each dimension the biggest entries { key: [bytes, sessions, blocked] }
  PRIMARY KEY (device, hour)
);

CREATE TABLE IF NOT EXISTS syslog_events (
  id      INTEGER PRIMARY KEY AUTOINCREMENT,
  ts      INTEGER NOT NULL,
  device  TEXT NOT NULL,
  kind    TEXT NOT NULL,                       -- admin_login_failed, config_change, ips, ...
  level   TEXT NOT NULL,                       -- info | warning | critical
  summary TEXT NOT NULL,
  user    TEXT,
  srcip   TEXT,
  raw     TEXT
);
CREATE INDEX IF NOT EXISTS idx_syslog_events_ts ON syslog_events (ts);
CREATE INDEX IF NOT EXISTS idx_syslog_events_kind ON syslog_events (kind, ts);

CREATE TABLE IF NOT EXISTS syslog_stats (
  device    TEXT NOT NULL,
  hour      INTEGER NOT NULL,
  received  INTEGER NOT NULL DEFAULT 0,
  unparsed  INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (device, hour)
);
