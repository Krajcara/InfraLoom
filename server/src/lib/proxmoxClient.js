'use strict';

const axios = require('axios');
const https = require('https');

const httpsAgent = new https.Agent({ rejectUnauthorized: false });

function buildToken(conn) {
  const secret = conn.api_token || '';
  if (secret.includes('!') && secret.includes('=')) return secret;
  if (conn.token_id && secret) return `${conn.username}!${conn.token_id}=${secret}`;
  if (secret.includes('=')) return `${conn.username}!${secret}`;
  return secret;
}

async function pveGet(baseUrl, path, token) {
  const res = await axios.get(`${baseUrl}/api2/json${path}`, {
    headers: { Authorization: `PVEAPIToken=${token}` },
    httpsAgent,
    timeout: 12000,
  });
  return res.data.data;
}

const OS_MAP = {
  win11: 'Windows 11', win10: 'Windows 10', win2k22: 'Windows Server 2022',
  win2k19: 'Windows Server 2019', win2k16: 'Windows Server 2016',
  win2k12r2: 'Windows Server 2012 R2', win2k8r2: 'Windows Server 2008 R2',
  l26: 'Linux (2.6+)', l24: 'Linux (2.4)', other: 'Other OS',
};

function mapOs(ostype, desc) {
  if (desc) {
    const d = desc.toLowerCase();
    if (d.includes('ubuntu')) return 'Ubuntu';
    if (d.includes('debian')) return 'Debian';
    if (d.includes('centos')) return 'CentOS';
    if (d.includes('rocky')) return 'Rocky Linux';
    if (d.includes('windows server 2022')) return 'Windows Server 2022';
    if (d.includes('windows server 2019')) return 'Windows Server 2019';
  }
  return OS_MAP[ostype] || ostype || null;
}

// ── Pulse-style filesystem filter & dedup (guest-agent fsinfo -> disk usage) ──
const VIRTUAL_FS = new Set([
  'tmpfs', 'devtmpfs', 'cgroup', 'cgroup2', 'sysfs', 'proc', 'devpts', 'securityfs',
  'debugfs', 'tracefs', 'fusectl', 'configfs', 'pstore', 'hugetlbfs', 'mqueue', 'bpf',
  'overlay', 'overlayfs', 'autofs', 'fdescfs', 'devfs', 'linprocfs', 'linsysfs',
]);
const READONLY_FS = ['erofs', 'squashfs', 'iso9660', 'cdfs', 'udf', 'cramfs', 'romfs'];
const SKIP_PREFIXES = ['/dev', '/proc', '/sys', '/run', '/var/run/', '/var/lib/containers', '/snap'];
const OVERLAY_PATS = ['/overlay2/', '/overlay/', '/diff/', '/merged'];
const NETWORK_FS = ['fuse', '9p', 'nfs', 'cifs', 'smb'];

function shouldSkipFS(type, mountpoint, totalBytes, usedBytes) {
  const t = (type || '').toLowerCase();
  if (VIRTUAL_FS.has(t)) return true;
  if (READONLY_FS.some((r) => t.includes(r))) return true;
  if (NETWORK_FS.some((n) => t.includes(n))) return true;
  if ((t.includes('overlay') || t.includes('overlayfs')) && totalBytes > 0 && usedBytes >= totalBytes) return true;
  const mp = mountpoint || '';
  if (SKIP_PREFIXES.some((p) => mp.startsWith(p))) return true;
  if (OVERLAY_PATS.some((p) => mp.includes(p))) return true;
  return false;
}

function calcDiskFromFsinfo(mounts) {
  let diskUsed = 0;
  let diskTotal = 0;
  const seen = new Map();
  for (const fs of mounts || []) {
    const tb = fs['total-bytes'] || 0;
    const ub = fs['used-bytes'] || 0;
    if (!tb || !ub) continue;
    if (shouldSkipFS(fs.type, fs.mountpoint, tb, ub)) continue;
    let diskKey = '';
    const diskRaw = Array.isArray(fs.disk) ? fs.disk[0] : fs.disk;
    if (diskRaw && typeof diskRaw === 'object') {
      diskKey = diskRaw.dev || diskRaw.serial || (diskRaw['bus-type'] ? `${diskRaw['bus-type']}-${diskRaw.target || 0}` : '');
    }
    if (!diskKey && fs.mountpoint) {
      if (fs.mountpoint.length >= 2 && fs.mountpoint[1] === ':') {
        diskKey = fs.mountpoint.substring(0, 2).toUpperCase();
      } else {
        diskKey = fs.mountpoint === '/' ? 'root' : fs.mountpoint;
      }
    }
    const dedupeKey = `${diskKey}:${tb}`;
    if (!seen.has(dedupeKey)) {
      seen.set(dedupeKey, true);
      diskTotal += tb;
      diskUsed += ub;
    }
  }
  return { diskUsed, diskTotal };
}
// ── End Pulse-style helpers ──────────────────────────────────────────────

async function enrichVM(baseUrl, token, node, vm) {
  try {
    let config = {};
    let agentIp = null;
    try {
      config = await pveGet(baseUrl, `/nodes/${node}/qemu/${vm.vmid}/config`, token);
    } catch {
      // guest agent / config not reachable — proceed with basic status only
    }
    const isRunning = vm.status === 'running';
    if (isRunning) {
      try {
        const info = await pveGet(baseUrl, `/nodes/${node}/qemu/${vm.vmid}/agent/network-get-interfaces`, token);
        for (const iface of info?.result || []) {
          if (iface.name === 'lo') continue;
          const ipv4 = (iface['ip-addresses'] || []).find((a) => a['ip-address-type'] === 'ipv4');
          if (ipv4) {
            agentIp = ipv4['ip-address'];
            break;
          }
        }
      } catch {
        // guest agent not installed/running — no IP available this way
      }
    }
    if (!agentIp && config.net0) {
      const m = config.net0.match(/ip=([^,/]+)/);
      if (m) agentIp = m[1];
    }

    let diskUsed = 0;
    let diskTotal = 0;
    if (isRunning) {
      try {
        const fsinfo = await pveGet(baseUrl, `/nodes/${node}/qemu/${vm.vmid}/agent/get-fsinfo`, token);
        ({ diskUsed, diskTotal } = calcDiskFromFsinfo(fsinfo?.result));
      } catch {
        // guest agent fsinfo unavailable — disk usage stays unknown
      }
    }
    const diskMaxBytes = vm.maxdisk || 0;
    const diskUsagePct = diskTotal > 0 ? Math.round((diskUsed / diskTotal) * 100) : 0;

    return {
      vmid: vm.vmid, name: vm.name, status: vm.status, type: 'qemu',
      os: mapOs(config.ostype, config.description || vm.name), ip: agentIp,
      cpu_usage: isRunning && vm.cpu != null ? Math.round(vm.cpu * 100) : 0,
      mem_usage: isRunning && vm.mem && vm.maxmem ? Math.round((vm.mem / vm.maxmem) * 100) : 0,
      disk_usage: diskUsagePct,
      disk_used_gb: diskTotal > 0 ? (diskUsed / 1073741824).toFixed(1) : null,
      mem_used_gb: vm.mem ? (vm.mem / 1073741824).toFixed(1) : '0',
      mem_max_gb: vm.maxmem ? (vm.maxmem / 1073741824).toFixed(1) : '0',
      disk_max_gb: diskTotal > 0 ? (diskTotal / 1073741824).toFixed(1) : diskMaxBytes ? (diskMaxBytes / 1073741824).toFixed(1) : '0',
      uptime_s: vm.uptime || 0, cpus: vm.cpus || config.cores || 1,
    };
  } catch (e) {
    console.error(`[Proxmox] VM ${vm.vmid} enrichment error: ${e.message}`);
    return {
      vmid: vm.vmid, name: vm.name, status: vm.status, type: 'qemu',
      os: null, ip: null, cpu_usage: 0, mem_usage: 0, disk_usage: 0,
      disk_used_gb: null, mem_used_gb: '0', mem_max_gb: '0', disk_max_gb: '0',
      uptime_s: vm.uptime || 0, cpus: vm.cpus || 1,
    };
  }
}

async function enrichLXC(baseUrl, token, node, ct) {
  try {
    let config = {};
    try {
      config = await pveGet(baseUrl, `/nodes/${node}/lxc/${ct.vmid}/config`, token);
    } catch {
      // config unavailable — proceed with basic status only
    }
    let ip = null;
    const m = (config.net0 || '').match(/ip=([^,/]+)/);
    if (m && m[1] !== 'dhcp') ip = m[1];
    const isRunning = ct.status === 'running';

    let diskUsed = ct.disk || 0;
    let diskTotal = ct.maxdisk || 0;
    if (isRunning && diskTotal > 0 && diskUsed === 0) {
      try {
        const statusData = await pveGet(baseUrl, `/nodes/${node}/lxc/${ct.vmid}/status/current`, token);
        if (statusData?.disk) diskUsed = statusData.disk;
        if (statusData?.maxdisk) diskTotal = statusData.maxdisk;
      } catch {
        // current status unavailable — keep original disk/maxdisk values
      }
    }
    const diskUsagePct = diskTotal > 0 ? Math.round((diskUsed / diskTotal) * 100) : 0;

    return {
      vmid: ct.vmid, name: ct.name || ct.hostname, status: ct.status, type: 'lxc',
      os: config.ostype || ct.name, ip,
      cpu_usage: isRunning && ct.cpu != null ? Math.round(ct.cpu * 100) : 0,
      mem_usage: isRunning && ct.mem && ct.maxmem ? Math.round((ct.mem / ct.maxmem) * 100) : 0,
      disk_usage: diskUsagePct,
      disk_used_gb: diskUsed ? (diskUsed / 1073741824).toFixed(1) : null,
      mem_used_gb: ct.mem ? (ct.mem / 1073741824).toFixed(1) : '0',
      mem_max_gb: ct.maxmem ? (ct.maxmem / 1073741824).toFixed(1) : '0',
      disk_max_gb: diskTotal ? (diskTotal / 1073741824).toFixed(1) : '0',
      uptime_s: ct.uptime || 0, cpus: ct.cpus || 1,
    };
  } catch (e) {
    console.error(`[Proxmox] LXC ${ct.vmid} enrichment error: ${e.message}`);
    return {
      vmid: ct.vmid, name: ct.name || ct.hostname, status: ct.status, type: 'lxc',
      os: null, ip: null, cpu_usage: 0, mem_usage: 0, disk_usage: 0,
      disk_used_gb: null, mem_used_gb: '0', mem_max_gb: '0', disk_max_gb: '0',
      uptime_s: ct.uptime || 0, cpus: ct.cpus || 1,
    };
  }
}

/** Fetches nodes with enriched VM/LXC/storage detail for one Proxmox connection. */
/** Fast node summary: status, CPU/mem/disk, VM/LXC counts — no guest-agent
 * calls, so this is quick even with many VMs. Used for the node list view. */
async function fetchNodesSummary(conn) {
  const baseUrl = conn.url;
  const token = buildToken(conn);
  const nodes = await pveGet(baseUrl, '/nodes', token);

  const details = await Promise.all(
    nodes.map(async (node) => {
      if (node.status !== 'online') {
        return { node: node.node, status: node.status, cpu_usage: 0, mem_usage: 0, disk_usage: 0, mem_used_gb: '0', mem_max_gb: '0', vm_count: 0, lxc_count: 0, running_count: 0 };
      }
      const [vms, lxc] = await Promise.all([
        pveGet(baseUrl, `/nodes/${node.node}/qemu`, token).catch(() => []),
        pveGet(baseUrl, `/nodes/${node.node}/lxc`, token).catch(() => []),
      ]);
      return {
        node: node.node, status: node.status,
        cpu_usage: node.cpu != null ? Math.round(node.cpu * 100) : 0,
        mem_usage: node.mem && node.maxmem ? Math.round((node.mem / node.maxmem) * 100) : 0,
        disk_usage: node.disk && node.maxdisk ? Math.round((node.disk / node.maxdisk) * 100) : 0,
        mem_used_gb: node.mem ? (node.mem / 1073741824).toFixed(1) : '0',
        mem_max_gb: node.maxmem ? (node.maxmem / 1073741824).toFixed(1) : '0',
        maxcpu: node.maxcpu, uptime: node.uptime,
        vm_count: vms.length, lxc_count: lxc.length,
        running_count: vms.filter((v) => v.status === 'running').length + lxc.filter((v) => v.status === 'running').length,
      };
    })
  );

  return details.sort((a, b) => a.node.localeCompare(b.node));
}

/** Basic guest list for one node — no guest-agent calls, so it's cheap
 * enough to call across every node of every connection for an overview
 * page (unlike fetchNodeDetail, which enriches with IP/OS/disk usage). */
async function listGuestsBasic(conn, node) {
  const baseUrl = conn.url;
  const token = buildToken(conn);
  const [vms, lxc] = await Promise.all([
    pveGet(baseUrl, `/nodes/${node}/qemu`, token).catch(() => []),
    pveGet(baseUrl, `/nodes/${node}/lxc`, token).catch(() => []),
  ]);
  return [
    ...vms.map((v) => ({ vmid: v.vmid, name: v.name, type: 'qemu', status: v.status })),
    ...lxc.map((v) => ({ vmid: v.vmid, name: v.name || v.hostname, type: 'lxc', status: v.status })),
  ].sort((a, b) => (a.name || '').localeCompare(b.name || ''));
}

/** Full enriched VM/LXC/storage detail for ONE node — the expensive,
 * guest-agent-backed call. Fetch this only when the node is expanded. */
async function fetchNodeDetail(conn, nodeName) {
  const baseUrl = conn.url;
  const token = buildToken(conn);

  const [vms, lxc, storages] = await Promise.all([
    pveGet(baseUrl, `/nodes/${nodeName}/qemu`, token).catch(() => []),
    pveGet(baseUrl, `/nodes/${nodeName}/lxc`, token).catch(() => []),
    pveGet(baseUrl, `/nodes/${nodeName}/storage`, token).catch(() => []),
  ]);

  const enrichedVMs = await Promise.all(vms.map((vm) => enrichVM(baseUrl, token, nodeName, vm)));
  const enrichedLXC = await Promise.all(lxc.map((ct) => enrichLXC(baseUrl, token, nodeName, ct)));
  const enrichedStorages = storages.map((s) => ({
    storage: s.storage, type: s.type,
    status: s.active ? 'active' : 'inactive',
    total_gb: s.total ? (s.total / 1073741824).toFixed(1) : null,
    used_gb: s.used ? (s.used / 1073741824).toFixed(1) : null,
    avail_gb: s.avail ? (s.avail / 1073741824).toFixed(1) : null,
    usage_pct: s.total && s.used ? Math.round((s.used / s.total) * 100) : null,
  }));

  return {
    vms: enrichedVMs.sort((a, b) => (a.name || '').localeCompare(b.name || '')),
    lxc: enrichedLXC.sort((a, b) => (a.name || '').localeCompare(b.name || '')),
    storages: enrichedStorages,
  };
}

/** @deprecated kept for the aggregated dashboard-summary endpoint, which
 * only needs counts — prefer fetchNodesSummary + fetchNodeDetail for the UI. */
async function fetchNodes(conn) {
  const summary = await fetchNodesSummary(conn);
  const withDetail = await Promise.all(
    summary.map(async (node) => {
      if (node.status !== 'online') return { ...node, vms: [], lxc: [], storages: [] };
      const detail = await fetchNodeDetail(conn, node.node);
      return { ...node, ...detail };
    })
  );
  return withDetail;
}

async function powerAction(conn, node, type, vmid, action) {
  const baseUrl = conn.url;
  const token = buildToken(conn);
  await axios.post(
    `${baseUrl}/api2/json/nodes/${node}/${type}/${vmid}/status/${action}`,
    {},
    { headers: { Authorization: `PVEAPIToken=${token}` }, httpsAgent, timeout: 15000 }
  );
}

/** VMs already marked as a Proxmox template (the "golden image" a new VM
 * gets cloned from) — used to populate the template picker when creating
 * a new VM. */
async function listVmTemplates(conn, node) {
  const baseUrl = conn.url;
  const token = buildToken(conn);
  const vms = await pveGet(baseUrl, `/nodes/${node}/qemu`, token);
  return vms.filter((v) => v.template === 1).map((v) => ({ vmid: v.vmid, name: v.name }));
}

/** Storages on a node that can hold VM/container disks (content type
 * "images" for VM disks, "rootdir" for LXC). */
async function listStorages(conn, node) {
  const baseUrl = conn.url;
  const token = buildToken(conn);
  const storages = await pveGet(baseUrl, `/nodes/${node}/storage`, token);
  return storages
    .filter((s) => (s.content || '').includes('images') || (s.content || '').includes('rootdir'))
    .map((s) => ({
      storage: s.storage, type: s.type, content: s.content,
      total_gb: s.total ? (s.total / 1073741824).toFixed(1) : null,
      used_gb: s.used ? (s.used / 1073741824).toFixed(1) : null,
      avail_gb: s.avail ? (s.avail / 1073741824).toFixed(1) : null,
      usage_pct: s.total && s.used ? Math.round((s.used / s.total) * 100) : null,
    }));
}

/** LXC container templates already downloaded to a storage (ready to use
 * immediately — no download wait). */
async function listDownloadedLxcTemplates(conn, node, storage) {
  const baseUrl = conn.url;
  const token = buildToken(conn);
  const content = await pveGet(baseUrl, `/nodes/${node}/storage/${storage}/content?content=vztmpl`, token);
  return content.map((c) => ({ volid: c.volid, size: c.size }));
}

/** The full official catalog of LXC templates Proxmox can download
 * on-demand (`pveam` list, exposed via the node's aplinfo endpoint) —
 * this is what a "browse available templates" picker shows, distinct
 * from the (usually much shorter) already-downloaded list above. */
async function listAvailableLxcTemplates(conn, node) {
  const baseUrl = conn.url;
  const token = buildToken(conn);
  const list = await pveGet(baseUrl, `/nodes/${node}/aplinfo`, token);
  return list.map((t) => ({ template: t.template, section: t.section, description: t.headline || t.description, os: t.os }));
}

/** The next unused VMID, starting the search from Proxmox's own configured
 * default (usually 100) — used so template creation doesn't need to guess
 * or hardcode an ID that might collide with something already in use. */
async function nextFreeVmid(conn) {
  const baseUrl = conn.url;
  const token = buildToken(conn);
  const result = await pveGet(baseUrl, '/cluster/nextid', token);
  return parseInt(result, 10);
}

/** Deletes a VM (or a template, which is just a VM flagged template=1) —
 * this is a Proxmox background task, so the delete call returns quickly
 * but actual removal happens shortly after. */
async function deleteVm(conn, node, vmid) {
  const baseUrl = conn.url;
  const token = buildToken(conn);
  return axios({
    method: 'delete',
    url: `${baseUrl}/api2/json/nodes/${node}/qemu/${vmid}`,
    headers: { Authorization: `PVEAPIToken=${token}` },
    httpsAgent,
    timeout: 15000,
  });
}

/** Every VMID already in use on a node (VMs and containers both — the ID
 * space is shared between them in Proxmox), for validating a manually
 * entered VMID before attempting to use it. */
async function listUsedVmids(conn, node) {
  const baseUrl = conn.url;
  const token = buildToken(conn);
  const [vms, lxc] = await Promise.all([
    pveGet(baseUrl, `/nodes/${node}/qemu`, token).catch(() => []),
    pveGet(baseUrl, `/nodes/${node}/lxc`, token).catch(() => []),
  ]);
  return [...vms, ...lxc].map((g) => g.vmid);
}

module.exports = {
  fetchNodes, fetchNodesSummary, fetchNodeDetail, listGuestsBasic, powerAction, buildToken,
  listVmTemplates, listStorages, listDownloadedLxcTemplates, listAvailableLxcTemplates, nextFreeVmid, deleteVm,
  listUsedVmids,
};
