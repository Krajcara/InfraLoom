'use strict';

const express = require('express');
const db = require('../db/database');
const { requireAuth, requireRole } = require('../middleware/auth');
const { writeAuditLog } = require('../middleware/audit');

const router = express.Router();
router.use(requireAuth);

function mapEntraApp(app) {
  const days = app.secret_expiry
    ? Math.ceil((new Date(app.secret_expiry) - new Date()) / 86400000)
    : null;
  return {
    ...app,
    client_secret: app.client_secret ? '***' : null,
    days_until_expiry: days,
    secret_status: days == null ? null : days < 0 ? 'expired' : days <= 30 ? 'expiring' : 'ok',
  };
}

// GET /api/entra-apps
router.get('/', (req, res) => {
  const showHidden = req.query.show_hidden === 'true';
  let q = 'SELECT * FROM entra_apps';
  if (!showHidden) q += ' WHERE hidden = 0';
  q += ' ORDER BY app_name';
  res.json({ apps: db.prepare(q).all().map(mapEntraApp) });
});

// POST /api/entra-apps
router.post('/', requireRole('superadmin', 'admin', 'operator'), (req, res) => {
  const { app_name, app_id, client_secret, secret_expiry, assigned_to, project, notes } = req.body || {};
  if (!app_name?.trim()) return res.status(400).json({ error: 'app_name is required' });

  const r = db
    .prepare(
      `INSERT INTO entra_apps (app_name, app_id, client_secret, secret_expiry, assigned_to, project, notes)
       VALUES (?,?,?,?,?,?,?)`
    )
    .run(app_name.trim(), app_id || null, client_secret || null, secret_expiry || null, assigned_to || null, project || null, notes || null);

  writeAuditLog({
    user_id: req.user.id, username: req.user.username, action: 'entra_app.create',
    entity_type: 'entra_app', entity_id: r.lastInsertRowid, module: 'entra-apps',
    details: { app_name: app_name.trim() }, ip_address: req.ip,
  });

  res.status(201).json({ id: r.lastInsertRowid });
});

// PUT /api/entra-apps/:id
router.put('/:id', requireRole('superadmin', 'admin', 'operator'), (req, res) => {
  const existing = db.prepare('SELECT * FROM entra_apps WHERE id = ?').get(req.params.id);
  if (!existing) return res.status(404).json({ error: 'Not found' });

  const { app_name, app_id, client_secret, secret_expiry, assigned_to, project, notes } = req.body || {};
  if (!app_name?.trim()) return res.status(400).json({ error: 'app_name is required' });

  const newSecret =
    client_secret && client_secret !== '***' && client_secret !== '' ? client_secret : existing.client_secret;

  db.prepare(
    `UPDATE entra_apps SET app_name=?, app_id=?, client_secret=?, secret_expiry=?,
       assigned_to=?, project=?, notes=?, updated_at=datetime('now')
     WHERE id=?`
  ).run(app_name.trim(), app_id || null, newSecret, secret_expiry || null, assigned_to || null, project || null, notes || null, req.params.id);

  writeAuditLog({
    user_id: req.user.id, username: req.user.username, action: 'entra_app.update',
    entity_type: 'entra_app', entity_id: req.params.id, module: 'entra-apps',
    details: { app_name: app_name.trim() }, ip_address: req.ip,
  });

  res.json({ ok: true });
});

// DELETE /api/entra-apps/:id
router.delete('/:id', requireRole('superadmin', 'admin', 'operator'), (req, res) => {
  const a = db.prepare('SELECT app_name FROM entra_apps WHERE id = ?').get(req.params.id);
  if (!a) return res.status(404).json({ error: 'Not found' });
  db.prepare('DELETE FROM entra_apps WHERE id = ?').run(req.params.id);
  writeAuditLog({
    user_id: req.user.id, username: req.user.username, action: 'entra_app.delete',
    entity_type: 'entra_app', entity_id: req.params.id, module: 'entra-apps',
    details: { app_name: a.app_name }, ip_address: req.ip,
  });
  res.json({ ok: true });
});

// POST /api/entra-apps/:id/reveal
router.post('/:id/reveal', requireRole('superadmin', 'admin', 'operator'), (req, res) => {
  const a = db.prepare('SELECT client_secret FROM entra_apps WHERE id = ?').get(req.params.id);
  if (!a) return res.status(404).json({ error: 'Not found' });
  writeAuditLog({
    user_id: req.user.id, username: req.user.username, action: 'entra_app.reveal_secret',
    entity_type: 'entra_app', entity_id: req.params.id, module: 'entra-apps', ip_address: req.ip,
  });
  res.json({ secret: a.client_secret });
});

// POST /api/entra-apps/:id/toggle-hidden
router.post('/:id/toggle-hidden', requireRole('superadmin', 'admin', 'operator'), (req, res) => {
  const a = db.prepare('SELECT hidden FROM entra_apps WHERE id = ?').get(req.params.id);
  if (!a) return res.status(404).json({ error: 'Not found' });
  db.prepare('UPDATE entra_apps SET hidden=? WHERE id=?').run(a.hidden ? 0 : 1, req.params.id);
  res.json({ ok: true, hidden: !a.hidden });
});

// GET /api/entra-apps/export.csv — secrets are NEVER included in the export
router.get('/export.csv', (req, res) => {
  const rows = db.prepare('SELECT * FROM entra_apps ORDER BY app_name').all().map(mapEntraApp);
  const headers = ['app_name', 'app_id', 'secret_expiry', 'secret_status', 'assigned_to', 'project', 'notes'];
  const escape = (v) => {
    if (v === null || v === undefined) return '';
    const s = String(v).replace(/"/g, '""');
    return /[",\n]/.test(s) ? `"${s}"` : s;
  };
  const lines = [headers.join(',')];
  for (const row of rows) lines.push(headers.map((h) => escape(row[h])).join(','));

  writeAuditLog({
    user_id: req.user.id, username: req.user.username, action: 'entra_app.export',
    module: 'entra-apps', ip_address: req.ip,
  });

  res.setHeader('Content-Type', 'text/csv');
  res.setHeader('Content-Disposition', `attachment; filename="infraloom-entra-apps-${Date.now()}.csv"`);
  res.send(lines.join('\n'));
});

module.exports = router;
