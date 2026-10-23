-- Traffic history: the interfaces that are watched, a sample of their rate every poll, an hourly summary kept longer, and the alert state.
-- Counters of the devices are read, the rate is worked out from the difference of two readings.

CREATE TABLE IF NOT EXISTS traffic_config (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL DEFAULT ''
);

CREATE TABLE IF NOT EXISTS traffic_interfaces (
  id               INTEGER PRIMARY KEY AUTOINCREMENT,
  device_table     TEXT NOT NULL,                 -- routers | switches | access_points
  device_id        INTEGER NOT NULL,
  if_name          TEXT NOT NULL,                 -- the name on the FortiGate, or the SNMP ifName
  label            TEXT,
  speed_mbps       INTEGER,                       -- the link speed; NULL = not known (no percentage then)
  speed_override   INTEGER NOT NULL DEFAULT 0,    -- 1 = set by hand, the device's answer does not replace it
  enabled          INTEGER NOT NULL DEFAULT 1,
  warn_pct         INTEGER,                       -- NULL = the default
  crit_pct         INTEGER,
  sustain_minutes  INTEGER,
  counter_bits     INTEGER,                       -- 32 or 64
  last_in          TEXT,                          -- the last counter readings (text: 64-bit values do not fit a REAL)
  last_out         TEXT,
  last_ts          INTEGER,
  oper_status      TEXT,                          -- up | down | unknown
  in_bps           REAL,                          -- the latest rate
  out_bps          REAL,
  state            TEXT NOT NULL DEFAULT 'ok',    -- ok | warning | critical
  above_warn_since INTEGER,
  above_crit_since INTEGER,
  below_since      INTEGER,
  last_error       TEXT,
  created_at       TEXT DEFAULT (datetime('now')),
  UNIQUE (device_table, device_id, if_name)
);

CREATE TABLE IF NOT EXISTS traffic_samples (
  interface_id INTEGER NOT NULL REFERENCES traffic_interfaces(id) ON DELETE CASCADE,
  ts           INTEGER NOT NULL,
  dt           INTEGER NOT NULL,                  -- seconds since the reading before
  in_bps       REAL NOT NULL,
  out_bps      REAL NOT NULL,
  PRIMARY KEY (interface_id, ts)
);

CREATE TABLE IF NOT EXISTS traffic_hourly (
  interface_id INTEGER NOT NULL REFERENCES traffic_interfaces(id) ON DELETE CASCADE,
  hour         INTEGER NOT NULL,                  -- the start of the hour, epoch seconds
  samples      INTEGER NOT NULL,
  avg_in REAL, avg_out REAL, max_in REAL, max_out REAL, p95_in REAL, p95_out REAL,
  bytes_in REAL, bytes_out REAL,
  PRIMARY KEY (interface_id, hour)
);
