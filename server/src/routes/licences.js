'use strict';

const express = require('express');
const db = require('../db/database');
const { requireAuth, requireRole } = require('../middleware/auth');
const { writeAuditLog } = require('../middleware/audit');

const router = express.Router();
router.use(requireAuth);

const clean = (s) => (typeof s === 'string' ? s.replace(/\0/g, '').trim() : s);

function mapLicence(l) {
  const daysUntilExpiry = l.expiry_date
    ? Math.ceil((new Date(l.expiry_date) - new Date()) / 86400000)
    : null;
  return {
    ...l,
    assigned_to: l.assigned_to ? JSON.parse(l.assigned_to) : [],
    licence_password: l.licence_password ? '***' : null,
    days_until_expiry: daysUntilExpiry,
    expiry_status: daysUntilExpiry == null ? null : daysUntilExpiry < 0 ? 'expired' : daysUntilExpiry <= 30 ? 'expiring' : 'ok',
  };
}

// GET /api/licences
router.get('/', (req, res) => {
  const showHidden = req.query.show_hidden === 'true';
  let q = 'SELECT * FROM licences';
  if (!showHidden) q += ' WHERE hidden = 0';
  q += ' ORDER BY vendor, licence_type';
  res.json({ licences: db.prepare(q).all().map(mapLicence) });
});

// POST /api/licences
router.post('/', requireRole('superadmin', 'admin', 'operator'), (req, res) => {
  const {
    vendor, licence_type, licence_count, licence_used,
    purchase_date, expiry_date, assigned_to,
    url, licence_username, licence_password, licence_mfa, notes,
  } = req.body || {};

  const v = clean(vendor);
  const t = clean(licence_type);
  if (!v || !t) return res.status(400).json({ error: 'vendor and licence_type are required' });

  const assigned = Array.isArray(assigned_to) ? assigned_to : [];
  const used = assigned.length > 0 ? assigned.length : parseInt(licence_used, 10) || 0;

  const r = db
    .prepare(
      `INSERT INTO licences
        (vendor, licence_type, licence_count, licence_used, purchase_date, expiry_date,
         assigned_to, url, licence_username, licence_password, licence_mfa, notes)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`
    )
    .run(
      v, t, parseInt(licence_count, 10) || 1, used,
      purchase_date || null, expiry_date || null,
      JSON.stringify(assigned), url || null,
      licence_username || null, licence_password || null,
      licence_mfa ? 1 : 0, notes || null
    );

  writeAuditLog({
    user_id: req.user.id, username: req.user.username, action: 'licence.create',
    entity_type: 'licence', entity_id: r.lastInsertRowid, module: 'licences',
    details: { vendor: v, licence_type: t }, ip_address: req.ip,
  });

  res.status(201).json({ id: r.lastInsertRowid });
});

// PUT /api/licences/:id
router.put('/:id', requireRole('superadmin', 'admin', 'operator'), (req, res) => {
  const existing = db.prepare('SELECT * FROM licences WHERE id = ?').get(req.params.id);
  if (!existing) return res.status(404).json({ error: 'Not found' });

  const {
    vendor, licence_type, licence_count, licence_used,
    purchase_date, expiry_date, assigned_to,
    url, licence_username, licence_password, licence_mfa, notes,
  } = req.body || {};

  const v = clean(vendor) || existing.vendor;
  const t = clean(licence_type) || existing.licence_type;
  const assigned = Array.isArray(assigned_to) ? assigned_to : JSON.parse(existing.assigned_to || '[]');
  const used = assigned.length > 0 ? assigned.length : parseInt(licence_used, 10) || 0;

  const newPass =
    licence_password && licence_password !== '***' && licence_password !== ''
      ? licence_password
      : existing.licence_password;

  db.prepare(
    `UPDATE licences SET
      vendor=?, licence_type=?, licence_count=?, licence_used=?,
      purchase_date=?, expiry_date=?, assigned_to=?, url=?,
      licence_username=?, licence_password=?, licence_mfa=?, notes=?,
      updated_at=datetime('now')
     WHERE id=?`
  ).run(
    v, t, parseInt(licence_count, 10) || existing.licence_count, used,
    purchase_date || null, expiry_date || null, JSON.stringify(assigned),
    url !== undefined ? url || null : existing.url,
    licence_username !== undefined ? licence_username || null : existing.licence_username,
    newPass,
    licence_mfa !== undefined ? (licence_mfa ? 1 : 0) : existing.licence_mfa,
    notes !== undefined ? notes || null : existing.notes,
    req.params.id
  );

  writeAuditLog({
    user_id: req.user.id, username: req.user.username, action: 'licence.update',
    entity_type: 'licence', entity_id: req.params.id, module: 'licences',
    details: { vendor: v, licence_type: t }, ip_address: req.ip,
  });

  res.json({ ok: true });
});

// DELETE /api/licences/:id
router.delete('/:id', requireRole('superadmin', 'admin', 'operator'), (req, res) => {
  const l = db.prepare('SELECT vendor, licence_type FROM licences WHERE id = ?').get(req.params.id);
  if (!l) return res.status(404).json({ error: 'Not found' });
  db.prepare('DELETE FROM licences WHERE id = ?').run(req.params.id);
  writeAuditLog({
    user_id: req.user.id, username: req.user.username, action: 'licence.delete',
    entity_type: 'licence', entity_id: req.params.id, module: 'licences',
    details: { vendor: l.vendor, licence_type: l.licence_type }, ip_address: req.ip,
  });
  res.json({ ok: true });
});

// POST /api/licences/:id/renew — { expiry_date } explicit (no cost/billing-cycle auto-calc)
router.post('/:id/renew', requireRole('superadmin', 'admin', 'operator'), (req, res) => {
  const l = db.prepare('SELECT * FROM licences WHERE id = ?').get(req.params.id);
  if (!l) return res.status(404).json({ error: 'Not found' });
  const { expiry_date } = req.body || {};
  if (!expiry_date) return res.status(400).json({ error: 'expiry_date is required' });

  db.prepare("UPDATE licences SET expiry_date=?, updated_at=datetime('now') WHERE id=?").run(expiry_date, req.params.id);
  writeAuditLog({
    user_id: req.user.id, username: req.user.username, action: 'licence.renew',
    entity_type: 'licence', entity_id: req.params.id, module: 'licences',
    details: { vendor: l.vendor, licence_type: l.licence_type, new_expiry: expiry_date }, ip_address: req.ip,
  });
  res.json({ ok: true, expiry_date });
});

// POST /api/licences/:id/toggle-hidden
router.post('/:id/toggle-hidden', requireRole('superadmin', 'admin', 'operator'), (req, res) => {
  const l = db.prepare('SELECT hidden FROM licences WHERE id = ?').get(req.params.id);
  if (!l) return res.status(404).json({ error: 'Not found' });
  db.prepare('UPDATE licences SET hidden=? WHERE id=?').run(l.hidden ? 0 : 1, req.params.id);
  res.json({ ok: true, hidden: !l.hidden });
});

// POST /api/licences/:id/reveal-password
router.post('/:id/reveal-password', requireRole('superadmin', 'admin', 'operator'), (req, res) => {
  const l = db.prepare('SELECT licence_password FROM licences WHERE id = ?').get(req.params.id);
  if (!l) return res.status(404).json({ error: 'Not found' });
  writeAuditLog({
    user_id: req.user.id, username: req.user.username, action: 'licence.reveal_password',
    entity_type: 'licence', entity_id: req.params.id, module: 'licences', ip_address: req.ip,
  });
  res.json({ password: l.licence_password });
});

module.exports = router;
