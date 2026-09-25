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

/** Installs InfraLoom's management public key onto an already-reachable
 * guest (one with an existing saved password) by connecting once with
 * that password and appending to ~/.ssh/authorized_keys — the same
 * result cloud-init gives a freshly-created VM, but for a guest InfraLoom
 * didn't create. Requires the ssh2 client, passed in by the caller to
 * avoid a hard dependency here. */
async function pushKeyToGuest(SSHClient, creds) {
  if (!creds.host || !creds.username || !creds.password) {
    throw new Error('Need an existing host, username, and password saved for this guest first');
  }
  const mgmtKey = ensureManagementKey();
  const script =
    'mkdir -p ~/.ssh && chmod 700 ~/.ssh && ' +
    `grep -qxF '${mgmtKey.publicKey}' ~/.ssh/authorized_keys 2>/dev/null || echo '${mgmtKey.publicKey}' >> ~/.ssh/authorized_keys && ` +
    'chmod 600 ~/.ssh/authorized_keys && echo ___KEY_INSTALLED___';

  return new Promise((resolve, reject) => {
    const client = new SSHClient();
    const timer = setTimeout(() => {
      client.end();
      reject(new Error('Timed out connecting to install the key'));
    }, 15000);
    client
      .on('ready', () => {
        client.exec(script, (err, stream) => {
          if (err) {
            clearTimeout(timer);
            client.end();
            return reject(err);
          }
          let out = '';
          stream.on('data', (d) => { out += d.toString(); });
          stream.stderr.on('data', (d) => { out += d.toString(); });
          stream.on('close', (code) => {
            clearTimeout(timer);
            client.end();
            if (code === 0 && out.includes('___KEY_INSTALLED___')) resolve(mgmtKey.privateKeyPath);
            else reject(new Error(`Key install failed (exit ${code}): ${out}`));
          });
        });
      })
      .on('error', (err) => {
        clearTimeout(timer);
        reject(new Error(`SSH to guest (${creds.host}:${creds.port || 22}) failed: ${err.message}`));
      })
      .connect({ host: creds.host, port: creds.port || 22, username: creds.username, password: creds.password, readyTimeout: 15000 });
  });
}

module.exports = { ensureManagementKey, hashPassword, pushKeyToGuest, KEY_PATH };
