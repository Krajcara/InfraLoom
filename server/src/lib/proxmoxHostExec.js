'use strict';

const { Client: SSHClient } = require('ssh2');

/** Runs a raw shell command directly on the Proxmox HOST via SSH — no
 * `pct exec` wrapper, unlike pctExec.js's execInLXC. Used for host-only
 * operations that have no REST API equivalent, like `qm importdisk`
 * during template creation. Reuses the same host-level SSH credentials as
 * LXC patch management (patch_ssh_host/username/password), since both
 * need the identical kind of access — broad, host-level shell control. */
function execOnHost(creds, command, { timeoutMs = 600000, onOutput } = {}) {
  return new Promise((resolve, reject) => {
    if (!creds?.username || !creds?.password) {
      return reject(new Error("This requires SSH access to the Proxmox host itself (see the connection's Patch Management SSH settings)"));
    }
    const client = new SSHClient();
    const timer = setTimeout(() => {
      client.end();
      reject(new Error('Command timed out'));
    }, timeoutMs);

    client
      .on('ready', () => {
        client.exec(command, (err, stream) => {
          if (err) {
            clearTimeout(timer);
            client.end();
            return reject(err);
          }
          let stdout = '';
          let stderr = '';
          stream
            .on('close', (exitCode) => {
              clearTimeout(timer);
              client.end();
              resolve({ exitCode: exitCode ?? -1, stdout, stderr });
            })
            .on('data', (data) => {
              const text = data.toString('utf8');
              stdout += text;
              if (onOutput) onOutput(text);
            });
          stream.stderr.on('data', (data) => {
            const text = data.toString('utf8');
            stderr += text;
            if (onOutput) onOutput(text);
          });
        });
      })
      .on('error', (err) => {
        clearTimeout(timer);
        reject(new Error(`SSH to Proxmox host (${creds.host}:${creds.port || 22}) failed: ${err.message}`));
      })
      .connect({
        host: creds.host, port: creds.port || 22,
        username: creds.username, password: creds.password,
        readyTimeout: 15000,
      });
  });
}

module.exports = { execOnHost };
