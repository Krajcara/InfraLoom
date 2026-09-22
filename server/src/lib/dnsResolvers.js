'use strict';

// Curated public DNS resolvers for the MyIP DNS Resolver tool.
// Each entry needs at least one of udp / doh.
const DNS_RESOLVERS = [
  { id: 'google', name: 'Google', country: 'US', udp: '8.8.8.8', doh: 'https://dns.google/resolve?' },
  { id: 'cloudflare', name: 'Cloudflare', country: 'US', udp: '1.1.1.1', doh: 'https://cloudflare-dns.com/dns-query?ct=application/dns-json&' },
  { id: 'opendns', name: 'OpenDNS', country: 'US', udp: '208.67.222.222' },
  { id: 'controld', name: 'ControlD', country: 'CA', udp: '76.76.2.0' },
  { id: 'dns4eu', name: 'DNS4EU', country: 'EU', udp: '86.54.11.1' },
  { id: 'dnssb', name: 'DNS.SB', country: 'EU', udp: '185.222.222.222', doh: 'https://doh.dns.sb/dns-query?' },
  { id: 'quad9', name: 'Quad9', country: 'CH', udp: '9.9.9.9' },
  { id: 'cznic', name: 'CZ.NIC ODVR', country: 'CZ', udp: '193.17.47.1' },
  { id: 'adguard', name: 'AdGuard', country: 'CY', udp: '94.140.14.14', doh: 'https://dns.adguard.com/resolve?' },
  { id: 'yandex', name: 'Yandex.DNS', country: 'RU', udp: '77.88.8.8' },
  { id: 'skydns', name: 'SkyDNS', country: 'RU', udp: '193.58.251.251' },
  { id: 'alidns', name: 'AliDNS', country: 'CN', udp: '223.5.5.5', doh: 'https://dns.alidns.com/resolve?' },
  { id: 'dnspod', name: 'DNSPod', country: 'CN', udp: '119.29.29.29' },
  { id: '114dns', name: '114DNS', country: 'CN', udp: '114.114.114.114' },
  { id: 'hinet', name: 'HiNet', country: 'TW', udp: '168.95.1.1' },
  { id: 'giga', name: 'GIGA', country: 'TW', udp: '203.133.1.6' },
  { id: 'kt', name: 'KT', country: 'KR', udp: '168.126.63.1' },
];

const NAME_VALUED_TYPES = new Set(['CNAME', 'NS']);
const DNS_RECORD_TYPES = ['A', 'AAAA', 'CNAME', 'MX', 'NS', 'TXT', 'SOA', 'CAA'];

module.exports = { DNS_RESOLVERS, NAME_VALUED_TYPES, DNS_RECORD_TYPES };
