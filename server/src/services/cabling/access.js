'use strict';

// Is the cabling module on, and may this caller use it? Used by the cabling routes and by the dashboard (the Cabling card is
// only offered where the module can be used).

const db = require('../../db/database');
const { parseNetworks, buildMatcher } = require('./networks');

const setting = (key, fallback = '') => db.prepare('SELECT value FROM settings WHERE key = ?').get(key)?.value ?? fallback;
const isEnabled = () => !['false', '0', 'off'].includes(String(setting('cabling_enabled', 'true')).toLowerCase());
const networks = () => parseNetworks(setting('cabling_allowed_networks'));

function isAllowed(req) {
  const list = networks();
  if (!list.length) return true;
  try { return buildMatcher(list)(req.ip); } catch { return true; } // a broken stored list must not lock everyone out
}

module.exports = { setting, isEnabled, networks, isAllowed };
