'use strict';

// A FortiOS log line: optional <priority>, then key=value pairs (values with spaces in double quotes). Other formats (CEF, JSON, RFC 5424) are not read.

/** @returns {{ pri: number|null, fields: object } | null} */
function parseLine(input) {
  let s = Buffer.isBuffer(input) ? input.toString('utf8') : String(input);
  s = s.replace(/\0/g, '').trim();
  if (!s) return null;
  let pri = null;
  const p = /^<(\d{1,3})>/.exec(s);
  if (p) { pri = Number(p[1]); s = s.slice(p[0].length); }
  // a syslog header before the pairs ("Oct 23 11:02:03 FG-100F date=...") is skipped
  const start = s.search(/(?:^|\s)(?:date|logid|type|devname)=/);
  if (start < 0) return null;
  s = s.slice(start).trimStart();

  const fields = {};
  let i = 0; const n = s.length; let count = 0;
  while (i < n && count < 200) {
    while (i < n && s[i] === ' ') i++;
    const eq = s.indexOf('=', i);
    if (eq < 0) break;
    const key = s.slice(i, eq);
    if (!/^[A-Za-z0-9_.-]{1,40}$/.test(key)) { const sp = s.indexOf(' ', i); if (sp < 0) break; i = sp + 1; continue; } // not a key: skip the word
    i = eq + 1;
    let val;
    if (s[i] === '"') {
      let j = i + 1; let out = '';
      while (j < n && s[j] !== '"') { if (s[j] === '\\' && j + 1 < n) { out += s[j + 1]; j += 2; } else { out += s[j]; j++; } }
      val = out; i = j + 1;
    } else {
      let j = i; while (j < n && s[j] !== ' ') j++;
      val = s.slice(i, j); i = j;
    }
    fields[key] = val; count++;
  }
  if (!fields.type && !fields.logid) return null;
  return { pri, fields };
}

/** The time of the event: eventtime (seconds, or nanoseconds) when it is believable, else the time the line arrived. */
function eventSeconds(f, nowSec) {
  const t = f.eventtime ? Number(f.eventtime) : NaN;
  if (Number.isFinite(t) && t > 0) {
    const sec = t > 1e17 ? t / 1e9 : t > 1e14 ? t / 1e6 : t > 1e11 ? t / 1e3 : t;
    if (Math.abs(sec - nowSec) < 86400) return Math.floor(sec);
  }
  return nowSec;
}

module.exports = { parseLine, eventSeconds };
