'use strict';

const { buildSession, snmpWalk } = require('./snmpGeneric');

// Standard UPS-MIB (RFC 1628) — implemented by most UPS network cards
// (APC, Eaton, Riello, Legrand, CyberPower, Mustek, ...). The APC PowerNet
// tree is a fallback for cards that only expose the vendor MIB.
const RFC1628 = '1.3.6.1.2.1.33.1';
const APC = '1.3.6.1.4.1.318.1.1.1';
const SYS = { descr: '1.3.6.1.2.1.1.1.0', name: '1.3.6.1.2.1.1.5.0', uptime: '1.3.6.1.2.1.1.3.0' };

const BATTERY_STATUS = { 1: 'unknown', 2: 'normal', 3: 'low', 4: 'depleted' };
const OUTPUT_SOURCE = { 1: 'other', 2: 'none', 3: 'normal', 4: 'bypass', 5: 'battery', 6: 'booster', 7: 'reducer' };
// APC upsBasicOutputStatus
const APC_OUTPUT = {
  1: 'unknown', 2: 'normal', 3: 'battery', 4: 'booster', 5: 'none', 6: 'bypass',
  7: 'none', 8: 'none', 9: 'bypass', 10: 'bypass', 11: 'none', 12: 'reducer',
};

/** Finite number or null. Negative -> null for quantities that can't be negative
 * (several cards report -1 for "not available"). */
function num(v, { allowNegative = false } = {}) {
  if (v === null || v === undefined || v === '') return null;
  const n = typeof v === 'number' ? v : Number(v);
  if (!Number.isFinite(n)) return null;
  if (!allowNegative && n < 0) return null;
  return n;
}
const div = (v, d) => (v === null ? null : Math.round((v / d) * 10) / 10);
const pct = (v) => (v === null ? null : Math.max(0, Math.min(100, v)));

function toMap(results, base) {
  const m = new Map();
  const prefix = `${base}.`;
  for (const r of results) if (r.oid.startsWith(prefix)) m.set(r.oid.slice(prefix.length), r.value);
  return m;
}

/** Rows of a table, e.g. prefix '3.3.1.' with cols {2:'frequency',3:'voltage'} */
function tableRows(map, prefix, cols) {
  const rows = {};
  for (const [k, v] of map) {
    if (!k.startsWith(prefix)) continue;
    const [col, line] = k.slice(prefix.length).split('.');
    if (cols[col] && line !== undefined) (rows[line] = rows[line] || { line: Number(line) })[cols[col]] = v;
  }
  return Object.values(rows).sort((a, b) => a.line - b.line);
}

function str(v) {
  const s = v === null || v === undefined ? '' : String(v).trim();
  return s || null;
}

function parseRfc1628(map) {
  const g = (k) => (map.has(k) ? map.get(k) : null);
  const inputLines = tableRows(map, '3.3.1.', { 2: 'frequency', 3: 'voltage' }).map((r) => ({
    line: r.line, frequency_hz: div(num(r.frequency), 10), voltage_v: num(r.voltage),
  }));
  const outputLines = tableRows(map, '4.4.1.', { 2: 'voltage', 3: 'current', 4: 'power', 5: 'load' }).map((r) => ({
    line: r.line, voltage_v: num(r.voltage), current_a: div(num(r.current), 10), power_w: num(r.power), load_pct: pct(num(r.load)),
  }));
  const loads = outputLines.map((l) => l.load_pct).filter((x) => x !== null);
  const powers = outputLines.map((l) => l.power_w).filter((x) => x !== null);
  return {
    source: 'ups-mib',
    manufacturer: str(g('1.1.0')), model: str(g('1.2.0')), firmware: str(g('1.3.0')), name: str(g('1.5.0')),
    battery_status: BATTERY_STATUS[num(g('2.1.0'))] || 'unknown',
    on_battery_seconds: num(g('2.2.0')),
    runtime_min: num(g('2.3.0')),
    charge_pct: pct(num(g('2.4.0'))),
    battery_voltage_v: div(num(g('2.5.0')), 10),
    battery_temp_c: num(g('2.7.0'), { allowNegative: true }),
    input_voltage_v: inputLines[0]?.voltage_v ?? null,
    input_frequency_hz: inputLines[0]?.frequency_hz ?? null,
    input_lines: inputLines,
    output_source: OUTPUT_SOURCE[num(g('4.1.0'))] || 'unknown',
    output_voltage_v: outputLines[0]?.voltage_v ?? null,
    output_frequency_hz: div(num(g('4.2.0')), 10),
    output_current_a: outputLines[0]?.current_a ?? null,
    output_power_w: powers.length ? powers.reduce((a, b) => a + b, 0) : null,
    output_load_pct: loads.length ? Math.max(...loads) : null,
    output_lines: outputLines,
    alarms: num(g('6.1.0')),
    replace_battery: null,
  };
}

function parseApc(map) {
  const g = (k) => (map.has(k) ? map.get(k) : null);
  const ticksToMin = (t) => (t === null ? null : Math.round(t / 6000)); // TimeTicks, 1/100 s
  const basicBattery = num(g('2.1.1.0'));
  const outputStatus = num(g('4.1.1.0'));
  const replace = num(g('2.2.4.0'));
  return {
    source: 'apc-powernet',
    manufacturer: 'APC', model: str(g('1.1.1.0')), firmware: str(g('1.2.1.0')), name: str(g('1.1.2.0')),
    battery_status: basicBattery === 3 ? 'low' : basicBattery === 2 ? 'normal' : 'unknown',
    on_battery_seconds: num(g('2.1.2.0')) === null ? null : Math.round(num(g('2.1.2.0')) / 100),
    runtime_min: ticksToMin(num(g('2.2.3.0'))),
    charge_pct: pct(num(g('2.2.1.0'))),
    battery_voltage_v: num(g('2.2.8.0')),
    battery_temp_c: num(g('2.2.2.0'), { allowNegative: true }),
    input_voltage_v: num(g('3.2.1.0')),
    input_frequency_hz: num(g('3.2.4.0')),
    input_lines: [],
    output_source: APC_OUTPUT[outputStatus] || 'unknown',
    output_voltage_v: num(g('4.2.1.0')),
    output_frequency_hz: num(g('4.2.2.0')),
    output_current_a: num(g('4.2.4.0')),
    output_power_w: null,
    output_load_pct: pct(num(g('4.2.3.0'))),
    output_lines: [],
    alarms: null,
    replace_battery: replace === 2 ? true : replace === 1 ? false : null,
  };
}

/** online | on_battery | low_battery | bypass | off.
 * Only an UPS that is actually running its load from the battery counts as
 * on_battery/low_battery. A low battery while mains is present (e.g. still
 * recharging after an outage) stays "online" — the reading carries
 * battery_status so the UI can flag it, but it isn't a power-failure event. */
function deriveStatus(r) {
  if (r.output_source === 'battery') return r.battery_status === 'low' || r.battery_status === 'depleted' ? 'low_battery' : 'on_battery';
  if (r.output_source === 'none') return 'off';
  if (r.output_source === 'bypass') return 'bypass';
  return 'online';
}

function explain(err) {
  const m = String((err && err.message) || err);
  if (/timed out|timeout/i.test(m)) {
    return 'No SNMP response (timeout) — check the IP and port, that SNMP is enabled on the UPS network card, that the InfraLoom server is allowed to query it, and the community string / SNMPv3 credentials.';
  }
  return `SNMP error: ${m}`;
}

function getStrict(session, oids) {
  return new Promise((resolve, reject) => {
    session.get(oids, (err, varbinds) => {
      if (err) return reject(err);
      const out = {};
      varbinds.forEach((vb, i) => {
        if (vb && !require('net-snmp').isVarbindError(vb)) {
          out[oids[i]] = Buffer.isBuffer(vb.value) ? vb.value.toString('utf8').replace(/\0/g, '') : vb.value;
        }
      });
      resolve(out);
    });
  });
}

function closeQuietly(session) {
  try { session.close(); } catch { /* already closed */ }
}

/** Reads one UPS. Throws an Error with a human-readable message on failure.
 * Walks the whole subtree instead of GETting named OIDs: in SNMPv1 a single
 * missing OID fails the entire GET, and UPS cards differ in which optional
 * objects they implement. */
async function readUps(host, cfg) {
  const session = buildSession(host, { ...cfg, snmp_timeout_ms: cfg.snmp_timeout_ms || 5000 });
  return withDeadline(readUpsOn(session, cfg), session, cfg.snmp_deadline_ms || 30000);
}

/** Whole-poll deadline. Individual SNMP requests time out on their own, but a
 * misbehaving embedded agent can keep a walk going indefinitely — and a poll
 * that never returns would also wedge that UPS's in-flight guard forever. */
function withDeadline(work, session, ms) {
  let timer;
  const deadline = new Promise((_, reject) => {
    timer = setTimeout(() => {
      closeQuietly(session);
      reject(new Error(`SNMP polling did not finish within ${Math.round(ms / 1000)}s — the device is answering oddly. Use "SNMP walk" to see what it returns.`));
    }, ms);
  });
  return Promise.race([work, deadline]).finally(() => {
    clearTimeout(timer);
    closeQuietly(session);
  });
}

async function readUpsOn(session, cfg) {
  {
    let sys;
    try {
      sys = await getStrict(session, [SYS.descr, SYS.name, SYS.uptime]);
    } catch (err) {
      throw new Error(explain(err));
    }

    let reading = null;
    try {
      const std = toMap(await snmpWalk(session, RFC1628, { strict: true }), RFC1628);
      if (std.size) reading = parseRfc1628(std);
      if (reading && reading.charge_pct === null && reading.output_source === 'unknown' && reading.input_voltage_v === null) reading = null; // present but empty
    } catch (err) {
      throw new Error(explain(err));
    }
    if (!reading) {
      try {
        const apc = toMap(await snmpWalk(session, APC, { strict: true }), APC);
        if (apc.size) reading = parseApc(apc);
      } catch (err) {
        throw new Error(explain(err));
      }
    }
    if (!reading) {
      const e = new Error('The device answers SNMP but exposes neither the standard UPS-MIB (1.3.6.1.2.1.33) nor APC PowerNet. Use "SNMP walk" to see what it provides.');
      e.unsupported = true; // reachable and answering — so not an outage, just not a layout we can read yet
      throw e;
    }

    const upTicks = num(sys[SYS.uptime]);
    return {
      ...reading,
      sys_descr: str(sys[SYS.descr]),
      sys_name: str(sys[SYS.name]),
      sys_uptime_s: upTicks === null ? null : Math.round(upTicks / 100),
      status: deriveStatus(reading),
    };
  }
}

/** Raw subtree dump for diagnosing a UPS whose layout isn't recognised. */
async function walkRaw(host, cfg, rootOid, limit = 500) {
  const session = buildSession(host, { ...cfg, snmp_timeout_ms: cfg.snmp_timeout_ms || 5000 });
  const work = snmpWalk(session, rootOid, { strict: true })
    .then((rows) => ({ total: rows.length, rows: rows.slice(0, limit) }))
    .catch((err) => { throw new Error(explain(err)); });
  return withDeadline(work, session, cfg.snmp_deadline_ms || 30000);
}

module.exports = { readUps, walkRaw, deriveStatus, parseRfc1628, parseApc, toMap, RFC1628, APC };
