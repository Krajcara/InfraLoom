'use strict';

const path = require('path');
const fs = require('fs');
const Database = require('better-sqlite3-multiple-ciphers');

// Anchored to the project root (not process.cwd()) so the resolved path is
// identical whether the process is started via `npm run` from a workspace,
// directly with `node server/src/index.js`, or via systemd with a different
// WorkingDirectory. A relative DB_PATH in .env is always relative to the
// project root, matching the comment in .env.example.
const PROJECT_ROOT = path.join(__dirname, '../../..');
const DB_PATH = process.env.DB_PATH
  ? path.resolve(PROJECT_ROOT, process.env.DB_PATH)
  : path.join(PROJECT_ROOT, 'data/infraloom.db');
const DB_ENCRYPTION_KEY = process.env.DB_ENCRYPTION_KEY;

if (!DB_ENCRYPTION_KEY) {
  console.error('[db] FATAL: DB_ENCRYPTION_KEY is not set in .env — refusing to start.');
  console.error('[db] Generate one with: openssl rand -hex 32');
  process.exit(1);
}

// Ensure the data directory exists before SQLite tries to create the file.
fs.mkdirSync(path.dirname(DB_PATH), { recursive: true });

const db = new Database(DB_PATH);

// ── SQLCipher encryption ────────────────────────────────────────────────
// better-sqlite3-multiple-ciphers defaults to the sqlcipher cipher scheme,
// which is what we want. The key PRAGMA must be the very first statement
// run against the connection, before any table access.
db.pragma(`key='${DB_ENCRYPTION_KEY}'`);

// Sanity check: if the key is wrong (or the file isn't encrypted with it),
// this simple query will throw immediately rather than silently failing later.
try {
  db.prepare('SELECT count(*) FROM sqlite_master').get();
} catch (err) {
  console.error('[db] FATAL: could not open the encrypted database — wrong DB_ENCRYPTION_KEY?');
  console.error(err.message);
  process.exit(1);
}

db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');

// Additive, non-destructive column helper — used when a later phase needs to
// extend a table that already shipped. Never used for DROP/ALTER-modify.
function ensureColumn(table, column, definition) {
  const cols = db.prepare(`PRAGMA table_info(${table})`).all();
  if (!cols.some((c) => c.name === column)) {
    db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
  }
}

// ── Phase 0 — base schema ───────────────────────────────────────────────
db.exec(`
  CREATE TABLE IF NOT EXISTS users (
    id            INTEGER PRIMARY KEY AUTOINCREMENT,
    username      TEXT NOT NULL UNIQUE,
    password_hash TEXT NOT NULL,
    role          TEXT NOT NULL DEFAULT 'viewer'
                    CHECK (role IN ('superadmin','admin','operator','viewer')),
    totp_secret   TEXT,
    totp_enabled  INTEGER NOT NULL DEFAULT 0,
    is_active     INTEGER NOT NULL DEFAULT 1,
    created_at    TEXT DEFAULT (datetime('now')),
    updated_at    TEXT DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS settings (
    key        TEXT PRIMARY KEY,
    value      TEXT,
    updated_at TEXT DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS audit_log (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id     INTEGER,
    username    TEXT,
    action      TEXT NOT NULL,
    entity_type TEXT,
    entity_id   TEXT,
    module      TEXT,
    details     TEXT,
    ip_address  TEXT,
    created_at  TEXT DEFAULT (datetime('now')),
    FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE SET NULL
  );

  CREATE INDEX IF NOT EXISTS idx_audit_created ON audit_log(created_at);
  CREATE INDEX IF NOT EXISTS idx_audit_module  ON audit_log(module);
  CREATE INDEX IF NOT EXISTS idx_audit_user     ON audit_log(user_id);
`);

// ── Phase 1 — Auth & Users ──────────────────────────────────────────────
ensureColumn('users', 'failed_attempts', "INTEGER NOT NULL DEFAULT 0");
ensureColumn('users', 'locked_until', "TEXT");
ensureColumn('users', 'full_name', "TEXT");
ensureColumn('users', 'email', "TEXT");

db.exec(`
  CREATE TABLE IF NOT EXISTS sessions (
    id           TEXT PRIMARY KEY,
    user_id      INTEGER NOT NULL,
    ip_address   TEXT,
    user_agent   TEXT,
    created_at   TEXT DEFAULT (datetime('now')),
    last_seen_at TEXT DEFAULT (datetime('now')),
    expires_at   TEXT NOT NULL,
    revoked_at   TEXT,
    FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
  );

  CREATE TABLE IF NOT EXISTS api_keys (
    id           INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id      INTEGER NOT NULL,
    name         TEXT NOT NULL,
    key_prefix   TEXT NOT NULL,
    key_hash     TEXT NOT NULL,
    created_at   TEXT DEFAULT (datetime('now')),
    last_used_at TEXT,
    revoked_at   TEXT,
    FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
  );

  CREATE INDEX IF NOT EXISTS idx_sessions_user ON sessions(user_id);
  CREATE INDEX IF NOT EXISTS idx_api_keys_user  ON api_keys(user_id);
`);

// Seed default settings only if they don't already exist.
const defaultSettings = {
  app_name: 'InfraLoom',
};
const insertSetting = db.prepare(
  'INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO NOTHING'
);
for (const [key, value] of Object.entries(defaultSettings)) {
  insertSetting.run(key, value);
}

module.exports = db;
