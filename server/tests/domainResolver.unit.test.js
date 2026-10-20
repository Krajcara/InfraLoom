'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const dns = require('node:dns');

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dns-res-'));
const hex = () => crypto.randomBytes(32).toString('hex');
Object.assign(process.env, { NODE_ENV: 'test', DB_PATH: path.join(dir, 'infraloom.db'), DB_ENCRYPTION_KEY: hex(), APP_SECRET: hex(), BACKUP_ENCRYPTION_PASSWORD: hex() });
const db = require('../src/db/database');
const R = require('../src/lib/domainResolver');
test.after(() => fs.rmSync(dir, { recursive: true, force: true }));

test('public servers unless chosen otherwise; "system" is the server\'s own resolver', () => {
  assert.deepEqual(R.config(), { mode: 'public', custom: '', servers: ['1.1.1.1', '8.8.8.8'] });
  assert.deepEqual(R.getResolver().getServers(), ['1.1.1.1', '8.8.8.8']);
  R.save({ mode: 'system' }); assert.equal(R.getResolver(), dns.promises); assert.equal(R.config().servers, null);
  R.save({ mode: 'custom', servers: '9.9.9.9 , 149.112.112.112' }); assert.deepEqual(R.getResolver().getServers(), ['9.9.9.9', '149.112.112.112']);
});

test('a stored value that cannot be used falls back to the public servers instead of breaking the checks', () => {
  db.prepare("INSERT OR REPLACE INTO settings (key, value) VALUES ('domain_check_dns', 'custom'), ('domain_check_dns_servers', 'garbage, 999.1.1.1')").run();
  assert.deepEqual(R.config().servers, ['1.1.1.1', '8.8.8.8']);
  db.prepare("INSERT OR REPLACE INTO settings (key, value) VALUES ('domain_check_dns', 'weird')").run(); assert.equal(R.config().mode, 'public');
});

test('which addresses are accepted', () => {
  for (const ok of ['1.1.1.1', '1.1.1.1:5353', '2606:4700:4700::1111', '[2606:4700:4700::1111]:53', '[::1]']) assert.equal(R.validServer(ok), true, ok);
  for (const bad of ['', 'dns.example', '1.1.1', '1.1.1.1:0', '1.1.1.1:70000', '1.1.1.1:53:1', '[1.1.1.1]:53', '300.1.1.1']) assert.equal(R.validServer(bad), false, bad);
});
