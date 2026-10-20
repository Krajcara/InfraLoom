-- The domains the DMARC page knows about: those read from Cloudflare (zones) and those added by hand, with what the
-- _dmarc TXT record of each says. A domain that only shows up in reports needs no row here.

CREATE TABLE IF NOT EXISTS dmarc_domains (
  name          TEXT PRIMARY KEY,
  source        TEXT NOT NULL,                 -- 'cloudflare' | 'manual'
  zone_id       TEXT,
  ignored       INTEGER NOT NULL DEFAULT 0,    -- muted: no alerts, shown dimmed
  record_raw    TEXT,                          -- the TXT record(s) found at _dmarc.<domain>
  record_count  INTEGER,
  p             TEXT,
  sp            TEXT,
  pct           INTEGER,
  adkim         TEXT,
  aspf          TEXT,
  rua           TEXT,                          -- comma-separated report addresses
  health        TEXT,                          -- protected | partial | monitor | no_record | multiple | invalid | unchecked
  record_error  TEXT,
  checked_at    INTEGER,
  added_at      INTEGER DEFAULT (strftime('%s','now'))
);
