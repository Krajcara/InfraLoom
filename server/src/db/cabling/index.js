'use strict';

const fs = require('fs');
const path = require('path');

/** Applies every NNN_name.sql file in this folder that has not been applied yet, each inside its own transaction.
 * The cabling module keeps numbered migrations (it has triggers and constraints that ALTER TABLE cannot change);
 * the rest of InfraLoom keeps its idempotent CREATE IF NOT EXISTS style in database.js. */
function migrate(db) {
  db.exec(`CREATE TABLE IF NOT EXISTS cab_migrations (
    version    TEXT PRIMARY KEY,
    applied_at TEXT NOT NULL DEFAULT (datetime('now'))
  )`);
  const applied = new Set(db.prepare('SELECT version FROM cab_migrations').all().map((r) => r.version));
  const done = [];
  for (const file of fs.readdirSync(__dirname).filter((f) => /^\d+_.+\.sql$/.test(f)).sort()) {
    const version = file.replace(/\.sql$/, '');
    if (applied.has(version)) continue;
    db.transaction(() => {
      db.exec(fs.readFileSync(path.join(__dirname, file), 'utf8'));
      db.prepare('INSERT INTO cab_migrations (version) VALUES (?)').run(version);
    })();
    done.push(version);
  }
  return done;
}

module.exports = { migrate };
