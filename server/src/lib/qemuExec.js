'use strict';

const axios = require('axios');
const https = require('https');
const { buildToken } = require('./proxmoxClient');

const httpsAgent = new https.Agent({ rejectUnauthorized: false });

async function pveCall(conn, method, path, data) {
  const token = buildToken(conn);
  const res = await axios({
    method,
    url: `${conn.url}/api2/json${path}`,
    data,
    headers: { Authorization: `PVEAPIToken=${token}` },
    httpsAgent,
    timeout: 15000,
  });
  return res.data.data;
}

/** Runs a shell command inside a QEMU VM via the guest agent, polling until
 * it exits (guest-agent exec has no push-streaming — the caller polls this
 * repeatedly for a "live" feel; see patchService.js). Returns the full
 * result only once the command has exited. */
async function execInVM(conn, node, vmid, command, { timeoutMs = 300000, onOutput } = {}) {
  const start = await pveCall(conn, 'post', `/nodes/${node}/qemu/${vmid}/agent/exec`, {
    command: ['/bin/bash', '-c', command],
  });
  const pid = start.pid;
  if (!pid) throw new Error('Guest agent did not return a PID — is the QEMU guest agent running in this VM?');

  const deadline = Date.now() + timeoutMs;
  let lastOutLen = 0;
  let lastErrLen = 0;

  while (Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 1500));
    const status = await pveCall(conn, 'get', `/nodes/${node}/qemu/${vmid}/agent/exec-status?pid=${pid}`);

    if (onOutput) {
      const out = status['out-data'] || '';
      const err = status['err-data'] || '';
      if (out.length > lastOutLen) {
        onOutput(out.slice(lastOutLen));
        lastOutLen = out.length;
      }
      if (err.length > lastErrLen) {
        onOutput(err.slice(lastErrLen));
        lastErrLen = err.length;
      }
    }

    if (status.exited) {
      return {
        exitCode: status.exitcode ?? -1,
        stdout: status['out-data'] || '',
        stderr: status['err-data'] || '',
      };
    }
  }
  throw new Error('Command timed out inside the guest');
}

module.exports = { execInVM };
