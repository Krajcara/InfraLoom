'use strict';

const speakeasy = require('speakeasy');
const qrcode = require('qrcode');

function generateSecret(username) {
  return speakeasy.generateSecret({
    name: `InfraLoom (${username})`,
    length: 20,
  });
}

async function generateQrCodeDataUrl(otpauthUrl) {
  return qrcode.toDataURL(otpauthUrl);
}

function verifyCode(secretBase32, code) {
  return speakeasy.totp.verify({
    secret: secretBase32,
    encoding: 'base32',
    token: code,
    window: 1, // accept 1 step (±30s) of clock drift
  });
}

module.exports = { generateSecret, generateQrCodeDataUrl, verifyCode };
