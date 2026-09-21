'use strict';

// Schema creation happens as a side effect of requiring database.js
// (CREATE TABLE IF NOT EXISTS ...), so simply loading it is enough to
// bring an existing database up to date with the current base schema.
// Later phases append their own CREATE TABLE IF NOT EXISTS blocks here
// or in their own service modules — never destructive ALTER/DROP without
// an explicit, reviewed migration step.

require('dotenv').config({ path: require('path').join(__dirname, '../../../.env') });
const db = require('./database');

console.log('[migrate] Schema is up to date.');
db.close();
