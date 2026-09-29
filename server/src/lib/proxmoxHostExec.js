'use strict';

const fs = require('fs');
const { Client: SSHClient } = require('ssh2');

/** Runs a raw shell command directly on a remote HOST via SSH — no
 * `pct exec` wrapper, unlike pctExec.js's execInLXC. Used for host-only
 * operations that have no REST API equivalent, like `qm importdisk`
 * during template creation. Supports both password and private-key auth. */
function execOnHost(creds, command, { timeoutMs = 600000, onOutput } = {}) {
  return new Promise((resolve, reject) => {
    if (!creds?.username || !(creds?.password || creds?.privateKey)) {
      return reject(new Error("This requires SSH access to the host itself (username + password or private key)"));
    }

    const connectOpts = { host: creds.host, port: creds.port || 22, username: creds.username, readyTimeout: 15000 };
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
        reject(new Error(`SSH to ${creds.host}:${creds.port || 22} failed: ${err.message}`));
      })
      .connect(connectOpts);
  });
}

module.exports = { execOnHost };
