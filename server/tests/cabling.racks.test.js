'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { startServer, clientsFor } = require('./_helpers');

let srv; let c;
test.before(async () => { srv = await startServer(); c = await clientsFor(srv); });
test.after(() => srv?.stop());

const A = '/api/cabling';
const id = {};
const racksOf = async () => (await c.viewer.get(`${A}/rooms/${id.room}`)).body.racks;

test('a rack is numbered from the bottom unless it says otherwise', async () => {
  id.room = (await c.admin.post(`${A}/rooms`, { name: 'TS-1' })).body.room.id;
  const plain = await c.operator.post(`${A}/rooms/${id.room}/racks`, { name: 'R1', height_u: 42 });
  assert.equal(plain.status, 201); assert.equal(plain.body.rack.units_from_top, 0); id.r1 = plain.body.rack.id;
  const top = await c.operator.post(`${A}/rooms/${id.room}/racks`, { name: 'R2', height_u: 24, units_from_top: true });
  assert.equal(top.body.rack.units_from_top, 1); id.r2 = top.body.rack.id;
  assert.deepEqual((await racksOf()).map((r) => [r.name, r.units_from_top]), [['R1', 0], ['R2', 1]]);
  assert.equal((await c.viewer.post(`${A}/rooms/${id.room}/racks`, { name: 'R3', units_from_top: true })).status, 403);
});

test('the direction can be changed later, and an edit that does not mention it keeps it', async () => {
  assert.equal((await c.operator.put(`${A}/racks/${id.r1}`, { units_from_top: true })).body.rack.units_from_top, 1);
  assert.equal((await c.operator.put(`${A}/racks/${id.r1}`, { name: 'R1b' })).body.rack.units_from_top, 1, 'renaming does not reset it');
  assert.equal((await c.operator.put(`${A}/racks/${id.r1}`, { units_from_top: false, name: 'R1' })).body.rack.units_from_top, 0);
  assert.equal((await c.viewer.put(`${A}/racks/${id.r1}`, { units_from_top: true })).status, 403);
});

test('the numbers are the ones on the rack: overlaps, height and limits work the same either way', async () => {
  const put = (rack, name, pos, h) => c.operator.post(`${A}/devices`, { name, device_type: 'server', room_id: id.room, rack_id: rack, rack_position: pos, height_u: h });
  for (const [rack, label] of [[id.r1, 'bottom'], [id.r2, 'top']]) {
    assert.equal((await put(rack, `A-${label}`, 1, 2)).status, 201, `${label}: U1–U2`);
    const clash = await put(rack, `B-${label}`, 2, 1);
    assert.equal(clash.status, 409); assert.match(clash.body.error, /U2 in R\d is taken by A-/);
    assert.equal((await put(rack, `C-${label}`, 3, 1)).status, 201);
  }
  const over = await put(id.r2, 'D-top', 24, 2);
  assert.equal(over.status, 400); assert.match(over.body.error, /only 24 U high: a 2 U device at U24 would reach U25/);
  // flipping the direction keeps the numbers (they are labels), so nothing becomes invalid
  assert.equal((await c.operator.put(`${A}/racks/${id.r2}`, { units_from_top: false })).status, 200);
  const dev = (await c.viewer.get(`${A}/devices?q=A-top`)).body.devices[0];
  assert.equal(dev.rack_position, 1); assert.equal(dev.height_u, 2);
  const log = JSON.stringify((await c.admin.get('/api/audit-log?limit=100')).body);
  assert.ok(log.includes('cabling.rack.update') && log.includes('units_from_top'));
});
