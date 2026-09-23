'use strict';

const { Client: SSHClient } = require('ssh2');

/** Runs a shell command inside an LXC container by SSHing into the Proxmox
 * HOST (not the container) and invoking `pct exec <vmid> -- ...`. This is
 * the only way to execute arbitrary commands in a container remotely —
 * Proxmox's REST API has no container equivalent of the QEMU guest-agent
 * exec endpoint.
 *
 * `creds` is the already-resolved SSH target for whichever node the
 * container lives on — { host, username, password, port } — since a
 * cluster's nodes can have different root passwords. Resolving which
 * credentials apply is patchService's job (per-node override, falling back
 * to the connection's default), not this module's. */
function execInLXC(creds, vmid, command, { timeoutMs = 300000, onOutput } = {}) {
  return new Promise((resolve, reject) => {
    if (!creds?.username || !creds?.password) {
      return reject(new Error("LXC patch management requires a Proxmox host SSH username/password (see the connection's Patch Management settings, or this node's SSH override)"));
    }
    const host = creds.host;
    const port = creds.port || 22;

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
        reject(new Error(`SSH to Proxmox host (${host}:${port}) failed: ${err.message}`));
      })
      .connect({
        host, port,
        username: creds.username,
        password: creds.password,
        readyTimeout: 15000,
      });
  });
}

module.exports = { execInLXC };
