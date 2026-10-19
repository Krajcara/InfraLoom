'use strict';

const express = require('express');
const { requireAuth, requireRole } = require('../middleware/auth');
const { writeAuditLog } = require('../middleware/audit');
const config = require('../services/dmarc/config');
const service = require('../services/dmarc/service');

const router = express.Router();
router.use(requireAuth);

const canEdit = requireRole('superadmin', 'admin', 'operator');
const canAdmin = requireRole('superadmin', 'admin');
const audit = (req, action, type, id, details) => writeAuditLog({ user_id: req.user.id, username: req.user.username, action: `dmarc.${action}`, entity_type: type, entity_id: id, module: 'dmarc', details, ip_address: req.ip });

/** Runs a handler (sync or async); bad input becomes a 400, anything else a logged 500. */
const h = (fn) => (req, res) => {
  Promise.resolve().then(() => fn(req, res)).catch((err) => {
    if (err instanceof config.ConfigError) return res.status(400).json({ error: err.message });
    if (err && err.status) return res.status(err.status).json({ error: err.message });
    console.error('[dmarc]', err);
    return res.status(500).json({ error: 'Internal error' });
  });
};
const bad = (message, status = 400) => Object.assign(new Error(message), { status });

const days = (req) => Math.min(Math.max(parseInt(req.query.days, 10) || 30, 1), 730);
const since = (req) => Math.floor(Date.now() / 1000) - days(req) * 86400;
const domain = (req) => (req.query.domain ? String(req.query.domain).toLowerCase().slice(0, 253) : undefined);

// ── reachable while the module is off, so an administrator can switch it on ──

router.get('/status', (req, res) => res.json({ enabled: config.isEnabled() }));

router.get('/settings', canAdmin, (req, res) => res.json(config.publicConfig()));

router.put('/settings', canAdmin, h((req, res) => {
  const keys = config.update(req.body || {});
  service.reload();
  audit(req, 'settings.update', 'dmarc', null, { changed: keys }); // the names of the settings only, never the secret
  res.json(config.publicConfig());
}));

// everything below needs the module switched on
router.use((req, res, next) => {
  if (!config.isEnabled()) return res.status(404).json({ error: 'The DMARC module is switched off (Settings → DMARC)' });
  next();
});

router.get('/summary', h((req, res) => {
  const st = service.getStore();
  res.json({
    days: days(req),
    ...st.summary(since(req), domain(req)),
    sync: {
      enabled: !!service.graph(),
      mailbox: service.graph()?.mailbox ?? null,
      running: service.ingestor().isRunning(),
      lastSync: st.getState('last_sync'),
      lastResult: JSON.parse(st.getState('last_sync_result') || 'null'),
      lastError: st.getState('last_sync_error') || null,
      pollMinutes: service.state().cfg.pollMinutes,
    },
  });
}));

// the dashboard card: the last 30 days
router.get('/dashboard', h((req, res) => {
  const st = service.getStore();
  res.json({ ...st.dashboard(Math.floor(Date.now() / 1000) - 30 * 86400), sync_enabled: !!service.graph(), last_error: st.getState('last_sync_error') || null, last_sync: st.getState('last_sync') });
}));

router.get('/reports', h((req, res) => {
  const limit = Math.min(parseInt(req.query.limit, 10) || 100, 500);
  const offset = Math.max(parseInt(req.query.offset, 10) || 0, 0);
  res.json(service.getStore().listReports({ sinceTs: since(req), limit, offset, domain: domain(req) }));
}));

router.get('/reports/:id', h((req, res) => {
  const r = service.getStore().getReport(Number(req.params.id));
  if (!r) throw bad('Report not found', 404);
  res.json(r);
}));

router.get('/reports/:id/xml', h((req, res) => {
  const r = service.getStore().getReport(Number(req.params.id));
  if (!r?.raw_xml) throw bad('The original XML is not stored for this report', 404);
  res.type('application/xml').send(r.raw_xml);
}));

router.get('/messages', h((req, res) => res.json(service.getStore().recentMessages(100))));

// ── what the operators do ──

const approval = (kind) => h((req, res) => {
  const st = service.getStore();
  const b = req.body || {};
  const key = kind === 'group' ? b.name : b.ip;
  if (typeof key !== 'string' || !key) throw bad(kind === 'group' ? 'name is required' : 'ip is required');
  const cur = kind === 'group' ? st.getGroup(key) : st.getSource(key);
  if (!cur) throw bad(kind === 'group' ? 'Sender group not found' : 'Source not found', 404);
  if (b.approved !== undefined && typeof b.approved !== 'boolean') throw bad('approved must be true or false');
  if (b.note !== undefined && (typeof b.note !== 'string' || b.note.length > 200)) throw bad('note must be text of at most 200 characters');
  const change = { approved: b.approved, note: b.note };
  if (kind === 'group') st.updateGroup(key, change); else st.updateSource(key, change);
  audit(req, `${kind}.update`, `dmarc_${kind}`, null, { [kind === 'group' ? 'name' : 'ip']: key, approved: b.approved, note: b.note });
  res.json(kind === 'group' ? st.getGroup(key) : st.getSource(key));
});
router.patch('/groups', canEdit, approval('group'));
router.patch('/sources', canEdit, approval('source'));

router.post('/sync', canEdit, h(async (req, res) => {
  let r;
  try { r = await service.ingestor().syncMailbox(); } catch (e) { throw bad(e.message, 502); }
  audit(req, 'sync', 'dmarc', null, r);
  res.json(r);
}));

// a manual import: the body is the file itself (.xml, .zip or .gz), its name in the X-Filename header
router.post('/upload', canEdit, express.raw({ type: () => true, limit: '20mb' }), h(async (req, res) => {
  let name = 'upload.xml';
  try { name = decodeURIComponent(req.get('X-Filename') || name).slice(0, 200); } catch { /* keep the default */ }
  if (!Buffer.isBuffer(req.body) || !req.body.length) throw bad('The file is empty');
  let r;
  try { r = await service.ingestor().ingestBuffer(req.body, name, { origin: 'upload' }, { quiet: true }); } catch (e) { throw bad(e.message); }
  if (!r.reports && !r.duplicates) throw bad('No DMARC report was found in the file (expected .xml, .zip or .gz with a DMARC aggregate report)');
  await service.ingestor().dispatch(r.alerts);
  audit(req, 'upload', 'dmarc', null, { file: name, reports: r.reports, duplicates: r.duplicates });
  res.json({ file: name, reports: r.reports, duplicates: r.duplicates, records: r.records, alerts: r.alerts.length });
}));

router.post('/test-graph', canAdmin, h(async (req, res) => {
  const g = service.graph();
  if (!g) throw bad('Microsoft Graph is not set up: tenant ID, client ID, client secret and mailbox are all needed (save them first)');
  try { res.json(await g.test()); } catch (e) { throw bad(e.message, 502); }
}));

module.exports = router;
