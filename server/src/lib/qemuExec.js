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

/** Dedicated QEMU guest-agent command that returns OS metadata directly —
 * faster and more reliable than probing with a shell script, and critically
 * works on Windows guests too (which have no /bin/sh to run a probe in). */
async function getOsInfo(conn, node, vmid) {
  try {
    const data = await pveCall(conn, 'get', `/nodes/${node}/qemu/${vmid}/agent/get-osinfo`);
    return data?.result || null; // { id: 'mswindows' | 'ubuntu' | 'debian' | ..., name, version, ... }
  } catch {
    return null; // guest agent not ready / doesn't support this call yet
  }
}

/** Runs a command inside a QEMU VM via the guest agent, polling until it
 * exits (guest-agent exec has no push-streaming — the caller polls this
 * repeatedly for a "live" feel; see patchService.js). Returns the full
 * result only once the command has exited.
 *
 * `osType: 'windows'` wraps the command with powershell.exe instead of
 * /bin/sh -c, since Windows guests have no POSIX shell. */
async function execInVM(conn, node, vmid, command, { timeoutMs = 300000, onOutput, osType = 'linux' } = {}) {
  const execCommand = osType === 'windows'
    ? ['powershell.exe', '-NonInteractive', '-NoProfile', '-Command', command]
    : ['/bin/sh', '-c', command];

  const start = await pveCall(conn, 'post', `/nodes/${node}/qemu/${vmid}/agent/exec`, { command: execCommand });
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

module.exports = { execInVM, getOsInfo };
