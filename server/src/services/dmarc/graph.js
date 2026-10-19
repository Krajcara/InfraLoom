'use strict';

// A minimal Microsoft Graph client: client-credentials sign-in, read-only access to one mailbox.
// No SDK; Node 18+ has fetch. The addresses can be overridden for tests (a fake Graph).

const GRAPH = 'https://graph.microsoft.com/v1.0';
const LOGIN = 'https://login.microsoftonline.com';
const TIMEOUT_MS = 30_000;
const MAX_ATTACHMENT_BYTES = 10 * 1024 * 1024; // a report is a few hundred KB; bigger attachments are skipped

function createGraphClient({ tenantId, clientId, clientSecret, mailbox, baseUrl = process.env.DMARC_GRAPH_BASE_URL || GRAPH, loginUrl = process.env.DMARC_LOGIN_BASE_URL || LOGIN, logger = console }) {
  if (!tenantId || !clientId || !clientSecret || !mailbox) throw new Error('Graph: tenant ID, client ID, client secret and mailbox are all needed');

  let token = null;
  let tokenExp = 0;

  async function getToken() {
    if (token && Date.now() < tokenExp - 60_000) return token;
    const res = await fetch(`${loginUrl}/${tenantId}/oauth2/v2.0/token`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ client_id: clientId, client_secret: clientSecret, scope: 'https://graph.microsoft.com/.default', grant_type: 'client_credentials' }),
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    const body = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(`Graph sign-in: ${res.status} ${body.error || ''} ${body.error_description?.split('\r\n')[0] || ''}`.trim());
    token = body.access_token;
    tokenExp = Date.now() + body.expires_in * 1000;
    return token;
  }

  async function request(url, attempt = 0) {
    const res = await fetch(url.startsWith('http') ? url : `${baseUrl}${url}`, { headers: { Authorization: `Bearer ${await getToken()}` }, signal: AbortSignal.timeout(TIMEOUT_MS) });

    if ((res.status === 429 || res.status === 503) && attempt < 3) {
      const wait = Math.min((parseInt(res.headers.get('Retry-After') || '5', 10) || 5), 60) * 1000;
      logger.warn?.(`[dmarc] Graph is throttling (${res.status}), waiting ${wait / 1000} s`);
      await new Promise((r) => setTimeout(r, process.env.NODE_ENV === 'test' ? 10 : wait));
      return request(url, attempt + 1);
    }
    if (res.status === 401 && attempt === 0) { token = null; return request(url, 1); } // the token may have expired: try once more
    if (!res.ok) {
      const body = await res.json().catch(() => ({}));
      throw new Error(`Graph ${res.status} ${body?.error?.code || ''}: ${body?.error?.message || url}`.replace(/\s+/g, ' '));
    }
    return res;
  }

  const mb = encodeURIComponent(mailbox);

  return {
    mailbox,

    /** Every Inbox message received from `sinceIso` on (paged). */
    async listMessagesSince(sinceIso, max = 500) {
      const params = new URLSearchParams({
        $filter: `receivedDateTime ge ${sinceIso}`,
        $orderby: 'receivedDateTime asc',
        $select: 'id,subject,from,receivedDateTime,hasAttachments,internetMessageId',
        $top: '50',
      });
      let url = `/users/${mb}/mailFolders/inbox/messages?${params}`;
      const out = [];
      while (url && out.length < max) {
        const data = await (await request(url)).json();
        out.push(...(data.value || []));
        url = data['@odata.nextLink'] || null;
      }
      return out;
    },

    /** File attachments of a message as { name, contentType, buffer }; oversized ones are left out. */
    async getAttachments(messageId) {
      const data = await (await request(`/users/${mb}/messages/${encodeURIComponent(messageId)}/attachments`)).json();
      const files = [];
      for (const a of data.value || []) {
        if (a['@odata.type'] !== '#microsoft.graph.fileAttachment') continue;
        if (a.size > MAX_ATTACHMENT_BYTES) { logger.warn?.(`[dmarc] skipping ${a.name}: ${a.size} bytes`); continue; }
        let buffer;
        if (a.contentBytes) {
          buffer = Buffer.from(a.contentBytes, 'base64');
        } else {
          const raw = await request(`/users/${mb}/messages/${encodeURIComponent(messageId)}/attachments/${encodeURIComponent(a.id)}/$value`);
          buffer = Buffer.from(await raw.arrayBuffer());
        }
        files.push({ name: a.name, contentType: a.contentType, buffer });
      }
      return files;
    },

    /** Checks the settings: sign-in plus reading one message from the mailbox. */
    async test() {
      await getToken();
      const data = await (await request(`/users/${mb}/mailFolders/inbox/messages?$top=1&$select=id,subject,receivedDateTime`)).json();
      return { ok: true, sample: data.value?.[0] ? { subject: data.value[0].subject, received: data.value[0].receivedDateTime } : null };
    },
  };
}

module.exports = { createGraphClient, MAX_ATTACHMENT_BYTES };
