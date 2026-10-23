'use strict';

// A throw-away self-signed certificate for the tests, made with openssl when a test needs it (nothing of the kind is kept in the repository).
// Returns { cert, key } as buffers, or null if openssl is not installed (the tests that need it are then skipped).

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

let cached;
function makeCert() {
  if (cached !== undefined) return cached;
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tls-'));
  const r = spawnSync('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-keyout', path.join(dir, 'k.pem'), '-out', path.join(dir, 'c.pem'), '-days', '3650', '-subj', '/CN=localhost/O=InfraLoom Test', '-addext', 'subjectAltName=DNS:localhost,IP:127.0.0.1'], { stdio: 'ignore' });
  cached = r.status === 0 ? { cert: fs.readFileSync(path.join(dir, 'c.pem')), key: fs.readFileSync(path.join(dir, 'k.pem')) } : null;
  fs.rmSync(dir, { recursive: true, force: true });
  return cached;
}

module.exports = { makeCert };
