'use strict';

const fs = require('fs');
const path = require('path');
const db = require('../db/database');
const { buildVmConfig, runTofu, DEPLOYMENTS_DIR } = require('./iacService');
const { ensureManagementKey, KEY_PATH } = require('../lib/sshKeyService');
const { execOnHost } = require('../lib/proxmoxHostExec');
const k8s = require('../lib/k8sClient');

function log(clusterId, step, status, message) {
  const cluster = db.prepare('SELECT progress_log FROM k8s_clusters WHERE id = ?').get(clusterId);
  const entries = cluster?.progress_log ? JSON.parse(cluster.progress_log) : [];
  entries.push({ step, status, message, at: new Date().toISOString() });
  db.prepare('UPDATE k8s_clusters SET progress_log = ? WHERE id = ?').run(JSON.stringify(entries), clusterId);
  if (global.io) global.io.emit('k8s-cluster:progress', { clusterId, step, status, message });
}

function ipOnly(cidr) {
  return cidr.split('/')[0];
}

async function startClusterProvision({ name, connectionId, conn, node, storage, templateVmid, cores, memoryMb, diskGb, network, nodeIps, nodeVmids, nodeNames, nodeSshUsernames, nodeSshPasswords, controlPlaneCount, workerCount, triggeredBy }) {
  if (controlPlaneCount < 1) throw new Error('At least one control-plane node is required');
  const totalNodes = controlPlaneCount + workerCount;
  if (!Array.isArray(nodeIps) || nodeIps.length !== totalNodes) {
    throw new Error(`Expected exactly ${totalNodes} node IP address(es) (one per node), got ${nodeIps?.length ?? 0}`);
  }
  const vmids = Array.isArray(nodeVmids) && nodeVmids.length === totalNodes ? nodeVmids : new Array(totalNodes).fill(null);
  const customNames = Array.isArray(nodeNames) && nodeNames.length === totalNodes ? nodeNames : new Array(totalNodes).fill(null);
  const sshUsers = Array.isArray(nodeSshUsernames) && nodeSshUsernames.length === totalNodes ? nodeSshUsernames : new Array(totalNodes).fill(null);
  const sshPasswords = Array.isArray(nodeSshPasswords) && nodeSshPasswords.length === totalNodes ? nodeSshPasswords : new Array(totalNodes).fill(null);
  const nonBlankNames = customNames.filter(Boolean);
  if (new Set(nonBlankNames).size !== nonBlankNames.length) throw new Error('Node names must be unique — the same name was entered for more than one node');

  const nodeConfig = { node, storage, templateVmid, cores, memoryMb, diskGb, network, nodeIps, nodeVmids: vmids, nodeNames: customNames, controlPlaneCount, workerCount };
  const result = db
    .prepare(`INSERT INTO k8s_clusters (name, connection_id, node_config, status, triggered_by) VALUES (?,?,?,'provisioning',?)`)
    .run(name, connectionId, JSON.stringify(nodeConfig), triggeredBy);
  const clusterId = result.lastInsertRowid;

  const nodeRows = [];
  for (let i = 0; i < controlPlaneCount; i++) {
    const ip = nodeIps[i];
    const nodeName = customNames[i] || `${name}-cp-${i + 1}`;
    const sshUsername = sshUsers[i] || 'infraloom';
    const r = db.prepare(`INSERT INTO k8s_cluster_nodes (cluster_id, role, name, ip_address, vmid) VALUES (?,'control-plane',?,?,?)`).run(clusterId, nodeName, ipOnly(ip), vmids[i] || null);
    nodeRows.push({ id: r.lastInsertRowid, role: 'control-plane', name: nodeName, ip: ipOnly(ip), cidr: ip, vmid: vmids[i] || null, sshUsername, sshPassword: sshPasswords[i] || null });
  }
  for (let i = 0; i < workerCount; i++) {
    const ip = nodeIps[controlPlaneCount + i];
    const wVmid = vmids[controlPlaneCount + i];
    const nodeName = customNames[controlPlaneCount + i] || `${name}-worker-${i + 1}`;
    const sshUsername = sshUsers[controlPlaneCount + i] || 'infraloom';
    const r = db.prepare(`INSERT INTO k8s_cluster_nodes (cluster_id, role, name, ip_address, vmid) VALUES (?,'worker',?,?,?)`).run(clusterId, nodeName, ipOnly(ip), wVmid || null);
    nodeRows.push({ id: r.lastInsertRowid, role: 'worker', name: nodeName, ip: ipOnly(ip), cidr: ip, vmid: wVmid || null, sshUsername, sshPassword: sshPasswords[controlPlaneCount + i] || null });
  }

  // Runs in the background — the HTTP caller gets the cluster id back
  // immediately and polls (or listens on the k8s-cluster:progress socket
  // event) for status.
  runProvisioning(clusterId, connectionId, conn, nodeConfig, nodeRows).catch((err) => {
    db.prepare("UPDATE k8s_clusters SET status='failed', error=?, completed_at=datetime('now') WHERE id=?").run(err.message, clusterId);
    log(clusterId, 'provision', 'failed', err.message);
  });

  return { clusterId, totalNodes };
}

async function provisionOneVm(connectionId, conn, node, storage, templateVmid, cores, memoryMb, diskGb, cidr, network, nodeRow) {
  const vars = {
    node, storage, templateVmid, cores, memoryMb, diskGb,
    name: nodeRow.name,
    network: { mode: 'static', address: cidr, gateway: network.gateway, dns: network.dns },
    sshUsername: nodeRow.sshUsername || 'infraloom',
  };
  if (nodeRow.vmid) vars.vmid = nodeRow.vmid;
  if (nodeRow.sshPassword) vars.sshPassword = nodeRow.sshPassword;
  const tfConfig = buildVmConfig(conn, vars);
  const dir = path.join(DEPLOYMENTS_DIR, `k8s-node-${nodeRow.id}`);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'main.tf'), tfConfig);

  const init = await runTofu(dir, ['init', '-input=false'], { timeoutMs: 120000 });
  if (init.code !== 0) throw new Error(`tofu init failed for ${nodeRow.name}: ${init.stdout}\n${init.stderr}`);
  const apply = await runTofu(dir, ['apply', '-input=false', '-auto-approve'], { timeoutMs: 300000 });
  if (apply.code !== 0) throw new Error(`tofu apply failed for ${nodeRow.name}: ${apply.stdout}\n${apply.stderr}`);

  // Discover the real VMID (Proxmox auto-assigns one if the form left it
  // blank) so k8s_cluster_nodes reflects reality and SSH Terminal/Patch
  // Management can find this guest later.
  let realVmid = nodeRow.vmid || null;
  try {
    const outputResult = await runTofu(dir, ['output', '-json', 'vmid'], { timeoutMs: 30000 });
    realVmid = JSON.parse(outputResult.stdout).value?.toString() ?? realVmid;
  } catch {
    // apply succeeded but we couldn't read the output value — not fatal, keep whatever we had
  }
  if (realVmid) {
    db.prepare('UPDATE k8s_cluster_nodes SET vmid = ? WHERE id = ?').run(realVmid, nodeRow.id);
    const mgmtKey = ensureManagementKey();
    db.prepare(
      `INSERT INTO ssh_credentials (connection_id, vmid, host, username, password, private_key)
       VALUES (?,?,?,?,?,?)
       ON CONFLICT(connection_id, vmid) DO UPDATE SET
         host = excluded.host, username = excluded.username, password = excluded.password,
         private_key = excluded.private_key, updated_at = datetime('now')`
    ).run(connectionId, realVmid, nodeRow.ip, vars.sshUsername, nodeRow.sshPassword || null, mgmtKey.privateKeyPath);
  }
  nodeRow.vmid = realVmid;
}

/** Polls SSH reachability (using InfraLoom's own management key, which
 * the VM's cloud-init already trusts) rather than assuming a fixed boot
 * delay — cloning + first boot + cloud-init user setup takes variable
 * time depending on host load. */
async function waitForSsh(ip, username, timeoutMs = 300000) {
  const creds = { host: ip, port: 22, username, privateKey: KEY_PATH };
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    try {
      await execOnHost(creds, 'echo ready', { timeoutMs: 10000 });
      return;
    } catch {
      await new Promise((r) => setTimeout(r, 5000));
    }
  }
  throw new Error(`Timed out waiting for SSH on ${ip}`);
}

async function runProvisioning(clusterId, connectionId, conn, nodeConfig, nodeRows) {
  const { node, storage, templateVmid, cores, memoryMb, diskGb, network } = nodeConfig;
  ensureManagementKey();

  // ─── Create every VM (control-plane + workers) via OpenTofu ─────────────
  log(clusterId, 'provision-vms', 'running', `Creating ${nodeRows.length} VM(s)...`);
  for (const nr of nodeRows) {
    db.prepare("UPDATE k8s_cluster_nodes SET status='provisioning' WHERE id=?").run(nr.id);
    await provisionOneVm(connectionId, conn, node, storage, templateVmid, cores, memoryMb, diskGb, nr.cidr, network, nr);
    db.prepare("UPDATE k8s_cluster_nodes SET status='installed' WHERE id=?").run(nr.id); // "installed" here just means "VM exists"; k3s comes next
    log(clusterId, 'provision-vms', 'running', `${nr.name} (${nr.ip}) created.`);
  }
  log(clusterId, 'provision-vms', 'done', 'All VMs created.');

  // ─── Wait for SSH on every node ─────────────────────────────────────────
  log(clusterId, 'wait-ssh', 'running', 'Waiting for nodes to boot and become SSH-reachable...');
  for (const nr of nodeRows) {
    await waitForSsh(nr.ip, nr.sshUsername);
  }
  log(clusterId, 'wait-ssh', 'done', 'All nodes are SSH-reachable.');

  // ─── Install k3s server on the first control-plane node ────────────────
  const primaryCp = nodeRows.find((n) => n.role === 'control-plane');
  const cpCreds = { host: primaryCp.ip, port: 22, username: primaryCp.sshUsername, privateKey: KEY_PATH };
  log(clusterId, 'install-control-plane', 'running', `Installing k3s server on ${primaryCp.name}...`);
  await execOnHost(cpCreds, `curl -sfL https://get.k3s.io | sudo env K3S_NODE_NAME=${primaryCp.name} INSTALL_K3S_EXEC="--disable traefik --disable servicelb" sh -`, { timeoutMs: 180000 });

  // Wait for the API server itself, then grab the join token.
  const readyDeadline = Date.now() + 120000;
  while (Date.now() < readyDeadline) {
    const r = await execOnHost(cpCreds, 'sudo k3s kubectl get --raw=/readyz', { timeoutMs: 10000 }).catch(() => ({ exitCode: 1, stdout: '' }));
    if (r.exitCode === 0) break;
    await new Promise((res) => setTimeout(res, 5000));
  }
  const tokenResult = await execOnHost(cpCreds, 'sudo cat /var/lib/rancher/k3s/server/node-token', { timeoutMs: 15000 });
  const joinToken = tokenResult.stdout.trim();
  if (!joinToken) throw new Error('Could not read the k3s join token from the control-plane node');
  db.prepare("UPDATE k8s_cluster_nodes SET status='ready' WHERE id=?").run(primaryCp.id);
  log(clusterId, 'install-control-plane', 'done', `${primaryCp.name} is ready.`);

  // ─── Join every worker ───────────────────────────────────────────────────
  // The install script's own exit doesn't reliably mean the node actually
  // registered (image pulls for CNI/kube-proxy etc. can make a first-time
  // join take several minutes) — so after kicking off the install, this
  // separately polls the control-plane's own node list until the new
  // node's name actually shows up and is Ready, rather than just trusting
  // that the SSH command returning means success.
  const workers = nodeRows.filter((n) => n.role === 'worker');
  for (const w of workers) {
    log(clusterId, 'join-workers', 'running', `Installing k3s agent on ${w.name} (backgrounded, polling for completion)...`);
    const wCreds = { host: w.ip, port: 22, username: w.sshUsername, privateKey: KEY_PATH };

    // Kick off the install in the background on the remote host and
    // return immediately — a single long-running foreground SSH exec was
    // consistently hitting its timeout with no visibility into whether it
    // was genuinely stuck or just slow. Backgrounding it means this SSH
    // call itself finishes in seconds regardless, and we get real
    // progress visibility via the log file instead of guessing.
    await execOnHost(
      wCreds,
      `rm -f /tmp/k3s-join.log /tmp/k3s-join.done; nohup sh -c 'curl -sfL https://get.k3s.io | sudo env K3S_URL=https://${primaryCp.ip}:6443 K3S_TOKEN=${joinToken} K3S_NODE_NAME=${w.name} sh -; echo \\$? > /tmp/k3s-join.done' > /tmp/k3s-join.log 2>&1 < /dev/null &\ndisown || true\nsleep 1\necho started`,
      { timeoutMs: 20000 }
    );

    // k3s's installer ends with `systemctl start k3s-agent`, which BLOCKS
    // until the service reports ready — and that can hang indefinitely if
    // the agent is stuck retrying its registration with the control
    // plane, even though everything up to that point (download, binary
    // install, systemd unit setup) completed in seconds. So: only wait
    // briefly here to catch quick/early failures (bad download, curl
    // error) — beyond that, stop waiting on the script and rely entirely
    // on asking the control plane directly whether the node joined, which
    // is the real signal that matters regardless of whether that one
    // systemd call ever returns.
    log(clusterId, 'join-workers', 'running', `Waiting briefly to catch early failures on ${w.name}...`);
    let installExitCode = null;
    let lastLogTail = '';
    const quickCheckDeadline = Date.now() + 90000; // ~90s — plenty for download+systemd setup, per observed timing
    while (Date.now() < quickCheckDeadline) {
      const r = await execOnHost(wCreds, 'cat /tmp/k3s-join.done 2>/dev/null; echo ---; tail -c 2000 /tmp/k3s-join.log 2>/dev/null', { timeoutMs: 15000 }).catch(() => null);
      if (r) {
        const [donePart, logPart] = r.stdout.split('---\n');
        lastLogTail = (logPart || '').trim();
        if (donePart?.trim()) {
          installExitCode = parseInt(donePart.trim(), 10);
          break;
        }
      }
      await new Promise((res) => setTimeout(res, 10000));
    }
    if (installExitCode !== null && installExitCode !== 0) {
      throw new Error(`k3s-agent install on ${w.name} failed early (exit ${installExitCode}). Last log output:\n${lastLogTail || '(no output captured)'}`);
    }
    log(clusterId, 'join-workers', 'running', installExitCode === 0
      ? `k3s-agent install finished on ${w.name}.`
      : `Install script still running on ${w.name} (likely waiting on its own 'systemctl start') — checking the cluster directly instead of waiting on it further.`);

    log(clusterId, 'join-workers', 'running', `Waiting for ${w.name} to register and become Ready...`);
    let joined = false;
    const joinDeadline = Date.now() + 480000; // up to 8 more minutes for the node to actually appear Ready
    while (Date.now() < joinDeadline) {
      const r = await execOnHost(cpCreds, `sudo k3s kubectl get node ${w.name} -o jsonpath='{.status.conditions[?(@.type=="Ready")].status}'`, { timeoutMs: 15000 }).catch(() => ({ exitCode: 1, stdout: '' }));
      if (r.exitCode === 0 && r.stdout.trim() === 'True') {
        joined = true;
        break;
      }
      await new Promise((res) => setTimeout(res, 10000));
    }
    if (!joined) throw new Error(`${w.name} installed k3s but never appeared Ready in 'kubectl get nodes' — check 'systemctl status k3s-agent' and 'journalctl -u k3s-agent -n 100' on that node.`);

    db.prepare("UPDATE k8s_cluster_nodes SET status='ready' WHERE id=?").run(w.id);
    log(clusterId, 'join-workers', 'running', `${w.name} is Ready.`);
  }
  if (workers.length) log(clusterId, 'join-workers', 'done', `${workers.length} worker(s) joined.`);

  // ─── Create the read-only service account + token ──────────────────────
  log(clusterId, 'rbac', 'running', 'Creating read-only service account...');
  const rbacYaml = `apiVersion: v1
kind: ServiceAccount
metadata:
  name: infraloom-readonly
  namespace: kube-system
---
apiVersion: rbac.authorization.k8s.io/v1
kind: ClusterRole
metadata:
  name: infraloom-readonly
rules:
  - apiGroups: ["", "apps", "batch", "networking.k8s.io", "metrics.k8s.io", "storage.k8s.io"]
    resources: ["*"]
    verbs: ["get", "list", "watch"]
---
apiVersion: rbac.authorization.k8s.io/v1
kind: ClusterRoleBinding
metadata:
  name: infraloom-readonly
subjects:
  - kind: ServiceAccount
    name: infraloom-readonly
    namespace: kube-system
roleRef:
  kind: ClusterRole
  name: infraloom-readonly
  apiGroup: rbac.authorization.k8s.io
---
apiVersion: v1
kind: Secret
metadata:
  name: infraloom-readonly-token
  namespace: kube-system
  annotations:
    kubernetes.io/service-account.name: infraloom-readonly
type: kubernetes.io/service-account-token
`;
  await execOnHost(cpCreds, `cat <<'EOF' | sudo k3s kubectl apply -f -\n${rbacYaml}\nEOF`, { timeoutMs: 30000 });

  let token = '';
  const tokenDeadline = Date.now() + 60000;
  while (Date.now() < tokenDeadline) {
    const r = await execOnHost(cpCreds, `sudo k3s kubectl get secret infraloom-readonly-token -n kube-system -o jsonpath='{.data.token}' | base64 -d`, { timeoutMs: 15000 }).catch(() => ({ stdout: '' }));
    if (r.stdout?.trim()) {
      token = r.stdout.trim();
      break;
    }
    await new Promise((res) => setTimeout(res, 3000));
  }
  if (!token) throw new Error('Timed out waiting for the service account token to be issued');
  log(clusterId, 'rbac', 'done', 'Read-only access configured.');

  // ─── Register as a Phase-1 monitoring connection ────────────────────────
  const apiServer = `https://${primaryCp.ip}:6443`;
  await k8s.checkConnection({ api_server: apiServer, token });
  const connResult = db
    .prepare(`INSERT INTO k8s_connections (name, api_server, token, last_status, last_checked_at) VALUES (?,?,?,'ok',datetime('now'))`)
    .run(nodeConfigNameFallback(clusterId), apiServer, token);

  db.prepare("UPDATE k8s_clusters SET status='ready', k8s_connection_id=?, completed_at=datetime('now') WHERE id=?").run(connResult.lastInsertRowid, clusterId);
  log(clusterId, 'register', 'done', 'Cluster registered for monitoring.');
}

function nodeConfigNameFallback(clusterId) {
  const row = db.prepare('SELECT name FROM k8s_clusters WHERE id = ?').get(clusterId);
  return row?.name || `Cluster ${clusterId}`;
}

/** Deletes a cluster record. Best-effort destroys each node's VM via
 * `tofu destroy` first (a failed/partial provision often leaves real VMs
 * behind) — a node that never got far enough to have a deployment
 * directory, or whose destroy fails, is skipped rather than blocking the
 * whole deletion, since the goal is cleaning up InfraLoom's own records
 * either way. */
async function deleteCluster(clusterId) {
  const cluster = db.prepare('SELECT * FROM k8s_clusters WHERE id = ?').get(clusterId);
  if (!cluster) throw new Error('Cluster not found');
  const nodes = db.prepare('SELECT * FROM k8s_cluster_nodes WHERE cluster_id = ?').all(clusterId);

  const destroyResults = [];
  for (const n of nodes) {
    const dir = path.join(DEPLOYMENTS_DIR, `k8s-node-${n.id}`);
    if (!fs.existsSync(path.join(dir, 'main.tf'))) continue; // never got far enough to create a deployment — nothing to destroy
    try {
      const result = await runTofu(dir, ['destroy', '-input=false', '-auto-approve'], { timeoutMs: 180000 });
      destroyResults.push({ node: n.name, ok: result.code === 0, output: result.code === 0 ? null : `${result.stdout}\n${result.stderr}`.slice(-2000) });
    } catch (err) {
      destroyResults.push({ node: n.name, ok: false, output: err.message });
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  }

  db.prepare('DELETE FROM k8s_clusters WHERE id = ?').run(clusterId); // cascades to k8s_cluster_nodes
  return destroyResults;
}

module.exports = { startClusterProvision, deleteCluster };
