'use strict';

// A fake Cloudflare: the zone list and the GraphQL analytics, with what a real one answers when it is not allowed, is busy, or does not know a figure.

const http = require('node:http');

const ZONES = [{ id: 'a'.repeat(32), name: 'comdata.rs', status: 'active' }, { id: 'b'.repeat(32), name: 'bizcentar.com', status: 'active' }, { id: 'c'.repeat(32), name: 'ailomera.com', status: 'pending' }];
const NAMES = { [ZONES[0].id]: [['www.comdata.rs', 900], ['mail.comdata.rs', 410], ['autodiscover.comdata.rs', 300], ['_dmarc.comdata.rs', 25]], [ZONES[1].id]: [['bizcentar.com', 700], ['www.bizcentar.com', 650]], [ZONES[2].id]: [['ailomera.com', 40]] };
const SCALE = { [ZONES[0].id]: 3, [ZONES[1].id]: 2, [ZONES[2].id]: 1 };

function startFakeCloudflare({ token = 'cf-token' } = {}) {
  const state = { calls: [], zoneCalls: 0, auth: [], mode: {}, once429: false, authzAll: false, tokenOk: true };
  const server = http.createServer((req, res) => {
    let body = ''; req.on('data', (d) => { body += d; });
    req.on('end', () => {
      const json = (code, obj, headers = {}) => { res.writeHead(code, { 'Content-Type': 'application/json', ...headers }); res.end(JSON.stringify(obj)); };
      state.auth.push(req.headers.authorization);
      if (req.headers.authorization !== `Bearer ${token}` || !state.tokenOk) return json(403, { success: false, errors: [{ code: 9109, message: 'Invalid access token' }] });
      const url = new URL(req.url, 'http://x');
      if (req.method === 'GET' && url.pathname === '/zones') {
        state.zoneCalls += 1; const per = Number(url.searchParams.get('per_page')) || 50; const page = Number(url.searchParams.get('page')) || 1;
        return json(200, { success: true, result: ZONES.slice((page - 1) * per, page * per), result_info: { page, per_page: per, total_pages: Math.ceil(ZONES.length / per) } });
      }
      const one = /^\/zones\/([0-9a-f]{32})$/.exec(url.pathname);
      if (req.method === 'GET' && one) { const z = ZONES.find((x) => x.id === one[1]); return z ? json(200, { success: true, result: z }) : json(404, { success: false, errors: [{ message: 'Zone not found' }] }); }
      if (req.method === 'POST' && url.pathname === '/graphql') {
        if (state.once429) { state.once429 = false; return json(429, { errors: [{ message: 'Too many requests' }] }, { 'Retry-After': '0' }); }
        const { query, variables } = JSON.parse(body); const dim = /dimensions \{ (\w+) \}/.exec(query)?.[1]; const zone = variables.zone;
        state.calls.push({ zone, dim, from: variables.from, to: variables.to, query });
        const fail = state.authzAll ? 'authz' : state.mode[`${zone}|${dim}`] || state.mode[dim];
        if (fail === 'authz') return json(200, { data: null, errors: [{ message: `zone '${zone}' does not have access to the path`, path: ['viewer', 'zones', '0', 'dnsAnalyticsAdaptiveGroups'], extensions: { code: 'authz' } }] });
        if (fail === 'range') return json(200, { data: null, errors: [{ message: 'query time range is too large: the maximum is 7 days', extensions: { code: 'bad_request' } }] });
        if (fail === 'unknown') return json(200, { data: null, errors: [{ message: `unknown field "${dim}"`, extensions: { code: 'bad_request' } }] });
        if (fail === 'empty') return json(200, { data: { viewer: { zones: [] } }, errors: null });
        const k = SCALE[zone] || 1; let rows = [];
        if (dim === 'datetimeHour') {
          const from = Math.floor(new Date(variables.from).getTime() / 3600_000); const to = Math.floor(new Date(variables.to).getTime() / 3600_000);
          for (let h = from; h <= to; h++) rows.push({ count: 10 * k + (h % 5), dimensions: { datetimeHour: new Date(h * 3600_000).toISOString().replace('.000Z', 'Z') } });
        } else if (dim === 'queryName') rows = (NAMES[zone] || []).map(([n, c]) => ({ count: c, dimensions: { queryName: n } }));
        else if (dim === 'queryType') rows = [['A', 600 * k], ['AAAA', 200 * k], ['MX', 40 * k], ['TXT', 30 * k], ['HTTPS', 0]].map(([t, c]) => ({ count: c, dimensions: { queryType: t } }));
        else if (dim === 'responseCode') rows = [['NOERROR', 850 * k], ['NXDOMAIN', 30 * k], ['SERVFAIL', 2 * k]].map(([t, c]) => ({ count: c, dimensions: { responseCode: t } }));
        else if (dim === 'coloCode') rows = [['FRA', 400 * k], ['VIE', 300 * k], ['PRG', 150 * k]].map(([t, c]) => ({ count: c, dimensions: { coloCode: t } }));
        return json(200, { data: { viewer: { zones: [{ dnsAnalyticsAdaptiveGroups: rows }] } }, errors: null });
      }
      return json(404, { success: false, errors: [{ message: 'not found' }] });
    });
  });
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve({ url: `http://127.0.0.1:${server.address().port}`, state, zones: ZONES, close: () => server.close() })));
}

module.exports = { startFakeCloudflare, ZONES };
