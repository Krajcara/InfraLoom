'use strict';

const express = require('express');
const db = require('../db/database');
const { requireAuth } = require('../middleware/auth');

const router = express.Router();
router.use(requireAuth);

// GET /api/notifications?limit=&unread=1
router.get('/', (req, res) => {
  const { limit, unread } = req.query;
  let sql = 'SELECT * FROM app_notifications';
  const params = [];
  if (unread === '1') sql += ' WHERE is_read = 0';
  sql += ' ORDER BY created_at DESC LIMIT ?';
  params.push(Math.min(parseInt(limit, 10) || 30, 100));
  res.json({ notifications: db.prepare(sql).all(...params) });
});

// GET /api/notifications/unread-count
router.get('/unread-count', (req, res) => {
  const { n } = db.prepare('SELECT COUNT(*) as n FROM app_notifications WHERE is_read = 0').get();
  res.json({ count: n });
});

// POST /api/notifications/:id/read
router.post('/:id/read', (req, res) => {
  db.prepare('UPDATE app_notifications SET is_read = 1 WHERE id = ?').run(req.params.id);
  res.json({ ok: true });
});

// POST /api/notifications/mark-all-read
router.post('/mark-all-read', (req, res) => {
  db.prepare('UPDATE app_notifications SET is_read = 1 WHERE is_read = 0').run();
  res.json({ ok: true });
});

module.exports = router;
