'use strict';

const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');
const db = require('../db/database');
const { buildToken } = require('../lib/proxmoxClient');
const { resolveSshCreds } = require('./patchService');
const { ensureManagementKey, hashPassword } = require('../lib/sshKeyService');

const PROJECT_ROOT = path.resolve(__dirname, '..', '..', '..');
const TOFU_DIR = path.join(PROJECT_ROOT, 'data', 'tofu');
const PLUGIN_CACHE_DIR = path.join(TOFU_DIR, 'plugin-cache');
const DEPLOYMENTS_DIR = path.join(TOFU_DIR, 'deployments');
fs.mkdirSync(PLUGIN_CACHE_DIR, { recursive: true });
fs.mkdirSync(DEPLOYMENTS_DIR, { recursive: true });

/** Quotes and escapes a value for safe interpolation into an HCL string
 * literal. Deployment inputs come from an admin-only form, but they're
 * still user input assembled into source text that gets executed — this
 * is the same discipline as escaping for SQL or a shell command. */
function hclString(value) {
  const s = String(value).replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/\n/g, '\\n');
  return `"${s}"`;
}

/** Validates a value is a plain finite number before it's interpolated
 * into an HCL numeric context (unquoted) — numbers can't be escaped the
 * way strings can, so this rejects anything that isn't genuinely numeric. */
function hclNumber(value, fieldName) {
  const n = Number(value);
  if (!Number.isFinite(n)) throw new Error(`${fieldName} must be a number, got: ${value}`);
  return n;
}

function buildProviderBlock(conn, sshCreds) {
  // The bpg/proxmox provider needs SSH access to the node for a handful of
  // operations that have no REST API equivalent — uploading a snippet file
  // (our cloud-init data) is one of them. Reuses the same host-level SSH
  // credentials already configured for LXC patch management, since it's
  // the identical kind of access (broad, host-level shell/file control).
  const sshBlock = sshCreds?.username && sshCreds?.password
    ? `
  ssh {
    agent    = false
    username = ${hclString(sshCreds.username)}
    password = ${hclString(sshCreds.password)}

    node {
      name    = ${hclString(sshCreds.nodeName)}
      address = ${hclString(sshCreds.host)}
    }
  }
`
    : '';

  return `
terraform {
  required_providers {
    proxmox = {
      source  = "bpg/proxmox"
      version = "~> 0.66"
    }
  }
}

provider "proxmox" {
  endpoint  = ${hclString(conn.url + '/')}
  api_token = ${hclString(buildToken(conn))}
  insecure  = true
${sshBlock}}
`;
}

function buildNetworkBlock(network, { withDns }) {
  if (network.mode === 'dhcp') {
    return `
    ip_config {
      ipv4 {
        address = "dhcp"
      }
    }`;
  }
  if (!/^\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}\/\d{1,2}$/.test(network.address || '')) {
    throw new Error(
      `Invalid static IP "${network.address}" — Proxmox needs CIDR notation (e.g. "192.168.1.50/24"), not a bare IP address.`
    );
  }
  const dnsBlock = withDns && network.dns?.length
    ? `
    dns {
      servers = [${network.dns.map(hclString).join(', ')}]
    }`
    : '';
  return `
    ip_config {
      ipv4 {
        address = ${hclString(network.address)}
        gateway = ${hclString(network.gateway)}
      }
    }${dnsBlock}`;
}

function buildVmConfig(conn, vars) {
  const cores = hclNumber(vars.cores, 'cores');
  const memoryMb = hclNumber(vars.memoryMb, 'memoryMb');
  const diskGb = hclNumber(vars.diskGb, 'diskGb');
  const templateVmid = hclNumber(vars.templateVmid, 'templateVmid');
  const networkBlock = buildNetworkBlock(vars.network, { withDns: true });
  const vmidLine = vars.vmid ? `\n  vm_id     = ${hclNumber(vars.vmid, 'vmid')}\n` : '\n';
  const sshCreds = { ...resolveSshCreds(conn, vars.node), nodeName: vars.node };
  if (!sshCreds.username || !sshCreds.password) {
    throw new Error(
      "VM creation needs SSH access to the Proxmox host (used to upload the cloud-init snippet that installs the guest agent) — " +
      "set it under this connection's \"Patch Management (LXC)\" settings, or that node's SSH override, even if you don't use LXC patching."
    );
  }

  // Ensures qemu-guest-agent is installed and running once the clone boots
  // for the first time — most cloud images ship it already, but not all
  // do, and this makes it reliable either way rather than assuming.
  const sshUsername = vars.sshUsername || 'infraloom';
  const mgmtKey = ensureManagementKey();
  const passwordLines = vars.sshPassword
    ? [
        'chpasswd:',
        '  users:',
        `    - name: ${sshUsername}`,
        `      password: ${hashPassword(vars.sshPassword)}`,
        '      type: hash',
        '  expire: false',
        'ssh_pwauth: true',
      ]
    : [];

  const cloudInitYaml = [
    '#cloud-config',
    'packages:',
    '  - qemu-guest-agent',
    'users:',
    `  - name: ${sshUsername}`,
    '    groups: sudo',
    '    shell: /bin/bash',
    "    sudo: ['ALL=(ALL) NOPASSWD:ALL']",
    '    lock_passwd: false',
    '    ssh_authorized_keys:',
    `      - ${mgmtKey.publicKey}`,
    ...passwordLines,
    'runcmd:',
    '  - systemctl enable --now qemu-guest-agent',
    '',
  ].join('\n');

  return (
    buildProviderBlock(conn, sshCreds) +
    `
resource "proxmox_virtual_environment_file" "cloud_init" {
  content_type = "snippets"
  datastore_id = "local"
  node_name    = ${hclString(vars.node)}

  source_raw {
    data      = <<-EOT
      ${cloudInitYaml.split('\n').join('\n      ')}
      EOT
    file_name = ${hclString(`${vars.name}-cloud-init.yaml`)}
  }
}

resource "proxmox_virtual_environment_vm" "this" {
  name      = ${hclString(vars.name)}
  node_name = ${hclString(vars.node)}${vmidLine}
  clone {
    vm_id = ${templateVmid}
  }

  agent {
    enabled = true
  }

  cpu {
    cores = ${cores}
  }

  memory {
    dedicated = ${memoryMb}
  }

  disk {
    datastore_id = ${hclString(vars.storage)}
    size         = ${diskGb}
    interface    = "scsi0"
  }

  initialization {
    user_data_file_id = proxmox_virtual_environment_file.cloud_init.id
${networkBlock}
  }
}

output "vmid" {
  value = proxmox_virtual_environment_vm.this.vm_id
}
`
  ).trim();
}

function buildLxcConfig(conn, vars) {
  const cores = hclNumber(vars.cores, 'cores');
  const memoryMb = hclNumber(vars.memoryMb, 'memoryMb');
  const diskGb = hclNumber(vars.diskGb, 'diskGb');
  const networkBlock = buildNetworkBlock(vars.network, { withDns: false });
  const vmidLine = vars.vmid ? `\n  vm_id     = ${hclNumber(vars.vmid, 'vmid')}\n` : '\n';
  const dnsBlock = vars.network.mode === 'static' && vars.network.dns?.length
    ? `
  dns {
    servers = [${vars.network.dns.map(hclString).join(', ')}]
  }`
    : '';
  const mgmtKey = ensureManagementKey();
  const passwordLine = vars.sshPassword ? `\n      password = ${hclString(vars.sshPassword)}` : '';
  const userAccountBlock = `
    user_account {
      keys     = [${hclString(mgmtKey.publicKey)}]${passwordLine}
    }`;

  return (
    buildProviderBlock(conn) +
    `
resource "proxmox_virtual_environment_container" "this" {
  node_name = ${hclString(vars.node)}${vmidLine}
  initialization {
    hostname = ${hclString(vars.name)}${userAccountBlock}${networkBlock}
  }${dnsBlock}

  cpu {
    cores = ${cores}
  }

  memory {
    dedicated = ${memoryMb}
  }

  disk {
    datastore_id = ${hclString(vars.storage)}
    size         = ${diskGb}
  }

  operating_system {
    template_file_id = ${hclString(vars.templateFileId)}
    type             = "debian"
  }
}

output "vmid" {
  value = proxmox_virtual_environment_container.this.id
}
`
  ).trim();
}

/** OpenTofu colorizes its terminal output with ANSI escape codes, which
 * would render as garbage characters (not colors) in a plain HTML <pre>.
 * Passing -no-color to every command avoids most of this, but some
 * wrapped/library output still includes escapes — strip them as a safety
 * net regardless of source. */
function stripAnsi(s) {
  // eslint-disable-next-line no-control-regex
  return s.replace(/\x1b\[[0-9;]*[a-zA-Z]/g, '');
}

function runTofu(dir, args, { onOutput, timeoutMs = 300000 } = {}) {
  return new Promise((resolve, reject) => {
    const env = { ...process.env, TF_PLUGIN_CACHE_DIR: PLUGIN_CACHE_DIR, TF_IN_AUTOMATION: '1' };
    const proc = spawn('tofu', [...args, '-no-color'], { cwd: dir, env });
    let stdout = '';
    let stderr = '';
    const timer = setTimeout(() => {
      proc.kill();
      reject(new Error('tofu command timed out'));
    }, timeoutMs);

    proc.stdout.on('data', (chunk) => {
      const s = stripAnsi(chunk.toString('utf8'));
      stdout += s;
      if (onOutput) onOutput(s);
    });
    proc.stderr.on('data', (chunk) => {
      const s = stripAnsi(chunk.toString('utf8'));
      stderr += s;
      if (onOutput) onOutput(s);
    });
    proc.on('close', (code) => {
      clearTimeout(timer);
      resolve({ code, stdout, stderr });
    });
    proc.on('error', (err) => {
      clearTimeout(timer);
      reject(err);
    });
  });
}

/** Dry-run: writes the generated config, runs `tofu init` + `tofu plan`,
 * and stores a row awaiting approval. Nothing on Proxmox changes yet. */
async function planDeployment({ name, guestType, connectionId, conn, vars, triggeredBy }) {
  if (!['vm', 'lxc'].includes(guestType)) throw new Error(`Unsupported guest type: ${guestType}`);

  const row = db
    .prepare(
      `INSERT INTO iac_deployments (name, guest_type, connection_id, node, status, tf_vars, state_dir, triggered_by)
       VALUES (?,?,?,?,'planning',?,?,?)`
    )
    .run(name, guestType, connectionId, vars.node, JSON.stringify(vars), '', triggeredBy);
  const id = row.lastInsertRowid;

  const dir = path.join(DEPLOYMENTS_DIR, String(id));
  fs.mkdirSync(dir, { recursive: true });
  db.prepare('UPDATE iac_deployments SET state_dir = ? WHERE id = ?').run(dir, id);

  const tfConfig = guestType === 'vm' ? buildVmConfig(conn, vars) : buildLxcConfig(conn, vars);
  fs.writeFileSync(path.join(dir, 'main.tf'), tfConfig);
  db.prepare('UPDATE iac_deployments SET tf_config = ? WHERE id = ?').run(tfConfig, id);

  try {
    const init = await runTofu(dir, ['init', '-input=false'], { timeoutMs: 120000 });
    if (init.code !== 0) throw new Error(`tofu init failed:\n${init.stdout}\n${init.stderr}`);

    const plan = await runTofu(dir, ['plan', '-input=false', '-out=tfplan'], { timeoutMs: 120000 });
    const planOutput = init.stdout + '\n' + plan.stdout + (plan.stderr ? '\n' + plan.stderr : '');
    if (plan.code !== 0) {
      db.prepare("UPDATE iac_deployments SET status='failed', plan_output=?, error=? WHERE id=?").run(planOutput, 'tofu plan failed', id);
      throw new Error(`tofu plan failed:\n${planOutput}`);
    }

    db.prepare("UPDATE iac_deployments SET status='awaiting_approval', plan_output=? WHERE id=?").run(planOutput, id);
  } catch (err) {
    db.prepare("UPDATE iac_deployments SET status='failed', error=? WHERE id=?").run(err.message, id);
    throw err;
  }

  return db.prepare('SELECT * FROM iac_deployments WHERE id = ?').get(id);
}

/** Applies a previously-planned deployment (using the saved tfplan so what
 * gets approved is exactly what runs), streaming output over Socket.io. */
async function applyDeployment(id, approvedBy) {
  const deployment = db.prepare('SELECT * FROM iac_deployments WHERE id = ?').get(id);
  if (!deployment) throw new Error('Deployment not found');
  if (deployment.status !== 'awaiting_approval') throw new Error(`Deployment is not awaiting approval (status: ${deployment.status})`);

  db.prepare("UPDATE iac_deployments SET status='applying' WHERE id=?").run(id);
  const io = global.io;
  if (io) io.emit('iac:started', { deploymentId: id });

  let accumulated = '';
  const onOutput = (chunk) => {
    accumulated += chunk;
    if (accumulated.length > 200000) accumulated = accumulated.slice(-200000);
    if (io) io.emit('iac:output', { deploymentId: id, chunk });
    db.prepare('UPDATE iac_deployments SET apply_output = ? WHERE id = ?').run(accumulated, id);
  };

  try {
    const result = await runTofu(deployment.state_dir, ['apply', '-input=false', '-auto-approve', 'tfplan'], { timeoutMs: 900000, onOutput });
    const status = result.code === 0 ? 'completed' : 'failed';

    let vmid = null;
    if (status === 'completed') {
      try {
        const outputResult = await runTofu(deployment.state_dir, ['output', '-json', 'vmid'], { timeoutMs: 30000 });
        vmid = JSON.parse(outputResult.stdout).value?.toString() ?? null;
      } catch {
        // apply succeeded but we couldn't read the output value — not fatal
      }
      if (vmid) saveGuestSshCredentials(deployment, vmid);
    }

    db.prepare(
      "UPDATE iac_deployments SET status=?, apply_output=?, result_vmid=?, applied_at=datetime('now') WHERE id=?"
    ).run(status, accumulated, vmid, id);
    if (io) io.emit('iac:complete', { deploymentId: id, status, vmid });
    return { status, vmid };
  } catch (err) {
    db.prepare("UPDATE iac_deployments SET status='failed', error=? WHERE id=?").run(err.message, id);
    if (io) io.emit('iac:complete', { deploymentId: id, status: 'failed', error: err.message });
    throw err;
  }
}

function cancelDeployment(id) {
  db.prepare("UPDATE iac_deployments SET status='destroyed' WHERE id=? AND status='awaiting_approval'").run(id);
}

/** Registers the credentials this deployment set up on the guest — the
 * management SSH key always, plus a password and/or a known host if
 * those are available — into ssh_credentials, so Patch Management and
 * Ansible can reach the guest without a separate manual "set
 * credentials" step. For DHCP, the host isn't known yet; the row is
 * still created (key/username/password) with an empty host, same as the
 * existing manual-IP fallback already used for Hyper-V. */
function saveGuestSshCredentials(deployment, vmid) {
  const vars = JSON.parse(deployment.tf_vars || '{}');
  const username = deployment.guest_type === 'lxc' ? 'root' : (vars.sshUsername || 'infraloom');
  const host = vars.network?.mode === 'static' ? (vars.network.address || '').split('/')[0] : null;
  const mgmtKey = ensureManagementKey();

  db.prepare(
    `INSERT INTO ssh_credentials (connection_id, vmid, host, username, password, private_key)
     VALUES (?,?,?,?,?,?)
     ON CONFLICT(connection_id, vmid) DO UPDATE SET
       host = excluded.host, username = excluded.username, password = excluded.password,
       private_key = excluded.private_key, updated_at = datetime('now')`
  ).run(deployment.connection_id, vmid, host, username, vars.sshPassword || null, mgmtKey.privateKeyPath);
}

module.exports = { planDeployment, applyDeployment, cancelDeployment, buildVmConfig, buildLxcConfig, hclString, hclNumber };
