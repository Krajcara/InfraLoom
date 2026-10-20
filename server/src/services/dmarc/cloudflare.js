'use strict';

// A minimal read-only Cloudflare API client: the list of zones (the domains) and the DMARC record of each.
// An API token with Zone → Zone → Read, and Zone → DNS → Read for the records. Nothing is ever written.

const BASE = 'https://api.cloudflare.com/client/v4';
const TIMEOUT_MS = 30_000;
const MAX_ZONES = 500;

class CloudflareError extends Error {
  constructor(message, { status = null, permission = false } = {}) { super(message); this.status = status; this.permission = permission; }
}

function createCloudflareClient({ token, baseUrl = process.env.DMARC_CLOUDFLARE_BASE_URL || BASE, logger = console }) {
  if (!token) throw new CloudflareError('Cloudflare: an API token is needed');

  async function request(path, attempt = 0) {
    const res = await fetch(`${baseUrl}${path}`, { headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }, signal: AbortSignal.timeout(TIMEOUT_MS) });
    if (res.status === 429 && attempt < 3) {
      const wait = Math.min(parseInt(res.headers.get('Retry-After') || '5', 10) || 5, 60) * 1000;
      logger.warn?.(`[dmarc] Cloudflare is throttling, waiting ${wait / 1000} s`);
      await new Promise((r) => setTimeout(r, process.env.NODE_ENV === 'test' ? 10 : wait));
      return request(path, attempt + 1);
    }
    const body = await res.json().catch(() => ({}));
    if (!res.ok || body.success === false) {
      const first = body.errors?.[0];
      const message = first ? `Cloudflare ${res.status}: ${first.message}${first.code ? ` (code ${first.code})` : ''}` : `Cloudflare ${res.status}`;
      throw new CloudflareError(message, { status: res.status, permission: res.status === 403 });
    }
    return body;
  }

  return {
    /** Every active zone as { id, name }, paged. */
    async listZones() {
      const out = [];
      for (let page = 1; out.length < MAX_ZONES; page++) {
        const body = await request(`/zones?per_page=50&page=${page}&status=active`);
        out.push(...(body.result || []).map((z) => ({ id: z.id, name: String(z.name).toLowerCase() })));
        if (!body.result_info || page >= body.result_info.total_pages || !(body.result || []).length) break;
      }
      return out.slice(0, MAX_ZONES);
    },

    /** What is at _dmarc.<zone>: { txt: [content...], cname: target|null }. */
    async getDmarcRecords(zoneId, zoneName) {
      const body = await request(`/zones/${encodeURIComponent(zoneId)}/dns_records?name=${encodeURIComponent(`_dmarc.${zoneName}`)}&per_page=50`);
      const rows = body.result || [];
      const txt = rows.filter((r) => r.type === 'TXT').map((r) => String(r.content));
      const cname = rows.find((r) => r.type === 'CNAME')?.content ?? null;
      return { txt, cname };
    },

    /** Checks the token: it must be able to list zones. */
    async test() {
      const body = await request('/zones?per_page=1');
      return { ok: true, zones: body.result_info?.total_count ?? (body.result || []).length };
    },
  };
}

module.exports = { createCloudflareClient, CloudflareError, MAX_ZONES };
