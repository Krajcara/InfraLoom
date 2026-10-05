'use strict';

const snmp = require('net-snmp');

const OID = {
  sysDescr: '1.3.6.1.2.1.1.1.0',
  sysName: '1.3.6.1.2.1.1.5.0',
  sysUpTime: '1.3.6.1.2.1.1.3.0',
  ifName: '1.3.6.1.2.1.31.1.1.1.1',
  ifOperStatus: '1.3.6.1.2.1.2.2.1.8',
  ifHighSpeed: '1.3.6.1.2.1.31.1.1.1.15',
  ifHCInOctets: '1.3.6.1.2.1.31.1.1.1.6',
  ifHCOutOctets: '1.3.6.1.2.1.31.1.1.1.10',
};

// v3 algorithm names as stored in the DB -> net-snmp constants. MD5/SHA and
// DES/AES are what network devices have always used; the SHA-2 family and
// AES-256 are there for newer firmware (UPS network cards included).
const AUTH_PROTOCOLS = {
  MD5: snmp.AuthProtocols.md5,
  SHA: snmp.AuthProtocols.sha,
  SHA224: snmp.AuthProtocols.sha224,
  SHA256: snmp.AuthProtocols.sha256,
  SHA384: snmp.AuthProtocols.sha384,
  SHA512: snmp.AuthProtocols.sha512,
};
const PRIV_PROTOCOLS = {
  DES: snmp.PrivProtocols.des,
  AES: snmp.PrivProtocols.aes,
  AES256B: snmp.PrivProtocols.aes256b, // Blumenthal (Net-SNMP default)
  AES256R: snmp.PrivProtocols.aes256r, // Reeder (Cisco)
};

function buildSession(ip, cfg) {
  const port = parseInt(cfg.snmp_port, 10) || 161;
  const v = String(cfg.snmp_version || '2c');
  const timeout = parseInt(cfg.snmp_timeout_ms, 10) || 8000;

  if (v === '3') {
    const level = cfg.snmp_security_level || 'authPriv';
    const authProto = AUTH_PROTOCOLS[cfg.snmp_auth_protocol] || snmp.AuthProtocols.sha;
    const privProto = PRIV_PROTOCOLS[cfg.snmp_priv_protocol] || snmp.PrivProtocols.aes;
    const user = {
      name: cfg.snmp_username || 'snmpv3user',
      level:
        level === 'noAuthNoPriv'
          ? snmp.SecurityLevel.noAuthNoPriv
          : level === 'authNoPriv'
            ? snmp.SecurityLevel.authNoPriv
            : snmp.SecurityLevel.authPriv,
    };
    if (level !== 'noAuthNoPriv') {
      user.authProtocol = authProto;
      user.authKey = cfg.snmp_auth_password || '';
    }
    if (level === 'authPriv') {
      user.privProtocol = privProto;
      user.privKey = cfg.snmp_priv_password || '';
    }
    return snmp.createV3Session(ip, user, { port, timeout, retries: 1, version: snmp.Version3 });
  }

  return snmp.createSession(ip, cfg.snmp_community || 'public', {
    port,
    timeout,
    retries: 1,
    version: v === '1' ? snmp.Version1 : snmp.Version2c,
  });
}

function snmpGet(session, oids) {
  return new Promise((resolve) => {
    session.get(oids, (err, varbinds) => {
      const out = {};
      if (!err) {
        varbinds.forEach((vb, i) => {
          if (!snmp.isVarbindError(vb)) {
            const v = vb.value;
            out[oids[i]] = Buffer.isBuffer(v) ? v.toString('utf8').replace(/\0/g, '') : v;
          }
        });
      }
      resolve(out);
    });
  });
}

function snmpWalk(session, rootOid, { strict = false } = {}) {
  return new Promise((resolve, reject) => {
    const results = [];
    session.subtree(
      rootOid,
      50,
      (varbinds) => {
        let stop = false;
        varbinds.forEach((vb) => {
          if (!snmp.isVarbindError(vb)) {
            const v = vb.value;
            results.push({ oid: vb.oid, value: Buffer.isBuffer(v) ? v.toString('utf8').replace(/\0/g, '') : v });
          } else if (strict) {
            stop = true; // NoSuchObject / EndOfMibView: nothing (more) under this subtree. Some embedded agents answer
          }                // past the end of their MIB with the same OID instead of endOfMibView, which would loop forever.
        });
        return stop;
      },
      // strict: a timeout/auth failure rejects, so a dead or misconfigured
      // device can't look like "answered, but has no data". The default
      // (lenient) keeps the existing network-device behaviour unchanged.
      (err) => (strict && err ? reject(err) : resolve(results))
    );
  });
}

function formatUptime(ticks) {
  if (!ticks) return null;
  const s = Math.floor(parseInt(ticks, 10) / 100);
  const d = Math.floor(s / 86400);
  const h = Math.floor((s % 86400) / 3600);
  const m = Math.floor((s % 3600) / 60);
  return d > 0 ? `${d}d ${h}h ${m}m` : `${h}h ${m}m`;
}

/** Vendor-agnostic SNMP poll: hostname, uptime, and per-interface link/traffic. */
async function pollSnmp(ip, cfg) {
  const session = buildSession(ip, cfg);
  try {
    const scalars = await snmpGet(session, [OID.sysDescr, OID.sysName, OID.sysUpTime]);
    if (!scalars[OID.sysName] && !scalars[OID.sysDescr]) {
      session.close();
      return { connected: false, error: 'SNMP timeout — check community string / credentials and that SNMP is enabled on the device' };
    }

    const [ifNames, ifStatuses, ifSpeeds, ifInHC, ifOutHC] = await Promise.all([
      snmpWalk(session, OID.ifName),
      snmpWalk(session, OID.ifOperStatus),
      snmpWalk(session, OID.ifHighSpeed),
      snmpWalk(session, OID.ifHCInOctets),
      snmpWalk(session, OID.ifHCOutOctets),
    ]);

    const byIdx = {};
    ifNames.forEach((r) => {
      const i = r.oid.replace(`${OID.ifName}.`, '');
      byIdx[i] = { name: String(r.value).trim() };
    });
    ifStatuses.forEach((r) => {
      const i = r.oid.replace(`${OID.ifOperStatus}.`, '');
      if (byIdx[i]) byIdx[i].link = parseInt(r.value, 10) === 1;
    });
    ifSpeeds.forEach((r) => {
      const i = r.oid.replace(`${OID.ifHighSpeed}.`, '');
      if (byIdx[i]) byIdx[i].speed = parseInt(r.value, 10) || null;
    });
    ifInHC.forEach((r) => {
      const i = r.oid.replace(`${OID.ifHCInOctets}.`, '');
      if (byIdx[i]) byIdx[i].rx_bytes = parseInt(r.value, 10) || 0;
    });
    ifOutHC.forEach((r) => {
      const i = r.oid.replace(`${OID.ifHCOutOctets}.`, '');
      if (byIdx[i]) byIdx[i].tx_bytes = parseInt(r.value, 10) || 0;
    });

    session.close();
    return {
      connected: true,
      hostname: scalars[OID.sysName] ? String(scalars[OID.sysName]) : null,
      description: scalars[OID.sysDescr] ? String(scalars[OID.sysDescr]) : null,
      uptime: formatUptime(scalars[OID.sysUpTime]),
      interfaces: Object.values(byIdx)
        .filter((i) => i.name)
        .map((i) => ({
          name: i.name,
          link: i.link || false,
          speed: i.speed,
          rx_bytes: i.rx_bytes || 0,
          tx_bytes: i.tx_bytes || 0,
        }))
        .sort((a, b) => (a.link === b.link ? a.name.localeCompare(b.name) : a.link ? -1 : 1)),
    };
  } catch (err) {
    try {
      session.close();
    } catch {
      // already closed
    }
    return { connected: false, error: err.message };
  }
}

module.exports = { pollSnmp, buildSession, snmpGet, snmpWalk, AUTH_PROTOCOLS, PRIV_PROTOCOLS };
