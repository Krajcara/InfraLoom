'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const archiver = require('archiver');
const db = require('../db/database');

const PROJECT_ROOT = path.resolve(__dirname, '..', '..', '..');
const ENV_PATH = path.join(PROJECT_ROOT, '.env');
const BACKUP_DIR = path.join(PROJECT_ROOT, 'backups');
const DB_PATH = process.env.DB_PATH ? path.resolve(PROJECT_ROOT, process.env.DB_PATH) : path.join(PROJECT_ROOT, 'data', 'infraloom.db');

fs.mkdirSync(BACKUP_DIR, { recursive: true });

function getSetting(key, fallback) {
  return db.prepare('SELECT value FROM settings WHERE key = ?').get(key)?.value ?? fallback;
}

/** BACKUP_ENCRYPTION_PASSWORD protects the .env copy bundled into each
 * backup (the DB inside is already SQLCipher-encrypted with
 * DB_ENCRYPTION_KEY — this password protects THAT key when it travels
 * inside a backup ZIP). It must live outside the database it protects, so
 * it's an env var, not a setting — auto-generated into .env on first use
 * for installs that predate this feature. */
function getOrCreateBackupPassword() {
  if (process.env.BACKUP_ENCRYPTION_PASSWORD && process.env.BACKUP_ENCRYPTION_PASSWORD !== 'changeme_generate_a_long_random_string') {
    return process.env.BACKUP_ENCRYPTION_PASSWORD;
  }
  const generated = crypto.randomBytes(32).toString('hex');
  let envContent = '';
  try {
    envContent = fs.readFileSync(ENV_PATH, 'utf8');
  } catch {
    // .env doesn't exist yet — unusual, but proceed with an in-memory value
  }
  if (/^BACKUP_ENCRYPTION_PASSWORD=/m.test(envContent)) {
    envContent = envContent.replace(/^BACKUP_ENCRYPTION_PASSWORD=.*$/m, `BACKUP_ENCRYPTION_PASSWORD=${generated}`);
  } else {
    envContent += `${envContent.endsWith('\n') || envContent === '' ? '' : '\n'}BACKUP_ENCRYPTION_PASSWORD=${generated}\n`;
  }
  fs.writeFileSync(ENV_PATH, envContent, { mode: 0o600 });
  process.env.BACKUP_ENCRYPTION_PASSWORD = generated;
  console.warn('[Backup] Generated a new BACKUP_ENCRYPTION_PASSWORD and saved it to .env — back this up securely, separately from your backup files.');
  return generated;
}

/** AES-256-GCM with a scrypt-derived key. Output layout: salt(16) |
 * iv(16) | authTag(16) | ciphertext — everything needed to decrypt except
 * the password itself, which is never stored in the output. */
function encryptBuffer(plainBuffer, password) {
  const salt = crypto.randomBytes(16);
  const iv = crypto.randomBytes(16);
  const key = crypto.scryptSync(password, salt, 32);
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
  const ciphertext = Buffer.concat([cipher.update(plainBuffer), cipher.final()]);
  const authTag = cipher.getAuthTag();
  return Buffer.concat([salt, iv, authTag, ciphertext]);
}

function decryptBuffer(blob, password) {
  const salt = blob.subarray(0, 16);
  const iv = blob.subarray(16, 32);
  const authTag = blob.subarray(32, 48);
  const ciphertext = blob.subarray(48);
  const key = crypto.scryptSync(password, salt, 32);
  const decipher = crypto.createDecipheriv('aes-256-gcm', key, iv);
  decipher.setAuthTag(authTag);
  return Buffer.concat([decipher.update(ciphertext), decipher.final()]);
}

/** Safe hot-copy for a WAL-mode SQLite DB: checkpoint the WAL into the main
 * file (TRUNCATE mode empties the WAL after), then the main .db file alone
 * is a complete, consistent snapshot safe to copy while the app keeps
 * running. */
function snapshotDbFile(destPath) {
  db.pragma('wal_checkpoint(TRUNCATE)');
  fs.copyFileSync(DB_PATH, destPath);
}

async function createBackup(triggeredBy = 'auto') {
  const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
  const filename = `infraloom-backup-${timestamp}.zip`;
  const outPath = path.join(BACKUP_DIR, filename);

  const tmpDbCopy = path.join(BACKUP_DIR, `.tmp-${timestamp}.db`);
  snapshotDbFile(tmpDbCopy);

  const password = getOrCreateBackupPassword();
  const envPlain = fs.readFileSync(ENV_PATH);
  const envEncrypted = encryptBuffer(envPlain, password);

  await new Promise((resolve, reject) => {
    const output = fs.createWriteStream(outPath);
    const archive = archiver('zip', { zlib: { level: 9 } });
    output.on('close', resolve);
    archive.on('error', reject);
    archive.pipe(output);
    archive.file(tmpDbCopy, { name: 'infraloom.db' });
    archive.append(envEncrypted, { name: 'env.enc' });
    archive.append(
      'This backup contains infraloom.db (SQLCipher-encrypted with your DB_ENCRYPTION_KEY) and env.enc\n' +
        '(your .env, AES-256-GCM encrypted with your BACKUP_ENCRYPTION_PASSWORD).\n\n' +
        'To restore: decrypt env.enc with BACKUP_ENCRYPTION_PASSWORD to recover the original .env\n' +
        '(which contains DB_ENCRYPTION_KEY), then place both files back into a fresh InfraLoom install.\n',
      { name: 'README.txt' }
    );
    archive.finalize();
  });

  fs.unlinkSync(tmpDbCopy);

  const size = fs.statSync(outPath).size;
  applyRetention();
  return { filename, size, triggeredBy };
}

function listBackups() {
  return fs
    .readdirSync(BACKUP_DIR)
    .filter((f) => f.endsWith('.zip'))
    .map((f) => {
      const stat = fs.statSync(path.join(BACKUP_DIR, f));
      return { filename: f, size: stat.size, created_at: stat.mtime.toISOString() };
    })
    .sort((a, b) => b.created_at.localeCompare(a.created_at));
}

function applyRetention() {
  const keep = parseInt(getSetting('backup_retention_count', '14'), 10) || 14;
  const backups = listBackups();
  for (const b of backups.slice(keep)) {
    fs.unlinkSync(path.join(BACKUP_DIR, b.filename));
  }
}

function deleteBackup(filename) {
  const safeName = path.basename(filename);
  const full = path.join(BACKUP_DIR, safeName);
  if (fs.existsSync(full)) fs.unlinkSync(full);
}

function backupFilePath(filename) {
  const safeName = path.basename(filename);
  const full = path.join(BACKUP_DIR, safeName);
  return fs.existsSync(full) ? full : null;
}

let cronTask = null;
function reschedule(cronExpr) {
  const cron = require('node-cron');
  if (cronTask) {
    cronTask.stop();
    cronTask = null;
  }
  if (!cronExpr || !cron.validate(cronExpr)) {
    console.error(`[Backup] Invalid cron expression "${cronExpr}" — scheduler disabled`);
    return false;
  }
  cronTask = cron.schedule(cronExpr, () => {
    createBackup('auto').catch((err) => console.error('[Backup] Scheduled backup failed:', err.message));
  });
  return true;
}

function initScheduler() {
  reschedule(getSetting('backup_cron', '0 3 * * *'));
}

module.exports = { createBackup, listBackups, deleteBackup, backupFilePath, applyRetention, reschedule, initScheduler, decryptBuffer, getOrCreateBackupPassword };
