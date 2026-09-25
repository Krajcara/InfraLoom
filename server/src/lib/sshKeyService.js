'use strict';

const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const PROJECT_ROOT = path.resolve(__dirname, '..', '..', '..');
const SSH_DIR = path.join(PROJECT_ROOT, 'data', 'ssh');
const KEY_PATH = path.join(SSH_DIR, 'infraloom_mgmt_key');
const PUB_KEY_PATH = `${KEY_PATH}.pub`;

fs.mkdirSync(SSH_DIR, { recursive: true, mode: 0o700 });

/** Generates InfraLoom's management SSH keypair on first use (ed25519 —
 * small, fast, the modern default) and reuses it after that. This one
 * keypair is injected into every new VM/LXC's authorized_keys so
 * InfraLoom can reach guests it creates without a manual credential step. */
function ensureManagementKey() {
  if (!fs.existsSync(KEY_PATH)) {
    execFileSync('ssh-keygen', ['-t', 'ed25519', '-f', KEY_PATH, '-N', '', '-C', 'infraloom-managed-key'], { stdio: 'pipe' });
    fs.chmodSync(KEY_PATH, 0o600);
  }
  return { privateKeyPath: KEY_PATH, publicKey: fs.readFileSync(PUB_KEY_PATH, 'utf8').trim() };
}

/** SHA-512 crypt hash of a plaintext password, for cloud-init's chpasswd
 * module — avoids putting the plaintext password into the cloud-init
 * snippet file (which gets uploaded to and stored on the Proxmox host). */
function hashPassword(plaintext) {
  return execFileSync('openssl', ['passwd', '-6', plaintext]).toString('utf8').trim();
}

module.exports = { ensureManagementKey, hashPassword, KEY_PATH };
