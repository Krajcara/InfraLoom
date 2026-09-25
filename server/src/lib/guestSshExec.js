'use strict';

const fs = require('fs');
const { Client: SSHClient } = require('ssh2');

/** Runs a shell command directly inside a Linux guest via SSH to the
 * guest's own IP. Used for Hyper-V (and any future hypervisor without a
 * guest-agent exec API) — Proxmox VMs use qemuExec's guest-agent channel
 * instead, and Proxmox LXC uses pctExec (SSH to the host, not the guest). */
function execInGuest(creds, command, { timeoutMs = 300000, onOutput } = {}) {
  return new Promise((resolve, reject) => {
    if (!creds?.host) return reject(new Error('No IP address known for this guest — is the guest agent / integration service reporting it?'));
    if (!creds?.username || !(creds?.password || creds?.privateKey)) {
      return reject(new Error('No saved SSH credentials for this guest (set them from the Patch Management guest list)'));
    }

    const connectOpts = {
      host: creds.host, port: creds.port || 22,
      username: creds.username, readyTimeout: 15000,
    };
    if (creds.privateKey) {
      try {
        connectOpts.privateKey = fs.readFileSync(creds.privateKey);
        if (creds.passphrase) connectOpts.passphrase = creds.passphrase;
      } catch (err) {
        return reject(new Error(`Could not read private key file (${creds.privateKey}): ${err.message}`));
      }
    } else {
      connectOpts.password = creds.password;
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
        reject(new Error(`SSH to guest (${creds.host}:${creds.port || 22}) failed: ${err.message}`));
      })
      .connect(connectOpts);
  });
}

module.exports = { execInGuest };
