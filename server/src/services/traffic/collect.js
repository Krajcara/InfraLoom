'use strict';

// Reading the interface counters of a device: a FortiGate through its REST API, anything else through SNMP (IF-MIB, 64-bit counters when there are any).

const snmp = require('net-snmp');
const { toBig } = require('./rates');
const { buildSession } = require('../../lib/snmpGeneric');

const num = (v) => (typeof v === 'number' && Number.isFinite(v) ? v : typeof v === 'string' && v.trim() !== '' && Number.isFinite(Number(v)) ? Number(v) : null);

// ── FortiGate ─────────────────────────────────────────────────────────────

/** results of GET /api/v2/monitor/system/interface: an object by name, or a list. Each interface: name, alias, link, speed (Mbps), rx_bytes, tx_bytes. */
function parseFortigateInterfaces(results) {
  const rows = Array.isArray(results) ? results : Object.values(results || {});
  const out = [];
  for (const e of rows) {
    if (!e || typeof e !== 'object') continue;
    const name = String(e.name ?? e.id ?? '').trim();
    if (!name) continue;
    const link = typeof e.link === 'boolean' ? e.link : /^up$/i.test(String(e.link)) ? true : /^down$/i.test(String(e.link)) ? false : null;
    out.push({
      name, alias: e.alias ? String(e.alias) : null, status: link === null ? 'unknown' : link ? 'up' : 'down',
      speedMbps: num(e.speed) > 0 ? num(e.speed) : null, inOctets: toBig(e.rx_bytes ?? e.rx_byte ?? e.bytes_rx ?? null), outOctets: toBig(e.tx_bytes ?? e.tx_byte ?? e.bytes_tx ?? null), bits: 64,
    });
  }
  return out;
}

async function readFortigate(device) {
  if (!device.api_token) throw new Error('This router has no API token configured');
  const api = require('../../lib/fortigateHealth').client(device);
  const endpoint = '/api/v2/monitor/system/interface';
  try {
    const res = await api.get(endpoint, { params: { vdom: 'root', include_vlan: 'true' } });
    const results = res.data?.results;
    return { method: 'fortigate', endpoint, interfaces: parseFortigateInterfaces(results), raw: JSON.stringify(results)?.slice(0, 24000) };
  } catch (err) {
    const s = err.response?.status;
    throw new Error(s === 401 || s === 403 ? `HTTP ${s} — the token was rejected or its admin profile cannot read interfaces` : s === 404 ? '404 — this FortiOS has no such endpoint' : err.code === 'ECONNABORTED' ? 'no answer within 15 s' : err.message);
  }
}

// ── SNMP ──────────────────────────────────────────────────────────────────

const OID = {
  ifName: '1.3.6.1.2.1.31.1.1.1.1', ifAlias: '1.3.6.1.2.1.31.1.1.1.18', ifHighSpeed: '1.3.6.1.2.1.31.1.1.1.15', ifHCIn: '1.3.6.1.2.1.31.1.1.1.6', ifHCOut: '1.3.6.1.2.1.31.1.1.1.10',
  ifDescr: '1.3.6.1.2.1.2.2.1.2', ifSpeed: '1.3.6.1.2.1.2.2.1.5', ifOper: '1.3.6.1.2.1.2.2.1.8', ifIn: '1.3.6.1.2.1.2.2.1.10', ifOut: '1.3.6.1.2.1.2.2.1.16',
};

/** A walk that keeps the values as they are (an 8-byte Counter64 must not become text). { index → value }. */
function walkValues(session, root, { strict = false } = {}) {
  return new Promise((resolve, reject) => {
    const out = new Map();
    session.subtree(root, 50, (varbinds) => {
      let stop = false;
      for (const vb of varbinds) {
        if (snmp.isVarbindError(vb)) { if (strict) stop = true; continue; }
        out.set(vb.oid.slice(root.length + 1), vb.value);
      }
      return stop;
    }, (err) => (err && strict ? reject(err) : resolve(out)));
  });
}
const text = (v) => (Buffer.isBuffer(v) ? v.toString('utf8').replace(/\0/g, '') : v == null ? null : String(v));
const STATUS = { 1: 'up', 2: 'down', 7: 'down' };

async function readSnmp(device, { session = null } = {}) {
  const s = session || buildSession(device.ip_address, { ...device, snmp_timeout_ms: device.snmp_timeout_ms || 6000 });
  try {
    const opt = (root) => walkValues(s, root).catch(() => new Map());
    const names = await walkValues(s, OID.ifName, { strict: true }).catch(async (e) => {
      const descr = await opt(OID.ifDescr);
      if (!descr.size) throw new Error(/time(d)?[ -]?out/i.test(e.message) ? 'SNMP timeout — check the community or v3 credentials, that SNMP is enabled and that this server may query the device' : e.message);
      return new Map();
    });
    const [descr, alias, hs, speed, oper, hcIn, hcOut] = await Promise.all([opt(OID.ifDescr), opt(OID.ifAlias), opt(OID.ifHighSpeed), opt(OID.ifSpeed), opt(OID.ifOper), opt(OID.ifHCIn), opt(OID.ifHCOut)]);
    const bits64 = hcIn.size > 0;
    const [lowIn, lowOut] = bits64 ? [new Map(), new Map()] : await Promise.all([opt(OID.ifIn), opt(OID.ifOut)]);
    const indexes = [...new Set([...names.keys(), ...descr.keys()])];
    const interfaces = indexes.map((idx) => {
      const mbps = num(Number(hs.get(idx))) > 0 ? Number(hs.get(idx)) : (num(Number(speed.get(idx))) > 0 && Number(speed.get(idx)) < 4294967295 ? Math.round(Number(speed.get(idx)) / 1e6) : null);
      return {
        name: text(names.get(idx)) || text(descr.get(idx)) || `if${idx}`, index: idx, alias: text(alias.get(idx)) || null, status: STATUS[Number(oper.get(idx))] || 'unknown', speedMbps: mbps,
        inOctets: toBig(bits64 ? hcIn.get(idx) : lowIn.get(idx)), outOctets: toBig(bits64 ? hcOut.get(idx) : lowOut.get(idx)), bits: bits64 ? 64 : 32,
      };
    }).filter((i) => i.inOctets !== null || i.outOctets !== null);
    return { method: 'snmp', endpoint: 'IF-MIB', interfaces, raw: interfaces.map((i) => `${i.index}\t${i.name}\t${i.status}\t${i.speedMbps ?? '?'} Mbps\t${i.bits}-bit\tin ${i.inOctets}\tout ${i.outOctets}`).join('\n') };
  } finally { try { s.close(); } catch { /* already closed */ } }
}

/** How a device is read, like the health checks: a FortiGate with a token through its API, a device with SNMP settings through SNMP. */
function methodFor(table, d) {
  if (table === 'routers' && String(d.brand).toLowerCase() === 'fortigate' && d.api_token && d.ip_address) return 'fortigate';
  const hasSnmp = d.snmp_version === '3' ? !!d.snmp_username : !!(d.snmp_community || d.snmp_version);
  return d.ip_address && hasSnmp ? 'snmp' : null;
}

async function readDevice(table, device, hooks = {}) {
  const method = methodFor(table, device);
  if (!method) throw new Error('No way to read this device: a FortiGate needs its API token, anything else needs SNMP settings');
  return method === 'fortigate' ? (hooks.readFortigate || readFortigate)(device) : (hooks.readSnmp || readSnmp)(device);
}

module.exports = { parseFortigateInterfaces, readFortigate, readSnmp, readDevice, methodFor, OID };
