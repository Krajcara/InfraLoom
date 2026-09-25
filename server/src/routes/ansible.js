'use strict';

const express = require('express');
const db = require('../db/database');
const { requireAuth, requireRole } = require('../middleware/auth');
const { writeAuditLog } = require('../middleware/audit');
const ansibleService = require('../services/ansibleService');
const proxmox = require('../lib/proxmoxClient');

const router = express.Router();
router.use(requireAuth);

// GET /api/ansible/targets — every Proxmox VM/LXC across all connections,
// for the run-playbook target picker. Other hypervisor types are a
// follow-up, matching how the rest of Automation is scoped for now.
router.get('/targets', async (req, res) => {
  const connections = db.prepare("SELECT * FROM hypervisor_connections WHERE enabled = 1 AND type = 'proxmox'").all();
  const results = await Promise.allSettled(
    connections.map(async (conn) => {
      const nodes = await proxmox.fetchNodesSummary(conn);
      const perNode = await Promise.all(
        nodes
          .filter((n) => n.status === 'online')
          .map(async (n) => {
            const guests = await proxmox.listGuestsBasic(conn, n.node);
            return guests
              .filter((g) => g.status === 'running')
              .map((g) => ({ connectionId: conn.id, connectionName: conn.name, node: n.node, vmid: String(g.vmid), name: g.name, type: g.type }));
          })
      );
      return perNode.flat();
    })
  );
  const targets = results.filter((r) => r.status === 'fulfilled').flatMap((r) => r.value);
  res.json({ targets });
});

// GET /api/ansible/playbooks
router.get('/playbooks', (req, res) => {
  res.json({ playbooks: db.prepare('SELECT id, name, description, port, is_builtin, created_by, created_at, updated_at FROM ansible_playbooks ORDER BY is_builtin DESC, name ASC').all() });
});

// GET /api/ansible/playbooks/:id
router.get('/playbooks/:id', (req, res) => {
  const pb = db.prepare('SELECT * FROM ansible_playbooks WHERE id = ?').get(req.params.id);
  if (!pb) return res.status(404).json({ error: 'Not found' });
  res.json({ playbook: pb });
});

// POST /api/ansible/playbooks
router.post('/playbooks', requireRole('superadmin', 'admin'), (req, res) => {
  const { name, description, content, port } = req.body || {};
  if (!name || !content) return res.status(400).json({ error: 'name and content are required' });
  const result = db.prepare('INSERT INTO ansible_playbooks (name, description, content, port, created_by) VALUES (?,?,?,?,?)').run(name, description || '', content, port || null, req.user.username);
  writeAuditLog({ user_id: req.user.id, username: req.user.username, action: 'ansible.playbook_create', module: 'ansible', entity_id: result.lastInsertRowid, details: { name }, ip_address: req.ip });
  res.json({ playbook: db.prepare('SELECT * FROM ansible_playbooks WHERE id = ?').get(result.lastInsertRowid) });
});

// PUT /api/ansible/playbooks/:id
router.put('/playbooks/:id', requireRole('superadmin', 'admin'), (req, res) => {
  const pb = db.prepare('SELECT * FROM ansible_playbooks WHERE id = ?').get(req.params.id);
  if (!pb) return res.status(404).json({ error: 'Not found' });
  if (pb.is_builtin) return res.status(400).json({ error: 'Built-in playbooks cannot be edited — copy it into a new one instead' });
  const { name, description, content, port } = req.body || {};
  db.prepare("UPDATE ansible_playbooks SET name=?, description=?, content=?, port=?, updated_at=datetime('now') WHERE id=?").run(
    name || pb.name, description ?? pb.description, content || pb.content, port ?? pb.port, req.params.id
  );
  writeAuditLog({ user_id: req.user.id, username: req.user.username, action: 'ansible.playbook_update', module: 'ansible', entity_id: pb.id, ip_address: req.ip });
  res.json({ playbook: db.prepare('SELECT * FROM ansible_playbooks WHERE id = ?').get(req.params.id) });
});

// DELETE /api/ansible/playbooks/:id
router.delete('/playbooks/:id', requireRole('superadmin', 'admin'), (req, res) => {
  const pb = db.prepare('SELECT * FROM ansible_playbooks WHERE id = ?').get(req.params.id);
  if (!pb) return res.status(404).json({ error: 'Not found' });
  if (pb.is_builtin) return res.status(400).json({ error: 'Built-in playbooks cannot be deleted' });
  db.prepare('DELETE FROM ansible_playbooks WHERE id = ?').run(req.params.id);
  writeAuditLog({ user_id: req.user.id, username: req.user.username, action: 'ansible.playbook_delete', module: 'ansible', entity_id: pb.id, details: { name: pb.name }, ip_address: req.ip });
  res.json({ ok: true });
});

// GET /api/ansible/runs?limit=
router.get('/runs', (req, res) => {
  const limit = Math.min(parseInt(req.query.limit, 10) || 50, 200);
  res.json({ runs: db.prepare('SELECT id, playbook_name, target_guests, status, error, triggered_by, created_at, completed_at FROM ansible_runs ORDER BY created_at DESC LIMIT ?').all(limit) });
});

// GET /api/ansible/runs/:id
router.get('/runs/:id', (req, res) => {
  const run = db.prepare('SELECT * FROM ansible_runs WHERE id = ?').get(req.params.id);
  if (!run) return res.status(404).json({ error: 'Not found' });
  res.json({ run: { ...run, target_guests: JSON.parse(run.target_guests) } });
});

// POST /api/ansible/runs — check (dry-run), nothing on targets changes yet
router.post('/runs', requireRole('superadmin', 'admin', 'operator'), async (req, res) => {
  const { playbookIds, guests } = req.body || {};
  if (!Array.isArray(playbookIds) || playbookIds.length === 0 || !Array.isArray(guests) || guests.length === 0) {
    return res.status(400).json({ error: 'playbookIds (non-empty array) and a non-empty guests array are required' });
  }

  try {
    const run = await ansibleService.checkPlaybook({ playbookIds, guests, triggeredBy: req.user.username });
    writeAuditLog({ user_id: req.user.id, username: req.user.username, action: 'ansible.check', module: 'ansible', entity_id: run.id, details: { playbookIds, targetCount: guests.length }, ip_address: req.ip });
    res.json({ run: { ...run, target_guests: JSON.parse(run.target_guests) } });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST /api/ansible/runs/:id/approve — apply for real
router.post('/runs/:id/approve', requireRole('superadmin', 'admin'), async (req, res) => {
  const run = db.prepare('SELECT * FROM ansible_runs WHERE id = ?').get(req.params.id);
  if (!run) return res.status(404).json({ error: 'Not found' });
  if (run.status !== 'awaiting_approval') return res.status(400).json({ error: `Run is not awaiting approval (status: ${run.status})` });

  res.json({ ok: true, message: 'Run approved and applying' });
  writeAuditLog({ user_id: req.user.id, username: req.user.username, action: 'ansible.approve', module: 'ansible', entity_id: run.id, ip_address: req.ip });

  try {
    await ansibleService.applyPlaybook(run.id, req.user.username);
  } catch (err) {
    console.error('[Ansible] Apply failed:', err.message);
  }
});

// POST /api/ansible/runs/:id/cancel
router.post('/runs/:id/cancel', requireRole('superadmin', 'admin', 'operator'), (req, res) => {
  ansibleService.cancelRun(req.params.id);
  res.json({ ok: true });
});

module.exports = router;
