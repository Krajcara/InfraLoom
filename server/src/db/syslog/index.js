'use strict';

const fs = require('fs');
const path = require('path');

/** Applies every NNN_name.sql file in this folder that has not been applied yet, each inside its own transaction
 * (same scheme as the cabling module). */
function migrate(db) {
  db.exec(`CREATE TABLE IF NOT EXISTS syslog_migrations (
    version    TEXT PRIMARY KEY,
    applied_at TEXT NOT NULL DEFAULT (datetime('now'))
  )`);
  const applied = new Set(db.prepare('SELECT version FROM syslog_migrations').all().map((r) => r.version));
  const done = [];
  for (const file of fs.readdirSync(__dirname).filter((f) => /^\d+_.+\.sql$/.test(f)).sort()) {
    const version = file.replace(/\.sql$/, '');
    if (applied.has(version)) continue;
    db.transaction(() => {
      db.exec(fs.readFileSync(path.join(__dirname, file), 'utf8'));
      db.prepare('INSERT INTO syslog_migrations (version) VALUES (?)').run(version);
    })();
    done.push(version);
  }
  return done;
}

module.exports = { migrate };
