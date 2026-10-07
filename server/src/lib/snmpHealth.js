'use strict';

// CPU, memory, disk, temperature and interface links of any SNMP device, read from the standard HOST-RESOURCES-MIB and
// IF-MIB, plus the MikroTik health sensors (MIKROTIK-MIB) where the device has them. Built for MikroTik RouterOS, but
// nothing here is MikroTik-only: Cisco, HP, Linux net-snmp and most others answer the same standard objects.

const { buildSession, snmpGet, snmpWalk } = require('./snmpGeneric');

const OID = {
  sysDescr: '1.3.6.1.2.1.1.1.0', sysName: '1.3.6.1.2.1.1.5.0', sysUpTime: '1.3.6.1.2.1.1.3.0',
  hrProcessorLoad: '1.3.6.1.2.1.25.3.3.1.2',
  hrStorageDescr: '1.3.6.1.2.1.25.2.3.1.3', hrStorageUnits: '1.3.6.1.2.1.25.2.3.1.4', hrStorageSize: '1.3.6.1.2.1.25.2.3.1.5', hrStorageUsed: '1.3.6.1.2.1.25.2.3.1.6',
  ifName: '1.3.6.1.2.1.31.1.1.1.1', ifAdmin: '1.3.6.1.2.1.2.2.1.7', ifOper: '1.3.6.1.2.1.2.2.1.8',
  mtxrHealth: '1.3.6.1.4.1.14988.1.1.3', mtxrVersion: '1.3.6.1.4.1.14988.1.1.4.4.0',
};
// MIKROTIK-MIB mtxrHealth: the temperature objects and the supply voltage
const MTXR_TEMPS = ['5', '6', '7', '10', '11'];
const MTXR_VOLTAGE = '8';

const lastIndex = (oid, root) => oid.slice(root.length + 1);
// null / undefined / '' must stay null — Number(null) is 0, which would turn a missing sensor into "0 °C".
const numOrNull = (v) => {
  if (v === null || v === undefined || typeof v === 'boolean') return null;
  if (typeof v === 'number') return Number.isFinite(v) ? v : null;
  if (typeof v === 'string' && v.trim() !== '' && Number.isFinite(Number(v))) return Number(v);
  return null;
};

/** RouterOS reports temperatures in tenths of a degree; anything above 150 can only be tenths. */
const celsius = (v) => { const n = numOrNull(v); return n === null ? null : n > 150 ? n / 10 : n; };

const MEMORY_RE = /^(main|physical|real)?\s*memory$|^ram$|^physical memory/i;
const NOT_MEMORY_RE = /virtual|swap|cache|buffer|shared/i;
const NOT_DISK_RE = /memory|swap|cache|buffer|virtual|^ram|shared|tmpfs|^\/(dev|run|sys|proc)/i;

function parseStorage(descr, units, size, used) {
  const items = [];
  for (const d of descr) {
    const i = lastIndex(d.oid, OID.hrStorageDescr);
    const u = numOrNull(units.get(i)), s = numOrNull(size.get(i)), us = numOrNull(used.get(i));
    if (!d.value || !(s > 0) || us === null) continue;
    items.push({ name: String(d.value).trim(), pct: Math.round((us / s) * 1000) / 10, used_bytes: u ? us * u : null, total_bytes: u ? s * u : null });
  }
  const memory = items.find((x) => MEMORY_RE.test(x.name) && !NOT_MEMORY_RE.test(x.name)) || null;
  const disks = items.filter((x) => x !== memory && !NOT_DISK_RE.test(x.name));
  return { memory, disks };
}

async function readSnmpHealth(host, cfg) {
  const session = buildSession(host, { ...cfg, snmp_timeout_ms: cfg.snmp_timeout_ms || 6000 });
  try {
    const sys = await snmpGet(session, [OID.sysDescr, OID.sysName, OID.sysUpTime]);
    if (sys[OID.sysDescr] === undefined && sys[OID.sysName] === undefined) {
      throw new Error('SNMP timeout — check the community / v3 credentials, that SNMP is enabled on the device and that this server is allowed to query it');
    }
    const walk = (oid) => snmpWalk(session, oid, { strict: true });
    const optional = (p) => p.catch(() => []); // an object the device does not have is not an error

    const load = await optional(walk(OID.hrProcessorLoad));
    const loads = load.map((r) => numOrNull(r.value)).filter((v) => v !== null);
    const [descr, units, size, used] = [await optional(walk(OID.hrStorageDescr)), await optional(walk(OID.hrStorageUnits)), await optional(walk(OID.hrStorageSize)), await optional(walk(OID.hrStorageUsed))];
    const mapOf = (rows, root) => new Map(rows.map((r) => [lastIndex(r.oid, root), r.value]));
    const storage = parseStorage(descr, mapOf(units, OID.hrStorageUnits), mapOf(size, OID.hrStorageSize), mapOf(used, OID.hrStorageUsed));

    const mtx = await optional(walk(OID.mtxrHealth));
    const mtxMap = {};
    for (const r of mtx) mtxMap[lastIndex(r.oid, OID.mtxrHealth)] = r.value;
    const temps = MTXR_TEMPS.map((n) => celsius(mtxMap[`${n}.0`])).filter((v) => v !== null && v > -40 && v < 150);
    const voltRaw = numOrNull(mtxMap[`${MTXR_VOLTAGE}.0`]);

    const ver = (await snmpGet(session, [OID.mtxrVersion]))[OID.mtxrVersion];
    const [ifNames, ifOper, ifAdmin] = [await optional(walk(OID.ifName)), await optional(walk(OID.ifOper)), await optional(walk(OID.ifAdmin))];
    const oper = mapOf(ifOper, OID.ifOper), admin = mapOf(ifAdmin, OID.ifAdmin);
    const interfaces = ifNames.map((r) => {
      const i = lastIndex(r.oid, OID.ifName);
      return { name: String(r.value).trim(), oper: numOrNull(oper.get(i)) === 1 ? 'up' : 'down', admin: numOrNull(admin.get(i)) === 2 ? 'down' : 'up' };
    }).filter((i) => i.name);

    session.close();
    const ticks = numOrNull(sys[OID.sysUpTime]);
    return {
      method: 'snmp',
      sys: { description: sys[OID.sysDescr] ? String(sys[OID.sysDescr]) : null, name: sys[OID.sysName] ? String(sys[OID.sysName]) : null, uptime_s: ticks === null ? null : Math.floor(ticks / 100) },
      cpu: loads.length ? Math.round(loads.reduce((a, b) => a + b, 0) / loads.length) : null,
      cores: loads.length,
      memory: storage.memory,
      disks: storage.disks,
      temperature: temps.length ? Math.max(...temps) : null,
      voltage: voltRaw === null ? null : voltRaw > 100 ? voltRaw / 10 : voltRaw,
      version: ver ? String(ver) : null,
      interfaces,
      raw: { sysDescr: sys[OID.sysDescr] ?? null, mikrotik_health: mtxMap, mikrotik_version: ver ?? null, storage: [...(storage.memory ? [storage.memory] : []), ...storage.disks], cpu_loads: loads, interface_count: interfaces.length },
    };
  } catch (err) {
    try { session.close(); } catch { /* already closed */ }
    throw err;
  }
}

module.exports = { readSnmpHealth, parseStorage, celsius, OID };
