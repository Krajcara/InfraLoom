'use strict';

// A minimal Microsoft Graph client: client-credentials sign-in, read-only access to one mailbox.
// No SDK; Node 18+ has fetch. The addresses can be overridden for tests (a fake Graph).

const PostalMime = require('postal-mime');

const GRAPH = 'https://graph.microsoft.com/v1.0';
const LOGIN = 'https://login.microsoftonline.com';
const TIMEOUT_MS = 30_000;
const MAX_ATTACHMENT_BYTES = 10 * 1024 * 1024; // a report is a few hundred KB; bigger attachments are skipped
const MAX_MESSAGE_BYTES = 25 * 1024 * 1024;    // the source of a message that is read to find the files inside an attached message
const MAX_NESTING = 3;                         // messages inside messages

/**
 * The files in the source (MIME) of a message, including those inside messages attached to it (a message in a message in...).
 * Returns { files: [{ name, contentType, buffer }], notes: [text] }.
 */
async function filesFromMime(source, depth = 0) {
  const out = { files: [], notes: [] };
  const mail = await new PostalMime().parse(source);
  for (const a of mail.attachments || []) {
    const buffer = Buffer.from(a.content instanceof ArrayBuffer ? new Uint8Array(a.content) : a.content);
    const name = a.filename || (a.mimeType === 'message/rfc822' ? 'attached message' : 'attachment');
    if (a.mimeType === 'message/rfc822') {
      if (depth >= MAX_NESTING) { out.notes.push(`${name}: messages are nested too deep`); continue; }
      const inner = await filesFromMime(buffer, depth + 1);
      out.files.push(...inner.files); out.notes.push(...inner.notes);
    } else if (buffer.length > MAX_ATTACHMENT_BYTES) {
      out.notes.push(`${name}: ${Math.round(buffer.length / 1048576)} MB, too large`);
    } else {
      out.files.push({ name, contentType: a.mimeType, buffer });
    }
  }
  return out;
}

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

    /**
     * Everything attached to a message that could hold a report: { files: [{ name, contentType, buffer }], notes: [text] }.
     * File attachments are read as they are. Some senders (Google) attach the report as a *message* that has the archive inside:
     * for those the source of the message is read (one call, GET .../messages/{id}/$value) and unpacked, however deep the
     * messages are nested. Oversized files are left out, and `notes` says what was skipped or could not be read.
     * `subject` lets a message that looks like a report ("Report domain: ...") be read from its source even when Graph lists no attachment.
     */
    async getAttachments(messageId, { subject = '' } = {}) {
      const id = encodeURIComponent(messageId);
      const data = await (await request(`/users/${mb}/messages/${id}/attachments`)).json();
      const files = []; const notes = [];
      let attachedMessage = false;
      for (const a of data.value || []) {
        const type = a['@odata.type'];
        if (type === '#microsoft.graph.itemAttachment') { attachedMessage = true; continue; }
        if (type === '#microsoft.graph.referenceAttachment') { notes.push(`${a.name}: a link, not a file`); continue; }
        if (type !== '#microsoft.graph.fileAttachment') continue;
        if (a.size > MAX_ATTACHMENT_BYTES) { logger.warn?.(`[dmarc] skipping ${a.name}: ${a.size} bytes`); notes.push(`${a.name}: ${Math.round(a.size / 1048576)} MB, too large`); continue; }
        let buffer;
        if (a.contentBytes) {
          buffer = Buffer.from(a.contentBytes, 'base64');
        } else {
          const raw = await request(`/users/${mb}/messages/${id}/attachments/${encodeURIComponent(a.id)}/$value`);
          buffer = Buffer.from(await raw.arrayBuffer());
        }
        files.push({ name: a.name, contentType: a.contentType, buffer });
      }
      if (attachedMessage || (!files.length && /report\s+domain:/i.test(subject))) {
        try {
          const raw = await request(`/users/${mb}/messages/${id}/$value`);
          const source = Buffer.from(await raw.arrayBuffer());
          if (source.length > MAX_MESSAGE_BYTES) {
            notes.push(`the message is ${Math.round(source.length / 1048576)} MB, too large to unpack`);
          } else {
            const inner = await filesFromMime(source);
            const have = new Set(files.map((f) => `${f.name}:${f.buffer.length}`));
            for (const f of inner.files) if (!have.has(`${f.name}:${f.buffer.length}`)) files.push(f);
            notes.push(...inner.notes);
            if (attachedMessage && !inner.files.length) notes.push('an attached message was read, with no file in it');
          }
        } catch (e) {
          notes.push(`the message source could not be read (${e.message})`);
        }
      }
      return { files, notes };
    },

    /** Checks the settings: sign-in plus reading one message from the mailbox. */
    async test() {
      await getToken();
      const data = await (await request(`/users/${mb}/mailFolders/inbox/messages?$top=1&$select=id,subject,receivedDateTime`)).json();
      return { ok: true, sample: data.value?.[0] ? { subject: data.value[0].subject, received: data.value[0].receivedDateTime } : null };
    },
  };
}

module.exports = { createGraphClient, filesFromMime, MAX_ATTACHMENT_BYTES, MAX_MESSAGE_BYTES };
