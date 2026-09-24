'use strict';

const express = require('express');
const db = require('../db/database');
const { requireAuth, requireRole } = require('../middleware/auth');

const router = express.Router();
router.use(requireAuth, requireRole('superadmin', 'admin'));

function buildFilter(query) {
  const clauses = [];
  const params = {};

  if (query.module) {
    clauses.push('module = @module');
    params.module = query.module;
  }
  if (query.action) {
    clauses.push('action LIKE @action');
    params.action = `%${query.action}%`;
  }
  if (query.username) {
    clauses.push('username LIKE @username');
    params.username = `%${query.username}%`;
  }
  if (query.from) {
    clauses.push('created_at >= @from');
    params.from = query.from;
  }
  if (query.to) {
    clauses.push('created_at <= @to');
    params.to = query.to;
  }

  const where = clauses.length ? `WHERE ${clauses.join(' AND ')}` : '';
  return { where, params };
}

// GET /api/audit-log?module=&action=&username=&from=&to=&page=&limit=
router.get('/', (req, res) => {
  const { where, params } = buildFilter(req.query);
  const page = Math.max(parseInt(req.query.page, 10) || 1, 1);
  const limit = Math.min(Math.max(parseInt(req.query.limit, 10) || 50, 1), 200);
  const offset = (page - 1) * limit;

  const total = db.prepare(`SELECT COUNT(*) AS n FROM audit_log ${where}`).get(params).n;
  const rows = db
    .prepare(`SELECT * FROM audit_log ${where} ORDER BY id DESC LIMIT @limit OFFSET @offset`)
    .all({ ...params, limit, offset });

  res.json({ rows, total, page, limit });
});

// GET /api/audit-log/modules — distinct module values, for the filter dropdown
router.get('/modules', (req, res) => {
  const rows = db
    .prepare("SELECT DISTINCT module FROM audit_log WHERE module IS NOT NULL ORDER BY module")
    .all();
  res.json({ modules: rows.map((r) => r.module) });
});

// GET /api/audit-log/export.csv?... — same filters as above
router.get('/export.csv', (req, res) => {
  const { where, params } = buildFilter(req.query);
  const rows = db.prepare(`SELECT * FROM audit_log ${where} ORDER BY id DESC`).all(params);

  const headers = ['id', 'created_at', 'username', 'action', 'module', 'entity_type', 'entity_id', 'ip_address', 'details'];
  const escape = (v) => {
    if (v === null || v === undefined) return '';
    let s = String(v);
    // CSV/formula injection: a cell starting with =, +, -, or @ is executed
    // as a formula by Excel/Sheets when the file is opened. Prefixing with
    // a single quote forces it to be read as plain text instead.
    if (/^[=+\-@]/.test(s)) s = `'${s}`;
    s = s.replace(/"/g, '""');
    return /[",\n]/.test(s) ? `"${s}"` : s;
  };

  const lines = [headers.join(',')];
  for (const row of rows) {
    lines.push(headers.map((h) => escape(row[h])).join(','));
  }

  res.setHeader('Content-Type', 'text/csv');
  res.setHeader('Content-Disposition', `attachment; filename="infraloom-audit-log-${Date.now()}.csv"`);
  res.send(lines.join('\n'));
});

module.exports = router;
