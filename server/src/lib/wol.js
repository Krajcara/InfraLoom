'use strict';

const dgram = require('dgram');

function buildMagicPacket(mac) {
  const macBytes = mac
    .split(/[:-]/)
    .map((b) => parseInt(b, 16));
  if (macBytes.length !== 6 || macBytes.some((b) => Number.isNaN(b))) {
    throw new Error(`Invalid MAC address: ${mac}`);
  }
  const packet = Buffer.alloc(6 + 16 * 6);
  packet.fill(0xff, 0, 6);
  for (let i = 0; i < 16; i++) {
    Buffer.from(macBytes).copy(packet, 6 + i * 6);
  }
  return packet;
}

function sendWol(mac, broadcastAddr = '255.255.255.255', port = 9) {
  return new Promise((resolve, reject) => {
    let packet;
    try {
      packet = buildMagicPacket(mac);
    } catch (err) {
      return reject(err);
    }
    const socket = dgram.createSocket('udp4');
    socket.bind(() => {
      socket.setBroadcast(true);
      socket.send(packet, 0, packet.length, port, broadcastAddr, (err) => {
        socket.close();
        if (err) return reject(err);
        resolve();
      });
    });
  });
}

module.exports = { sendWol };
