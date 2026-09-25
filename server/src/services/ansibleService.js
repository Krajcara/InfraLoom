'use strict';

const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');
const db = require('../db/database');
const { resolveGuestSshCreds } = require('./patchService');

const PROJECT_ROOT = path.resolve(__dirname, '..', '..', '..');
const ANSIBLE_DIR = path.join(PROJECT_ROOT, 'data', 'ansible');
const RUNS_DIR = path.join(ANSIBLE_DIR, 'runs');
fs.mkdirSync(RUNS_DIR, { recursive: true });

function getConnection(id) {
  return db.prepare('SELECT * FROM hypervisor_connections WHERE id = ?').get(id);
}

/** Builds a YAML inventory from InfraLoom's own saved SSH credentials —
 * the same ssh_credentials table SSH Terminal and Hyper-V patch
 * management already use, so no separate credential system is needed.
 * YAML over Ansible's INI format specifically for string escaping: INI
 * values are split with shell-like (shlex) rules that don't line up
 * cleanly with arbitrary password characters, while a YAML double-quoted
 * scalar has well-defined escaping (JSON.stringify's output happens to
 * already be valid YAML here, since valid JSON is essentially always
 * valid YAML). */
function buildInventory(guests) {
  const hostLines = [];
  const missing = [];
  for (const g of guests) {
    const conn = getConnection(g.connectionId);
    if (!conn) {
      missing.push(`${g.name}: connection not found`);
      continue;
    }
    const creds = resolveGuestSshCreds(conn, g.vmid, g.ip);
    if (!creds.host || !creds.username || !(creds.password || creds.privateKey)) {
      missing.push(`${g.name}: no saved SSH credentials or no known IP`);
      continue;
    }
    const alias = g.name.replace(/[^a-zA-Z0-9_-]/g, '_');
    const authLines = creds.privateKey
      ? `      ansible_ssh_private_key_file: ${JSON.stringify(creds.privateKey)}\n` + (creds.passphrase ? `      ansible_ssh_private_key_passphrase: ${JSON.stringify(creds.passphrase)}\n` : '')
      : `      ansible_password: ${JSON.stringify(creds.password)}\n`;
    hostLines.push(
      `    ${alias}:\n` +
      `      ansible_host: ${JSON.stringify(creds.host)}\n` +
      `      ansible_port: ${creds.port || 22}\n` +
      `      ansible_user: ${JSON.stringify(creds.username)}\n` +
      authLines +
      `      ansible_ssh_common_args: "-o StrictHostKeyChecking=no -o UserKnownHostsFile=/dev/null"`
    );
  }
  if (missing.length === guests.length) {
    throw new Error(`No target has usable SSH credentials: ${missing.join('; ')}`);
  }
  const inventory = hostLines.length ? `all:\n  hosts:\n${hostLines.join('\n')}\n` : 'all:\n  hosts: {}\n';
  return { inventory, missing };
}

function runAnsible(dir, args, { onOutput, timeoutMs = 1800000 } = {}) {
  return new Promise((resolve, reject) => {
    const proc = spawn('ansible-playbook', args, { cwd: dir, env: { ...process.env, ANSIBLE_HOST_KEY_CHECKING: 'False', ANSIBLE_FORCE_COLOR: '0' } });
    let stdout = '';
    const timer = setTimeout(() => {
      proc.kill();
      reject(new Error('ansible-playbook timed out'));
    }, timeoutMs);

    proc.stdout.on('data', (chunk) => {
      const s = chunk.toString('utf8');
      stdout += s;
      if (onOutput) onOutput(s);
    });
    proc.stderr.on('data', (chunk) => {
      const s = chunk.toString('utf8');
      stdout += s;
      if (onOutput) onOutput(s);
    });
    proc.on('close', (code) => {
      clearTimeout(timer);
      resolve({ code, stdout });
    });
    proc.on('error', (err) => {
      clearTimeout(timer);
      reject(err);
    });
  });
}

/** Runs the playbook in --check --diff mode and stores a run row awaiting
 * approval — nothing on the target hosts changes yet. */
async function checkPlaybook({ playbookIds, guests, triggeredBy }) {
  const ids = Array.isArray(playbookIds) ? playbookIds : [playbookIds];
  const playbooks = ids.map((pid) => db.prepare('SELECT * FROM ansible_playbooks WHERE id = ?').get(pid)).filter(Boolean);
  if (playbooks.length === 0) throw new Error('No valid playbooks selected');

  const combinedName = playbooks.map((p) => p.name).join(', ');
  const row = db
    .prepare(
      `INSERT INTO ansible_runs (playbook_id, playbook_name, playbook_ids, target_guests, status, triggered_by) VALUES (?,?,?,?,'checking',?)`
    )
    .run(playbooks[0].id, combinedName, JSON.stringify(playbooks.map((p) => p.id)), JSON.stringify(guests), triggeredBy);
  const id = row.lastInsertRowid;

  const dir = path.join(RUNS_DIR, String(id));
  fs.mkdirSync(dir, { recursive: true });

  try {
    const { inventory, missing } = buildInventory(guests);
    fs.writeFileSync(path.join(dir, 'inventory.yml'), inventory);
    // Ansible natively accepts multiple playbook files as separate
    // positional args and runs them in order within one invocation — one
    // check, one approval, one apply for the whole batch, rather than a
    // separate run per playbook.
    const playbookFiles = playbooks.map((p, i) => {
      const filename = `playbook-${i}.yml`;
      fs.writeFileSync(path.join(dir, filename), p.content);
      return filename;
    });

    const result = await runAnsible(dir, ['-i', 'inventory.yml', ...playbookFiles, '--check', '--diff'], { timeoutMs: 300000 });
    const checkFailedNote = result.code !== 0
      ? '\n\n⚠️  This check run reported a failure — but --check mode has known false-negatives for ' +
        'playbooks that add a package repository and install from it in the same run (the simulated run ' +
        "doesn't refresh the newly-added repo's package list). Review the output below; if the failure looks " +
        'like that, approving may still succeed for real. If it looks like a genuine problem (bad credentials, ' +
        'unreachable host, a real task error unrelated to repo/package timing), fix that first.\n'
      : '';
    const output = (missing.length ? `Skipped (no credentials): ${missing.join('; ')}\n\n` : '') + result.stdout + checkFailedNote;

    db.prepare("UPDATE ansible_runs SET status='awaiting_approval', check_output=? WHERE id=?").run(output, id);
  } catch (err) {
    db.prepare("UPDATE ansible_runs SET status='failed', error=? WHERE id=?").run(err.message, id);
    throw err;
  }

  return db.prepare('SELECT * FROM ansible_runs WHERE id = ?').get(id);
}

/** Applies a previously-checked run for real, streaming output. */
async function applyPlaybook(runId, approvedBy) {
  const run = db.prepare('SELECT * FROM ansible_runs WHERE id = ?').get(runId);
  if (!run) throw new Error('Run not found');
  if (run.status !== 'awaiting_approval') throw new Error(`Run is not awaiting approval (status: ${run.status})`);

  const dir = path.join(RUNS_DIR, String(runId));
  db.prepare("UPDATE ansible_runs SET status='applying' WHERE id=?").run(runId);
  const io = global.io;
  if (io) io.emit('ansible:started', { runId });

  let accumulated = '';
  const onOutput = (chunk) => {
    accumulated += chunk;
    if (accumulated.length > 200000) accumulated = accumulated.slice(-200000);
    if (io) io.emit('ansible:output', { runId, chunk });
    db.prepare('UPDATE ansible_runs SET apply_output = ? WHERE id = ?').run(accumulated, runId);
  };

  try {
    const playbookFiles = fs.readdirSync(dir)
      .filter((f) => /^playbook-\d+\.yml$/.test(f))
      .sort((a, b) => parseInt(a.match(/\d+/)[0], 10) - parseInt(b.match(/\d+/)[0], 10));
    if (playbookFiles.length === 0) throw new Error('No playbook files found for this run — was it checked first?');

    const result = await runAnsible(dir, ['-i', 'inventory.yml', ...playbookFiles], { onOutput });
    const status = result.code === 0 ? 'completed' : 'failed';
    db.prepare("UPDATE ansible_runs SET status=?, apply_output=?, completed_at=datetime('now') WHERE id=?").run(status, accumulated, runId);
    if (io) io.emit('ansible:complete', { runId, status });
    return { status };
  } catch (err) {
    db.prepare("UPDATE ansible_runs SET status='failed', error=?, completed_at=datetime('now') WHERE id=?").run(err.message, runId);
    if (io) io.emit('ansible:complete', { runId, status: 'failed', error: err.message });
    throw err;
  }
}

function cancelRun(runId) {
  db.prepare("UPDATE ansible_runs SET status='failed', error='Cancelled by user' WHERE id=? AND status='awaiting_approval'").run(runId);
}

module.exports = { checkPlaybook, applyPlaybook, cancelRun, buildInventory };
