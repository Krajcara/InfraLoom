'use strict';

// A fake Cloudflare API (zones and DNS records), reading only: it writes down every request, so a test can show that nothing else is ever sent.

const http = require('node:http');

const TOKEN = 'cfT0ken_abcdefghijklmnopqrstuvwxyz0123456789';

function startFakeCloudflare({ zones = [], records = {}, token = TOKEN } = {}) {
  const state = { zones, records, noDns: false, throttleOnce: false, throttled: 0, token };
  const log = [];
  const server = http.createServer((req, res) => {
    const url = new URL(req.url, 'http://x');
    log.push({ method: req.method, path: url.pathname, query: url.search, auth: req.headers.authorization });
    const json = (code, body) => { res.writeHead(code, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(body)); };
    if (req.headers.authorization !== `Bearer ${state.token}`) return json(401, { success: false, errors: [{ code: 1000, message: 'Invalid API Token' }], result: null });
    if (req.method !== 'GET') return json(405, { success: false, errors: [{ code: 1, message: 'read only' }] });
    if (url.pathname === '/zones') {
      if (state.throttleOnce) { state.throttleOnce = false; state.throttled++; res.writeHead(429, { 'Retry-After': '1' }); return res.end(); }
      const per = Number(url.searchParams.get('per_page') || 20); const page = Number(url.searchParams.get('page') || 1);
      const slice = state.zones.slice((page - 1) * per, page * per);
      return json(200, { success: true, errors: [], result: slice, result_info: { page, per_page: per, total_pages: Math.max(1, Math.ceil(state.zones.length / per)), total_count: state.zones.length } });
    }
    const m = /^\/zones\/([^/]+)\/dns_records$/.exec(url.pathname);
    if (m) {
      if (state.noDns) return json(403, { success: false, errors: [{ code: 9109, message: 'Unauthorized to access requested resource' }], result: null });
      const zone = state.zones.find((z) => z.id === m[1]);
      const name = url.searchParams.get('name') || '';
      const rows = zone && name === `_dmarc.${zone.name}` ? (state.records[zone.name] || []) : [];
      return json(200, { success: true, errors: [], result: rows.map((r, i) => ({ id: `r${i}`, name, ...r })), result_info: { page: 1, per_page: 50, total_pages: 1, total_count: rows.length } });
    }
    return json(404, { success: false, errors: [{ code: 7003, message: 'No route' }] });
  });
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve({ url: `http://127.0.0.1:${server.address().port}`, log, state, close: () => server.close() })));
}

const txt = (content) => ({ type: 'TXT', content });

module.exports = { startFakeCloudflare, txt, TOKEN };
