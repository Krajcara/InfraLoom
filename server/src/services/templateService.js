'use strict';

const db = require('../db/database');
const { execOnHost } = require('../lib/proxmoxHostExec');
const { resolveSshCreds } = require('./patchService');
const proxmox = require('../lib/proxmoxClient');

const CLOUD_IMAGES = {
  'ubuntu-22.04': { label: 'Ubuntu 22.04 LTS Server (Jammy)', url: 'https://cloud-images.ubuntu.com/jammy/current/jammy-server-cloudimg-amd64.img' },
  'ubuntu-24.04': { label: 'Ubuntu 24.04 LTS Server (Noble)', url: 'https://cloud-images.ubuntu.com/noble/current/noble-server-cloudimg-amd64.img' },
  'debian-12': { label: 'Debian 12 Server (Bookworm)', url: 'https://cloud.debian.org/images/cloud/bookworm/latest/debian-12-generic-amd64.qcow2' },
  'debian-11': { label: 'Debian 11 Server (Bullseye)', url: 'https://cloud.debian.org/images/cloud/bullseye/latest/debian-11-generic-amd64.qcow2' },
};

function shellEscape(s) {
  return `'${String(s).replace(/'/g, `'\\''`)}'`;
}

/** Builds the shell script that reproduces the manual template-creation
 * steps: download the cloud image, create a skeleton VM, import the image
 * as its disk, attach a cloud-init drive, and convert to a template. */
function buildScript({ vmid, name, imageUrl, storage, cores, memoryMb, bridge }) {
  const filename = `cloudimg-${vmid}.img`;
  return `
set -e
cd /var/lib/vz/template/iso
if [ ! -f ${shellEscape(filename)} ]; then
  echo "Downloading cloud image..."
  wget -q ${shellEscape(imageUrl)} -O ${shellEscape(filename)}
else
  echo "Cloud image already downloaded, reusing it."
fi

echo "Creating VM ${vmid}..."
qm create ${vmid} --name ${shellEscape(name)} --memory ${memoryMb} --cores ${cores} --net0 virtio,bridge=${shellEscape(bridge)}

echo "Importing disk..."
qm importdisk ${vmid} ${shellEscape(filename)} ${shellEscape(storage)}

echo "Attaching disk and cloud-init drive..."
qm set ${vmid} --scsihw virtio-scsi-pci --scsi0 ${shellEscape(storage)}:vm-${vmid}-disk-0
qm set ${vmid} --ide2 ${shellEscape(storage)}:cloudinit
qm set ${vmid} --boot order=scsi0
qm set ${vmid} --serial0 socket --vga serial0

echo "Converting to template..."
qm template ${vmid}

echo "Done."
echo "___EXIT_$?___"
`.trim();
}

async function createTemplate({ connectionId, conn, node, name, imageKey, storage, cores, memoryMb, bridge, vmid: requestedVmid, triggeredBy }) {
  const image = CLOUD_IMAGES[imageKey];
  if (!image) throw new Error(`Unknown cloud image: ${imageKey}`);

  const row = db
    .prepare(`INSERT INTO template_jobs (connection_id, node, name, vmid, status, triggered_by) VALUES (?,?,?,?,'running',?)`)
    .run(connectionId, node, name, null, triggeredBy);
  const id = row.lastInsertRowid;
  const io = global.io;

  let vmid;
  let creds;
  try {
    vmid = requestedVmid ? parseInt(requestedVmid, 10) : await proxmox.nextFreeVmid(conn);
    if (!Number.isInteger(vmid) || vmid < 100) throw new Error(`Invalid VMID: ${requestedVmid}`);
    db.prepare('UPDATE template_jobs SET vmid = ? WHERE id = ?').run(String(vmid), id);
    creds = resolveSshCreds(conn, node);
  } catch (err) {
    db.prepare("UPDATE template_jobs SET status='failed', error=?, completed_at=datetime('now') WHERE id=?").run(err.message, id);
    if (io) io.emit('template:complete', { jobId: id, status: 'failed', error: err.message });
    throw err;
  }

  let accumulated = '';
  const onOutput = (chunk) => {
    accumulated += chunk;
    if (accumulated.length > 100000) accumulated = accumulated.slice(-100000);
    if (io) io.emit('template:output', { jobId: id, chunk });
    db.prepare('UPDATE template_jobs SET output = ? WHERE id = ?').run(accumulated, id);
  };

  const script = buildScript({ vmid, name, imageUrl: image.url, storage, cores, memoryMb, bridge });

  try {
    const result = await execOnHost(creds, script, { timeoutMs: 1800000, onOutput });
    const exitMatch = result.stdout.match(/___EXIT_(\d+)___/);
    const exitCode = exitMatch ? parseInt(exitMatch[1], 10) : result.exitCode;
    const status = exitCode === 0 ? 'completed' : 'failed';

    db.prepare("UPDATE template_jobs SET status=?, output=?, completed_at=datetime('now') WHERE id=?").run(status, accumulated, id);
    if (io) io.emit('template:complete', { jobId: id, status, vmid });
    return { id, status, vmid };
  } catch (err) {
    db.prepare("UPDATE template_jobs SET status='failed', error=?, completed_at=datetime('now') WHERE id=?").run(err.message, id);
    if (io) io.emit('template:complete', { jobId: id, status: 'failed', error: err.message });
    throw err;
  }
}

async function deleteTemplate(conn, node, vmid) {
  await proxmox.deleteVm(conn, node, vmid);
}

module.exports = { createTemplate, deleteTemplate, CLOUD_IMAGES };
