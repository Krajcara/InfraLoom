'use strict';

// Follows cabling from a port to where it ends.
//
// A device port has one side ("front"). A patch-panel or fibre-panel port has two: "front" (patch cords in the room) and
// "rear" (the permanent installation). A trace follows the link on a side, and when it arrives at a panel port it comes out
// of the opposite side and goes on, until it reaches a device port, a wall outlet or an open end.
//
//   switch Gi1/0/3 -- patch cord -- panel port 3 [front|rear] -- permanent cable -- outlet K-02/A -- patch cord -- desktop eth0
//
// The engine works on plain data (no database), so every scenario can be tested and the same code colours all the ports of a room.

const { PANEL_TYPES, FIBER_PORT_TYPES } = require('./catalog');

const MAX_HOPS = 64; // a longer chain is almost certainly a mistake in the data
const opposite = (side) => (side === 'front' ? 'rear' : 'front');

function buildGraph({ ports = [], devices = [], links = [] }) {
  const P = new Map(ports.map((p) => [p.id, p]));
  const D = new Map(devices.map((d) => [d.id, d]));
  const at = new Map(); // "portId:side" -> link
  for (const l of links) {
    // the database guarantees one link per port side; if bad data says otherwise, the first one wins and nothing breaks
    const a = `${l.port_a_id}:${l.side_a}`, b = `${l.port_b_id}:${l.side_b}`;
    if (!at.has(a)) at.set(a, l);
    if (!at.has(b)) at.set(b, l);
  }
  return { P, D, at, status: new Map() };
}

const deviceOf = (g, portId) => g.D.get(g.P.get(portId)?.device_id);
const isPanel = (g, portId) => PANEL_TYPES.includes(deviceOf(g, portId)?.device_type);
const isPatchPanel = (g, portId) => deviceOf(g, portId)?.device_type === 'patch_panel';
const hasOutlet = (g, portId) => { const p = g.P.get(portId); return Boolean(p && (p.outlet_label || p.office_id)); };

/** The link on a port side and the port on its other end, or null. */
function linkAt(g, portId, side) {
  const l = g.at.get(`${portId}:${side}`);
  if (!l) return null;
  const mine = l.port_a_id === portId && l.side_a === side;
  const other = mine ? { port_id: l.port_b_id, side: l.side_b } : { port_id: l.port_a_id, side: l.side_a };
  return { link: l, other };
}

function portNode(g, portId, extra = {}) {
  const p = g.P.get(portId), d = g.D.get(p.device_id) || {};
  return {
    type: 'port', port_id: p.id, port_name: p.name, port_type: p.port_type, speed: p.speed || null, poe: !!p.poe,
    device_id: d.id ?? null, device_name: d.name ?? null, device_type: d.device_type ?? null, model: d.model ?? null,
    room_id: d.room_id ?? null, room_name: d.room_name ?? null, rack_name: d.rack_name ?? null, rack_position: d.rack_position ?? null,
    office_id: d.office_id ?? null, office_name: d.office_name ?? null, panel: PANEL_TYPES.includes(d.device_type), ...extra,
  };
}

const linkEdge = (l) => ({
  type: 'link', link_id: l.id, kind: l.kind, cable_type: l.cable_type || null, color: l.color || null, length_m: l.length_m ?? null, strands: l.strands || null, notes: l.notes || null,
  trunk: l.trunk_cable_id ? { id: l.trunk_cable_id, name: l.trunk_name || null, medium: l.trunk_medium || null, fiber_type: l.trunk_fiber_type || null } : null,
});

// the permanent cable from a panel port's rear to its wall outlet is part of the port, not a link
const installationEdge = (p) => ({ type: 'installation', cable_type: p.rear_cable_type || null, length_m: p.rear_length_m ?? null });
const outletNode = (p) => ({ type: 'outlet', port_id: p.id, office_id: p.office_id ?? null, office_name: p.office_name ?? null, label: p.outlet_label || null });

/** Walks away from a port side; the node of the port itself is not included. Returns the steps and how it ended:
 * 'device' (reached a device port), 'outlet' (reached a wall outlet with nothing plugged in), 'open' (a panel side with no cable), 'loop', 'truncated'. */
function walk(g, portId, side, seen) {
  const steps = [];
  let cur = { port_id: portId, side };
  let end = 'open';
  for (let hop = 0; ; hop++) {
    if (hop >= MAX_HOPS) { end = 'truncated'; break; }
    const p = g.P.get(cur.port_id);
    let atOutlet = false;
    if (cur.side === 'rear' && isPatchPanel(g, cur.port_id) && hasOutlet(g, cur.port_id)) {
      steps.push(installationEdge(p), outletNode(p));
      atOutlet = true;
    }
    const hit = linkAt(g, cur.port_id, cur.side);
    if (!hit) { end = atOutlet ? 'outlet' : 'open'; break; }
    steps.push(linkEdge(hit.link));
    const farKey = `${hit.other.port_id}:${hit.other.side}`;
    if (seen.has(farKey)) { end = 'loop'; break; }
    seen.add(farKey);

    const far = g.P.get(hit.other.port_id);
    if (!far) { end = 'open'; break; }
    if (!isPanel(g, far.id)) { steps.push(portNode(g, far.id)); end = 'device'; break; }
    // arriving at a panel: from the rear side with a wall outlet, the cord came from that outlet
    if (hit.other.side === 'rear' && isPatchPanel(g, far.id) && hasOutlet(g, far.id) && hit.link.kind === 'patch') {
      steps.push(outletNode(far), installationEdge(far));
    }
    steps.push(portNode(g, far.id));
    // ...and the trace comes out of the other side of the same port
    seen.add(`${far.id}:${opposite(hit.other.side)}`);
    cur = { port_id: far.id, side: opposite(hit.other.side) };
  }
  return { steps, end };
}

/** Trace of a port: { start_port_id, steps: [node, edge, node...], ends: [a, b], loop, truncated, complete }.
 * `a` and `b` are the two ends of the chain, in the order of `steps`; the start port is marked is_start. null when the port does not exist. */
function trace(g, portId) {
  if (!g.P.has(portId)) return null;
  const seen = new Set([`${portId}:front`, `${portId}:rear`]);
  const start = portNode(g, portId, { is_start: true });
  const front = walk(g, portId, 'front', seen);
  let steps; let ends;
  if (isPanel(g, portId)) {
    const rear = walk(g, portId, 'rear', seen);
    // from a panel the room side (patch cords, the switch) comes first and the permanent side (outlet, other room) last,
    // so the chain reads the same as when it is traced from the switch
    steps = [...front.steps.reverse(), start, ...rear.steps];
    ends = [front.end, rear.end];
  } else {
    steps = [start, ...front.steps];
    ends = ['device', front.end];
  }
  const good = (e) => e === 'device' || e === 'outlet';
  return { start_port_id: portId, steps, ends, loop: ends.includes('loop'), truncated: ends.includes('truncated'), complete: good(ends[0]) && good(ends[1]) };
}

/** Where does this port go? 'free' | 'outlet' (a wall outlet is recorded but no patch cord is plugged in) | 'office' (leads to a
 * wall outlet) | 'device' (patched straight to another device) | 'fiber' (goes over a trunk or a fibre port). */
function classify(g, portId) {
  if (g.status.has(portId)) return g.status.get(portId);
  const p = g.P.get(portId);
  if (!p) return null;
  let s;
  if (!g.at.has(`${portId}:front`)) {
    s = isPatchPanel(g, portId) && hasOutlet(g, portId) ? 'outlet' : 'free';
  } else {
    const t = trace(g, portId);
    const fiber = t.steps.some((x) => (x.type === 'link' && x.trunk) || (x.type === 'port' && FIBER_PORT_TYPES.includes(x.port_type)));
    const office = t.steps.some((x) => x.type === 'outlet');
    s = fiber ? 'fiber' : office ? 'office' : 'device';
  }
  g.status.set(portId, s);
  return s;
}

/** What is connected on each side of a port, for showing next to it. */
function connections(g, portId) {
  const out = {};
  for (const side of ['front', 'rear']) {
    const hit = linkAt(g, portId, side);
    if (!hit) { out[side] = null; continue; }
    const far = g.P.get(hit.other.port_id);
    const d = far ? g.D.get(far.device_id) : null;
    out[side] = { link_id: hit.link.id, kind: hit.link.kind, other_port_id: hit.other.port_id, other_port_name: far?.name ?? null, other_side: hit.other.side, other_device_id: d?.id ?? null, other_device_name: d?.name ?? null };
  }
  return out;
}

/** Reads everything the engine needs in one go (a few thousand ports is a few milliseconds). */
function loadGraph(db) {
  return buildGraph({
    ports: db.prepare('SELECT p.id, p.device_id, p.name, p.port_type, p.speed, p.poe, p.office_id, p.outlet_label, p.rear_cable_type, p.rear_length_m, o.name AS office_name FROM cab_ports p LEFT JOIN cab_offices o ON o.id = p.office_id').all(),
    devices: db.prepare('SELECT d.id, d.name, d.device_type, d.model, d.room_id, d.rack_position, d.office_id, r.name AS room_name, k.name AS rack_name, o.name AS office_name FROM cab_devices d LEFT JOIN cab_rooms r ON r.id = d.room_id LEFT JOIN cab_racks k ON k.id = d.rack_id LEFT JOIN cab_offices o ON o.id = d.office_id').all(),
    links: db.prepare('SELECT l.*, t.name AS trunk_name, t.medium AS trunk_medium, t.fiber_type AS trunk_fiber_type FROM cab_links l LEFT JOIN cab_trunk_cables t ON t.id = l.trunk_cable_id').all(),
  });
}

module.exports = { MAX_HOPS, buildGraph, loadGraph, trace, classify, connections, linkAt, isPanel, isPatchPanel, hasOutlet, opposite };
