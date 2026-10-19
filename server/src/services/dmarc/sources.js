'use strict';

// PTR lookup and recognising the provider from the host name.

const dns = require('node:dns/promises');

const PROVIDERS = [
  [/\.(protection\.)?outlook\.com$/i, 'Microsoft 365'],
  [/\.(google|googlemail)\.com$/i, 'Google'],
  [/\.amazonses\.com$/i, 'Amazon SES'],
  [/\.sendgrid\.net$/i, 'SendGrid'],
  [/\.mailgun\.(net|org)$/i, 'Mailgun'],
  [/\.(mcsv|rsgsv|mcdlv)\.net$/i, 'Mailchimp'],
  [/\.sparkpostmail\.com$/i, 'SparkPost'],
  [/\.(mtasv|postmarkapp)\.net$|\.postmarkapp\.com$/i, 'Postmark'],
  [/\.mailjet\.com$/i, 'Mailjet'],
  [/\.zoho\.(com|eu)$/i, 'Zoho'],
  [/\.yahoo\.(com|net)$/i, 'Yahoo'],
];

function classifyProvider(ptr) {
  if (!ptr) return null;
  for (const [re, name] of PROVIDERS) if (re.test(ptr)) return name;
  // fallback: the registered domain of the PTR (mail.firma.rs → firma.rs)
  const parts = ptr.replace(/\.$/, '').split('.');
  return parts.length >= 2 ? parts.slice(-2).join('.') : null;
}

function expandIPv6(ip) {
  const [head, tail] = ip.split('::');
  const h = head ? head.split(':') : [];
  const t = tail !== undefined && tail ? tail.split(':') : [];
  if (tail === undefined && h.length !== 8) return null;
  const fill = Array(8 - h.length - t.length).fill('0');
  return [...h, ...fill, ...t].map((x) => x.toLowerCase().replace(/^0+(?=.)/, ''));
}

/** The group of an address: the provider from the PTR, or without a PTR the network prefix (IPv4 /24, IPv6 /48). */
function sourceGroup(ip, ptr) {
  const provider = classifyProvider(ptr);
  if (provider) return provider;
  if (ip.includes(':')) {
    const full = expandIPv6(ip);
    return full ? `${full.slice(0, 3).join(':')}::/48` : ip;
  }
  return ip.split('.').slice(0, 3).join('.') + '.0/24';
}

/** PTR name of an address, or null. `DMARC_PTR_LOOKUP=false` turns the lookup off (everything is then grouped by prefix). */
async function reverseLookup(ip, timeoutMs = 3000) {
  if (/^(0|false|no|off)$/i.test(process.env.DMARC_PTR_LOOKUP || '')) return null;
  try {
    let timer;
    const names = await Promise.race([
      dns.reverse(ip),
      new Promise((_, rej) => { timer = setTimeout(() => rej(new Error('timeout')), timeoutMs); }),
    ]).finally(() => clearTimeout(timer));
    return names?.[0] ?? null;
  } catch {
    return null;
  }
}

module.exports = { classifyProvider, sourceGroup, reverseLookup, expandIPv6 };
