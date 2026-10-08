'use strict';

const { PORT_TYPES, SPEEDS, PORT_ROLES, CONNECTORS, oneOf } = require('./catalog');

const MAX_PORTS_PER_DEVICE = 512;

class InputError extends Error {
  constructor(message, status = 400) { super(message); this.status = status; }
}

/** Checks and normalises port groups { prefix, start_no, end_no, port_type, speed, poe, role, connector }.
 * Throws InputError with a message that says which group is wrong. */
function normalizeGroups(groups) {
  if (!Array.isArray(groups)) throw new InputError('Port groups must be a list');
  const out = groups.map((g, i) => {
    const n = i + 1;
    const prefix = String(g.prefix ?? '').trim();
    if (prefix.length > 20) throw new InputError(`Group ${n}: the prefix can be at most 20 characters`);
    const start = Number(g.start_no), end = Number(g.end_no);
    if (!Number.isInteger(start) || !Number.isInteger(end) || start < 0 || end > 9999) throw new InputError(`Group ${n}: "from" and "to" must be whole numbers between 0 and 9999`);
    if (end < start) throw new InputError(`Group ${n}: "to" cannot be smaller than "from"`);
    if (!oneOf(PORT_TYPES, g.port_type)) throw new InputError(`Group ${n}: unknown port type "${g.port_type}"`);
    const speed = g.speed || null;
    if (speed && !SPEEDS.includes(speed)) throw new InputError(`Group ${n}: unknown speed "${speed}"`);
    const role = g.role || null;
    if (role && !oneOf(PORT_ROLES, role)) throw new InputError(`Group ${n}: unknown role "${role}"`);
    const connector = g.connector || null;
    if (connector && !CONNECTORS.includes(connector)) throw new InputError(`Group ${n}: unknown connector "${connector}"`);
    return { prefix, start_no: start, end_no: end, port_type: g.port_type, speed, poe: g.poe ? 1 : 0, role, connector };
  });
  const total = out.reduce((a, g) => a + (g.end_no - g.start_no + 1), 0);
  if (total > MAX_PORTS_PER_DEVICE) throw new InputError(`That would create ${total} ports; a device can have at most ${MAX_PORTS_PER_DEVICE}`);
  return out;
}

/** Expands groups into individual port rows, numbered after `startOrder` so later additions sort after earlier ones. */
function expandPortGroups(groups, startOrder = 0) {
  const ports = [];
  let order = startOrder;
  for (const g of groups) {
    for (let n = g.start_no; n <= g.end_no; n++) {
      ports.push({ name: `${g.prefix || ''}${n}`, sort_order: ++order, port_type: g.port_type, speed: g.speed || null, poe: g.poe ? 1 : 0, role: g.role || null, connector: g.connector || null });
    }
  }
  return ports;
}

/** Two groups that produce the same name (or a name the device already has) are refused with the names listed. */
function assertNoDuplicateNames(ports, existingNames = []) {
  const seen = new Set(existingNames.map((x) => x.toLowerCase()));
  const dup = new Set();
  for (const p of ports) {
    const k = p.name.toLowerCase();
    if (seen.has(k)) dup.add(p.name);
    seen.add(k);
  }
  if (dup.size) throw new InputError(`Port name(s) already used: ${[...dup].slice(0, 8).join(', ')}${dup.size > 8 ? ', …' : ''}`, 409);
}

function insertPorts(db, deviceId, ports) {
  const stmt = db.prepare(
    `INSERT INTO cab_ports (device_id, name, sort_order, port_type, speed, poe, role, connector)
     VALUES (@device_id, @name, @sort_order, @port_type, @speed, @poe, @role, @connector)`
  );
  for (const p of ports) stmt.run({ ...p, device_id: deviceId });
}

module.exports = { MAX_PORTS_PER_DEVICE, InputError, normalizeGroups, expandPortGroups, assertNoDuplicateNames, insertPorts };
