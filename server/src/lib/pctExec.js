'use strict';

const { Client: SSHClient } = require('ssh2');

/** Runs a shell command inside an LXC container by SSHing into the Proxmox
 * HOST (not the container) and invoking `pct exec <vmid> -- ...`. This is
 * the only way to execute arbitrary commands in a container remotely —
 * Proxmox's REST API has no container equivalent of the QEMU guest-agent
 * exec endpoint. Requires `conn.patch_ssh_username`/`patch_ssh_password` to
 * be configured (a separate, host-level credential from the API token). */
function execInLXC(conn, vmid, command, { timeoutMs = 300000, onOutput } = {}) {
  return new Promise((resolve, reject) => {
    if (!conn.patch_ssh_username || !conn.patch_ssh_password) {
      return reject(new Error("LXC patch management requires a Proxmox host SSH username/password (see the connection's Patch Management settings)"));
    }
    const host = conn.url.replace(/^https?:\/\//, '').split(':')[0].split('/')[0];
    const port = conn.patch_ssh_port || 22;

    // vmid is only ever a value we generated ourselves (from the Proxmox API
    // response), but validate it's numeric anyway before it goes into a
    // remote shell command.
    if (!/^\d+$/.test(String(vmid))) return reject(new Error(`Invalid LXC vmid: ${vmid}`));

    const shellEscaped = command.replace(/'/g, `'\\''`);
    const fullCommand = `export PATH="/usr/sbin:/usr/bin:/sbin:/bin:$PATH"; pct exec ${vmid} -- /bin/sh -c '${shellEscaped}'`;

    const client = new SSHClient();
    const timer = setTimeout(() => {
      client.end();
      reject(new Error('Command timed out'));
    }, timeoutMs);

    client
      .on('ready', () => {
        client.exec(fullCommand, (err, stream) => {
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
        reject(new Error(`SSH to Proxmox host failed: ${err.message}`));
      })
      .connect({
        host, port,
        username: conn.patch_ssh_username,
        password: conn.patch_ssh_password,
        readyTimeout: 15000,
      });
  });
}

module.exports = { execInLXC };
