'use strict';

const express = require('express');
const db = require('../db/database');
const { requireAuth, requireRole } = require('../middleware/auth');
const { writeAuditLog } = require('../middleware/audit');
const backupService = require('../services/backupService');

const router = express.Router();
router.use(requireAuth, requireRole('superadmin', 'admin'));

// GET /api/backup
router.get('/', (req, res) => {
  try {
    res.json({ backups: backupService.listBackups() });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST /api/backup — create one now
router.post('/', async (req, res) => {
  try {
    const result = await backupService.createBackup(req.user.username);
    writeAuditLog({
      user_id: req.user.id, username: req.user.username, action: 'backup.create',
      module: 'backup', details: { filename: result.filename, size: result.size }, ip_address: req.ip,
    });
    res.json({ ok: true, backup: result });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET /api/backup/:filename/download
router.get('/:filename/download', (req, res) => {
  const filePath = backupService.backupFilePath(req.params.filename);
  if (!filePath) return res.status(404).json({ error: 'Not found' });
  writeAuditLog({
    user_id: req.user.id, username: req.user.username, action: 'backup.download',
    module: 'backup', details: { filename: req.params.filename }, ip_address: req.ip,
  });
  res.download(filePath, req.params.filename);
});

// DELETE /api/backup/:filename
router.delete('/:filename', (req, res) => {
  backupService.deleteBackup(req.params.filename);
  writeAuditLog({
    user_id: req.user.id, username: req.user.username, action: 'backup.delete',
    module: 'backup', details: { filename: req.params.filename }, ip_address: req.ip,
  });
  res.json({ ok: true });
});

// GET /api/backup/config/schedule
router.get('/config/schedule', (req, res) => {
  res.json({
    cron: db.prepare("SELECT value FROM settings WHERE key = 'backup_cron'").get()?.value || '0 3 * * *',
    retention_count: db.prepare("SELECT value FROM settings WHERE key = 'backup_retention_count'").get()?.value || '14',
  });
});

// POST /api/backup/config/schedule
router.post('/config/schedule', (req, res) => {
  const { cron, retention_count } = req.body || {};
  if (cron) {
    const applied = backupService.reschedule(cron);
    if (!applied) return res.status(400).json({ error: 'Invalid cron expression' });
    db.prepare("INSERT INTO settings (key, value, updated_at) VALUES ('backup_cron', ?, datetime('now')) ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at").run(cron);
  }
  if (retention_count) {
    db.prepare("INSERT INTO settings (key, value, updated_at) VALUES ('backup_retention_count', ?, datetime('now')) ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at").run(String(retention_count));
    backupService.applyRetention();
  }
  res.json({ ok: true });
});

module.exports = router;
