'use strict';

const db = require('../db/database');
const { execInVM, getOsInfo } = require('../lib/qemuExec');
const { execInLXC } = require('../lib/pctExec');
const { execInGuest } = require('../lib/guestSshExec');
const { executeScript: winrmExecuteScript } = require('../lib/winrmClient');

const WINDOWS_QGA_ID = 'mswindows';
const DEBIAN_LIKE_IDS = new Set(['ubuntu', 'debian']);
const RHEL_LIKE_IDS = new Set(['centos', 'fedora', 'rhel', 'rocky', 'almalinux', 'ol']);
const ALPINE_LIKE_IDS = new Set(['alpine']);

/** Per-node override first (a cluster's nodes can have different root
 * passwords), falling back to the connection's own patch_ssh_* fields. */
function resolveSshCreds(conn, node) {
  const override = db.prepare('SELECT * FROM hypervisor_node_ssh WHERE connection_id = ? AND node = ?').get(conn.id, node);

  const rawHost = (override?.ssh_host?.trim() || conn.patch_ssh_host?.trim() || conn.url) || '';
  const host = rawHost.replace(/^https?:\/\//, '').split(':')[0].split('/')[0];

  return {
    host,
    port: override?.ssh_port || conn.patch_ssh_port || 22,
    username: override?.ssh_username || conn.patch_ssh_username,
    password: override?.ssh_password || conn.patch_ssh_password,
  };
}

/** Saved SSH credentials for a Linux guest VM (reuses the same table the
 * SSH Terminal feature uses — one saved credential per (connection, vmid)
 * works for both). */
function resolveGuestSshCreds(conn, vmid, guestHost) {
  const row = db.prepare('SELECT * FROM ssh_credentials WHERE connection_id = ? AND vmid = ?').get(conn.id, vmid);
  return { host: row?.host || guestHost, port: row?.port || 22, username: row?.username, password: row?.password };
}

/** Saved WinRM credentials for a Windows guest VM — a separate connection
 * into the guest OS itself, distinct from the host-level WinRM connection
 * used to manage the VM (Start-VM etc.). */
function resolveGuestWinrmCreds(conn, vmid, guestHost) {
  const row = db.prepare('SELECT * FROM guest_winrm_credentials WHERE connection_id = ? AND vmid = ?').get(conn.id, vmid);
  return { url: row?.host || guestHost, port: row?.port || 5985, username: row?.username, password: row?.password };
}

function execFor(conn, guestType, node, vmid, command, opts = {}) {
  if (guestType === 'qemu') {
    return execInVM(conn, node, vmid, command, { ...opts, osType: opts.osFamily === 'windows' ? 'windows' : 'linux' });
  }
  if (guestType === 'lxc') return execInLXC(resolveSshCreds(conn, node), vmid, command, opts);
  if (guestType === 'vm') {
    // Hyper-V's generic guest type — command has to reach the GUEST OS, not
    // the host, so this needs its own per-VM credentials rather than the
    // host-level WinRM connection used elsewhere for this same connection.
    if (opts.osFamily === 'windows') {
      const creds = resolveGuestWinrmCreds(conn, vmid, opts.guestHost);
      if (!creds.username || !creds.password) throw new Error('No saved WinRM credentials for this guest');
      return winrmExecuteScript(creds, command, Math.round((opts.timeoutMs || 60000) / 1000)).then((r) => {
        if (r.exitCode !== 0) throw new Error(r.stderr || `WinRM command failed (exit ${r.exitCode})`);
        if (opts.onOutput) opts.onOutput(r.stdout);
        return { exitCode: r.exitCode, stdout: r.stdout, stderr: r.stderr };
      });
    }
    const creds = resolveGuestSshCreds(conn, vmid, opts.guestHost);
    return execInGuest(creds, command, opts);
  }
  throw new Error(`Unsupported guest type: ${guestType}`);
}

async function detectOsFamily(conn, guestType, node, vmid, hintOs) {
  if (guestType === 'qemu') {
    // The dedicated get-osinfo guest-agent call is faster and more reliable
    // than probing with a shell script — and it's the only way to even ask
    // the question on a Windows guest, which has no /bin/sh to probe with.
    const osInfo = await getOsInfo(conn, node, vmid);
    if (osInfo?.id === WINDOWS_QGA_ID) return 'windows';
    if (osInfo?.id && DEBIAN_LIKE_IDS.has(osInfo.id)) return 'debian';
    if (osInfo?.id && RHEL_LIKE_IDS.has(osInfo.id)) return 'rhel';
    if (osInfo?.id && ALPINE_LIKE_IDS.has(osInfo.id)) return 'alpine';
    // Unrecognized/older guest agent — fall through to the shell probe below.
  }

  if (guestType === 'vm' && hintOs) {
    // Hyper-V VMs: classify from the OS name already reported via KVP
    // (see hypervClient.js) rather than exec'ing a probe — we may not even
    // have credentials for this guest yet at this point.
    const os = hintOs.toLowerCase();
    if (os.includes('windows')) return 'windows';
    if (os.includes('ubuntu') || os.includes('debian')) return 'debian';
    if (os.includes('centos') || os.includes('fedora') || os.includes('red hat') || os.includes('rhel') || os.includes('rocky') || os.includes('alma')) return 'rhel';
    if (os.includes('alpine')) return 'alpine';
  }

  const r = await execFor(
    conn, guestType, node, vmid,
    "if [ -f /etc/debian_version ]; then echo debian; elif [ -f /etc/redhat-release ]; then echo rhel; elif [ -f /etc/alpine-release ]; then echo alpine; else echo unknown; fi",
    { timeoutMs: 20000 }
  );
  const family = r.stdout.trim();
  if (!['debian', 'rhel', 'alpine'].includes(family)) {
    const detail = [r.stderr?.trim(), r.stdout?.trim()].filter(Boolean).join(' | ') || '(no output)';
    const err = new Error(`Could not detect a supported OS (Debian/Ubuntu, RHEL/Fedora, Alpine, or Windows) inside the guest — raw output: ${detail.slice(0, 300)}`);
    err.osFamily = 'unknown';
    throw err;
  }
  return family;
}

const DRY_RUN_COMMANDS = {
  debian: 'export DEBIAN_FRONTEND=noninteractive; apt-get update -qq 2>&1; apt-get -s upgrade 2>&1',
  rhel: '(command -v dnf >/dev/null && dnf check-update || yum check-update) 2>&1; true',
  alpine: 'apk update -q 2>&1; apk upgrade --simulate 2>&1',
  windows: `
$ErrorActionPreference = 'Stop'
try {
  $session = New-Object -ComObject Microsoft.Update.Session
  $searcher = $session.CreateUpdateSearcher()
  Write-Output "Searching for updates..."
  $result = $searcher.Search("IsInstalled=0 and Type='Software'")
  Write-Output "SearchComplete. ResultCode=$($result.ResultCode) UpdatesFound=$($result.Updates.Count)"
  foreach ($u in $result.Updates) {
    $kb = if ($u.KBArticleIDs.Count -gt 0) { "KB$($u.KBArticleIDs[0])" } else { 'N/A' }
    Write-Output "$kb|$($u.Title)"
  }
} catch {
  Write-Output "___SEARCH_FAILED___ $($_.Exception.Message)"
}
`.trim(),
};

const APPLY_COMMANDS = {
  debian: 'export DEBIAN_FRONTEND=noninteractive; apt-get update -qq 2>&1; apt-get -y upgrade 2>&1; echo "___EXIT_$?___"',
  rhel: '(command -v dnf >/dev/null && dnf -y upgrade || yum -y upgrade) 2>&1; echo "___EXIT_$?___"',
  alpine: 'apk update -q 2>&1; apk upgrade 2>&1; echo "___EXIT_$?___"',
  windows: `
$ErrorActionPreference = 'Stop'
try {
  $session = New-Object -ComObject Microsoft.Update.Session
  $searcher = $session.CreateUpdateSearcher()
  $result = $searcher.Search("IsInstalled=0 and Type='Software'")
  if ($result.Updates.Count -eq 0) { Write-Output 'No updates to install'; Write-Output '___EXIT_0___'; exit }
  $toInstall = New-Object -ComObject Microsoft.Update.UpdateColl
  foreach ($u in $result.Updates) {
    if (-not $u.EulaAccepted) { $u.AcceptEula() | Out-Null }
    $toInstall.Add($u) | Out-Null
    Write-Output "Queued: $($u.Title)"
  }
  $downloader = $session.CreateUpdateDownloader()
  $downloader.Updates = $toInstall
  Write-Output 'Downloading updates...'
  $downloadResult = $downloader.Download()
  Write-Output "Download result code: $($downloadResult.ResultCode)"
  $installer = $session.CreateUpdateInstaller()
  $installer.Updates = $toInstall
  Write-Output 'Installing updates...'
  $installResult = $installer.Install()
  Write-Output "Install result code: $($installResult.ResultCode)"
  if ($installResult.RebootRequired) { Write-Output 'REBOOT REQUIRED to finish installing updates.' }
  $exitCode = if ($installResult.ResultCode -eq 2) { 0 } else { 1 }
  Write-Output "___EXIT_\${exitCode}___"
} catch {
  Write-Output "ERROR: $($_.Exception.Message)"
  Write-Output "___EXIT_1___"
}
`.trim(),
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

function parseWindowsDryRun(output) {
  // Our own dry-run script prints one "KBxxxxxxx|Title" line per update.
  const packages = [];
  for (const line of output.split('\n')) {
    const m = line.match(/^(KB\d+|N\/A)\|(.+)$/);
    if (m) packages.push({ name: m[2].trim(), current_version: null, new_version: m[1] });
  }
  return packages;
}

function parseAlpineDryRun(output) {
  // apk upgrade --simulate prints lines like: (1/3) Upgrading pkgname (oldver -> newver)
  const packages = [];
  const re = /^(?:\(\d+\/\d+\)\s+)?Upgrading\s+(\S+)\s+\(([^\s]+)\s*->\s*([^)\s]+)\)/gm;
  let m;
  while ((m = re.exec(output))) {
    packages.push({ name: m[1], current_version: m[2], new_version: m[3] });
  }
  return packages;
}

/** Runs the dry-run simulation and stores a patch_runs row in
 * 'awaiting_approval' with the package snapshot. Never mutates the guest. */
async function runDryRun({ connectionId, conn, node, guestType, vmid, vmName, guestHost, hintOs, triggeredBy }) {
  const osFamily = await detectOsFamily(conn, guestType, node, vmid, hintOs);

  const cmd = DRY_RUN_COMMANDS[osFamily];
  const r = await execFor(conn, guestType, node, vmid, cmd, { timeoutMs: osFamily === 'windows' ? 240000 : 120000, osFamily, guestHost });

  if (osFamily === 'windows' && r.stdout.includes('___SEARCH_FAILED___')) {
    const m = r.stdout.match(/___SEARCH_FAILED___\s*(.*)/);
    throw new Error(`Windows Update search failed inside the guest: ${(m?.[1] || 'unknown error').trim().slice(0, 300)}`);
  }

  const parsers = { debian: parseDebianDryRun, rhel: parseRhelDryRun, alpine: parseAlpineDryRun, windows: parseWindowsDryRun };
  const packages = (parsers[osFamily] || parseWindowsDryRun)(r.stdout);
  const status = packages.length === 0 ? 'up_to_date' : 'awaiting_approval';

  const row = db
    .prepare(
      `INSERT INTO patch_runs (connection_id, node, guest_type, vmid, vm_name, guest_host, os_family, status, packages_affected, dry_run_output, triggered_by, completed_at)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,${status === 'up_to_date' ? "datetime('now')" : 'NULL'})`
    )
    .run(connectionId, node, guestType, String(vmid), vmName || null, guestHost || null, osFamily, status, JSON.stringify(packages), r.stdout.slice(-20000), triggeredBy);

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
    const result = await execFor(conn, run.guest_type, run.node, run.vmid, cmd, { timeoutMs: run.os_family === 'windows' ? 3600000 : 1800000, onOutput, osFamily: run.os_family, guestHost: run.guest_host });

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
