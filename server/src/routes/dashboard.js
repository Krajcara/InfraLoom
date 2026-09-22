'use strict';

const express = require('express');
const db = require('../db/database');
const { requireAuth } = require('../middleware/auth');

const router = express.Router();
router.use(requireAuth);

// The canonical set of widgets this InfraLoom install knows about. As each
// phase ships its module, the widget starts showing real data instead of
// the "coming in Phase N" placeholder — the id/order registered here is
// what persists in a user's saved layout, so keep ids stable once shipped.
const DEFAULT_WIDGETS = [
  { id: 'hypervisors', title: 'Hypervisors', phase: 11 },
  { id: 'uptime', title: 'Uptime Monitor', phase: 6 },
  { id: 'licences', title: 'Expiring Licences', phase: 4 },
  { id: 'ssl', title: 'Expiring SSL Certificates', phase: 6 },
  { id: 'routers', title: 'Routers', phase: 7 },
  { id: 'switches', title: 'Switches', phase: 7 },
  { id: 'access_points', title: 'Access Points', phase: 7 },
  { id: 'dns', title: 'DNS Status', phase: 8 },
  { id: 'netspeed', title: 'Last Net Speed Test', phase: 9 },
  { id: 'myip', title: 'My IP', phase: 10 },
];

function defaultLayout() {
  return DEFAULT_WIDGETS.map((w) => ({ id: w.id, visible: true }));
}

/** Reconciles a saved layout with the current widget registry: keeps the
 * user's chosen order/visibility for widgets that still exist, appends any
 * newly introduced widgets at the end (visible by default), and drops ids
 * that no longer exist. */
function reconcile(savedLayout) {
  const known = new Set(DEFAULT_WIDGETS.map((w) => w.id));
  const kept = savedLayout.filter((entry) => known.has(entry.id));
  const keptIds = new Set(kept.map((entry) => entry.id));
  const added = DEFAULT_WIDGETS.filter((w) => !keptIds.has(w.id)).map((w) => ({ id: w.id, visible: true }));
  return [...kept, ...added];
}

function widgetMeta(id) {
  return DEFAULT_WIDGETS.find((w) => w.id === id);
}

// GET /api/dashboard/layout
router.get('/layout', (req, res) => {
  const row = db.prepare('SELECT layout FROM dashboard_layouts WHERE user_id = ?').get(req.user.id);
  const layout = row ? reconcile(JSON.parse(row.layout)) : defaultLayout();
  res.json({
    layout: layout.map((entry) => ({ ...entry, ...widgetMeta(entry.id) })),
  });
});

// PUT /api/dashboard/layout — { layout: [{ id, visible }, ...] }
router.put('/layout', (req, res) => {
  const { layout } = req.body || {};
  if (!Array.isArray(layout)) return res.status(400).json({ error: 'layout must be an array' });

  const known = new Set(DEFAULT_WIDGETS.map((w) => w.id));
  const clean = layout
    .filter((entry) => entry && known.has(entry.id))
    .map((entry) => ({ id: entry.id, visible: !!entry.visible }));

  db.prepare(
    `INSERT INTO dashboard_layouts (user_id, layout, updated_at) VALUES (?, ?, datetime('now'))
     ON CONFLICT(user_id) DO UPDATE SET layout = excluded.layout, updated_at = excluded.updated_at`
  ).run(req.user.id, JSON.stringify(clean));

  res.json({ ok: true });
});

module.exports = router;
