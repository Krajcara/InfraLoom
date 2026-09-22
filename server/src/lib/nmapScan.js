'use strict';

const { spawn } = require('child_process');
const { parseStringPromise } = require('xml2js');

function runNmap(args, timeoutMs) {
  return new Promise((resolve, reject) => {
    const child = spawn('nmap', args);
    let stdout = '';
    let stderr = '';
    const timer = setTimeout(() => {
      child.kill();
      reject(new Error('nmap timed out'));
    }, timeoutMs);

    child.stdout.on('data', (d) => (stdout += d.toString()));
    child.stderr.on('data', (d) => (stderr += d.toString()));
    child.on('error', (err) => {
      clearTimeout(timer);
      reject(new Error(`nmap could not be started: ${err.message}`));
    });
    child.on('exit', (code) => {
      clearTimeout(timer);
      if (code !== 0 && !stdout) return reject(new Error(stderr.trim() || `nmap exited with code ${code}`));
      resolve(stdout);
    });
  });
}

async function parsePorts(xml) {
  if (!xml) return [];
  let parsed;
  try {
    parsed = await parseStringPromise(xml);
  } catch {
    return [];
  }
  const host = parsed?.nmaprun?.host?.[0];
  const portEls = host?.ports?.[0]?.port || [];
  return portEls
    .filter((p) => {
      const state = p.state?.[0]?.$.state;
      return state === 'open' || state === 'open|filtered';
    })
    .map((p) => {
      const service = p.service?.[0]?.$ || {};
      return {
        port: parseInt(p.$.portid, 10),
        protocol: p.$.protocol,
        service: service.name || null,
        product: service.product || null,
        version: service.version || null,
      };
    });
}

/** Runs a TCP (top 1000 ports) + UDP (top 100 ports) scan against one host.
 * Requires nmap to have CAP_NET_RAW/CAP_NET_ADMIN (see install.sh) for the
 * SYN/UDP scan types — falls back to a plain connect scan if that fails. */
async function scanHost(ip) {
  let tcpXml;
  try {
    tcpXml = await runNmap(['-sS', '-sV', '--top-ports', '1000', '--host-timeout', '60s', '-oX', '-', ip], 90000);
  } catch {
    // SYN scan needs raw-socket privileges — fall back to a plain TCP connect scan
    tcpXml = await runNmap(['-sT', '-sV', '--top-ports', '1000', '--host-timeout', '60s', '-oX', '-', ip], 90000);
  }

  let udpXml = null;
  try {
    udpXml = await runNmap(['-sU', '--top-ports', '50', '--host-timeout', '30s', '-oX', '-', ip], 45000);
  } catch {
    // UDP scan needs raw sockets too and is best-effort — skip silently on failure
  }

  const [tcpPorts, udpPorts] = await Promise.all([parsePorts(tcpXml), parsePorts(udpXml)]);
  return [...tcpPorts, ...udpPorts];
}

module.exports = { scanHost };
