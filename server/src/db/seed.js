'use strict';

require('dotenv').config({ path: require('path').join(__dirname, '../../../.env') });

const os = require('os');
const crypto = require('crypto');
const bcrypt = require('bcryptjs');
const db = require('./database');

function getServerIp() {
  const interfaces = os.networkInterfaces();
  for (const name of Object.keys(interfaces)) {
    for (const iface of interfaces[name]) {
      if (iface.family === 'IPv4' && !iface.internal) {
        return iface.address;
      }
    }
  }
  return '127.0.0.1';
}

function generatePassword(length = 16) {
  // Alphanumeric + a few symbols, avoiding characters that are easy to
  // misread (0/O, 1/l/I) so it's easy to copy/type during first login.
  const chars = 'ABCDEFGHJKMNPQRSTUVWXYZabcdefghijkmnpqrstuvwxyz23456789!@#$%';
  return Array.from(crypto.randomFillSync(new Uint8Array(length)))
    .map((b) => chars[b % chars.length])
    .join('');
}

function seedSuperadmin() {
  const existing = db.prepare("SELECT id FROM users WHERE role = 'superadmin'").get();
  if (existing) {
    console.log('[seed] A superadmin account already exists — skipping creation.');
    return null;
  }

  const username = 'admin';
  const password = generatePassword();
  const passwordHash = bcrypt.hashSync(password, 12);

  db.prepare(
    `INSERT INTO users (username, password_hash, role, is_active)
     VALUES (?, ?, 'superadmin', 1)`
  ).run(username, passwordHash);

  db.prepare(
    `INSERT INTO audit_log (username, action, module, details)
     VALUES (?, 'user.create', 'auth', 'Initial superadmin account created by installer')`
  ).run(username);

  return { username, password };
}

const credentials = seedSuperadmin();
const port = process.env.APP_PORT || 3000;
const ip = getServerIp();

if (credentials) {
  console.log('');
  console.log('═══════════════════════════════════════════════════════════');
  console.log('  InfraLoom — initial superadmin account created');
  console.log('═══════════════════════════════════════════════════════════');
  console.log(`  Username : ${credentials.username}`);
  console.log(`  Password : ${credentials.password}`);
  console.log('');
  console.log(`  Login URL : http://${ip}:${port}`);
  console.log(`  Server IP : ${ip}`);
  console.log(`  Port      : ${port}`);
  console.log('═══════════════════════════════════════════════════════════');
  console.log('  Save this password now — it will not be shown again.');
  console.log('  Change it after first login (Profile → Change password).');
  console.log('═══════════════════════════════════════════════════════════');
  console.log('');
} else {
  console.log(`[seed] Login URL: http://${ip}:${port}`);
}

db.close();
