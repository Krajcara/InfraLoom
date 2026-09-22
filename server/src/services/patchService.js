'use strict';

const db = require('../db/database');
const { execInVM } = require('../lib/qemuExec');
const { execInLXC } = require('../lib/pctExec');

function execFor(conn, guestType, node, vmid, command, opts) {
  if (guestType === 'qemu') return execInVM(conn, node, vmid, command, opts);
  if (guestType === 'lxc') return execInLXC(conn, vmid, command, opts);
  throw new Error(`Unsupported guest type: ${guestType}`);
}

async function detectOsFamily(conn, guestType, node, vmid) {
  const r = await execFor(
    conn, guestType, node, vmid,
    "if [ -f /etc/debian_version ]; then echo debian; elif [ -f /etc/redhat-release ]; then echo rhel; else echo unknown; fi",
    { timeoutMs: 20000 }
  );
  const family = r.stdout.trim();
  return ['debian', 'rhel'].includes(family) ? family : 'unknown';
}

const DRY_RUN_COMMANDS = {
  debian: 'export DEBIAN_FRONTEND=noninteractive; apt-get update -qq 2>&1; apt-get -s upgrade 2>&1',
  rhel: '(command -v dnf >/dev/null && dnf check-update || yum check-update) 2>&1; true',
};

const APPLY_COMMANDS = {
  debian: 'export DEBIAN_FRONTEND=noninteractive; apt-get update -qq 2>&1; apt-get -y upgrade 2>&1; echo "___EXIT_$?___"',
  rhel: '(command -v dnf >/dev/null && dnf -y upgrade || yum -y upgrade) 2>&1; echo "___EXIT_$?___"',
};

function parseDebianDryRun(output) {
  // apt-get -s upgrade prints lines like: Inst pkgname [old-ver] (new-ver repo [arch])
  const packages = [];
  const re = /^Inst\s+(\S+)\s+\[([^\]]*)\]\s+\(([^\s]+)/gm;
  let m;
  while ((m = re.exec(output))) {
    packages.push({ name: m[1], current_version: m[2] || null, new_version: m[3] });
  }
  return packages;
}

function parseRhelDryRun(output) {
  // dnf/yum check-update prints "name.arch  version  repo" lines after a blank-line header
  const packages = [];
  const lines = output.split('\n');
  for (const line of lines) {
    const m = line.match(/^(\S+)\.(\S+)\s+(\S+)\s+(\S+)\s*$/);
    if (m && !line.startsWith('Last metadata') && !line.startsWith('Obsoleting')) {
      packages.push({ name: m[1], current_version: null, new_version: m[3] });
    }
  }
  return packages;
}

/** Runs the dry-run simulation and stores a patch_runs row in
 * 'awaiting_approval' with the package snapshot. Never mutates the guest. */
async function runDryRun({ connectionId, conn, node, guestType, vmid, vmName, triggeredBy }) {
  const osFamily = await detectOsFamily(conn, guestType, node, vmid);
  if (osFamily === 'unknown') throw new Error('Could not detect a supported OS (Debian/Ubuntu or RHEL/Fedora family) inside the guest');

  const cmd = DRY_RUN_COMMANDS[osFamily];
  const r = await execFor(conn, guestType, node, vmid, cmd, { timeoutMs: 120000 });

  const packages = osFamily === 'debian' ? parseDebianDryRun(r.stdout) : parseRhelDryRun(r.stdout);

  const row = db
    .prepare(
      `INSERT INTO patch_runs (connection_id, node, guest_type, vmid, vm_name, os_family, status, packages_affected, dry_run_output, triggered_by)
       VALUES (?,?,?,?,?,?,'awaiting_approval',?,?,?)`
    )
    .run(connectionId, node, guestType, String(vmid), vmName || null, osFamily, JSON.stringify(packages), r.stdout.slice(-20000), triggeredBy);

  return db.prepare('SELECT * FROM patch_runs WHERE id = ?').get(row.lastInsertRowid);
}

/** Applies the previously-approved patch run, streaming output over
 * Socket.io ('patch:output', { runId, chunk }) as the guest-agent poll (or
 * SSH stream) yields new data. */
async function applyPatches(runId, approvedBy) {
  const run = db.prepare('SELECT * FROM patch_runs WHERE id = ?').get(runId);
  if (!run) throw new Error('Patch run not found');
  if (run.status !== 'awaiting_approval') throw new Error(`Run is not awaiting approval (status: ${run.status})`);

  const conn = db.prepare('SELECT * FROM hypervisor_connections WHERE id = ?').get(run.connection_id);
  if (!conn) throw new Error('Hypervisor connection no longer exists');

  db.prepare("UPDATE patch_runs SET status='running', approved_by=?, started_at=datetime('now') WHERE id=?").run(approvedBy, runId);
  const io = global.io;
  if (io) io.emit('patch:started', { runId });

  let accumulated = '';
  const onOutput = (chunk) => {
    accumulated += chunk;
    if (accumulated.length > 200000) accumulated = accumulated.slice(-200000); // cap memory for pathological output
    if (io) io.emit('patch:output', { runId, chunk });
    db.prepare('UPDATE patch_runs SET apply_output = ? WHERE id = ?').run(accumulated, runId);
  };

  try {
    const cmd = APPLY_COMMANDS[run.os_family];
    if (!cmd) throw new Error(`No apply command for OS family: ${run.os_family}`);
    const result = await execFor(conn, run.guest_type, run.node, run.vmid, cmd, { timeoutMs: 1800000, onOutput });

    const exitMatch = result.stdout.match(/___EXIT_(\d+)___/);
    const exitCode = exitMatch ? parseInt(exitMatch[1], 10) : result.exitCode;
    const status = exitCode === 0 ? 'completed' : 'failed';

    db.prepare("UPDATE patch_runs SET status=?, completed_at=datetime('now'), apply_output=? WHERE id=?").run(status, result.stdout.slice(-200000), runId);
    if (io) io.emit('patch:complete', { runId, status });
    return { status };
  } catch (err) {
    db.prepare("UPDATE patch_runs SET status='failed', error=?, completed_at=datetime('now') WHERE id=?").run(err.message, runId);
    if (io) io.emit('patch:complete', { runId, status: 'failed', error: err.message });
    throw err;
  }
}

function cancelRun(runId) {
  db.prepare("UPDATE patch_runs SET status='cancelled', completed_at=datetime('now') WHERE id=? AND status='awaiting_approval'").run(runId);
}

module.exports = { runDryRun, applyPatches, cancelRun, detectOsFamily };
