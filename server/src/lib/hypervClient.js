'use strict';

const { executeScript } = require('./winrmClient');

// One Hyper-V host = one "node" in our generic hypervisor abstraction
// (no cluster concept here unless Failover Clustering is added later).
const NODE_NAME = 'host';

function parseJsonSafe(text, fallback) {
  try {
    const parsed = JSON.parse(text);
    return parsed;
  } catch {
    return fallback;
  }
}

/** Fast summary: host CPU/mem/disk + VM count — no per-VM detail. */
async function fetchNodesSummary(conn) {
  const ps = `
$ErrorActionPreference='SilentlyContinue'
$cpu = [math]::Round((Get-CimInstance Win32_Processor | Measure-Object -Property LoadPercentage -Average).Average)
$os = Get-CimInstance Win32_OperatingSystem
$memUsedPct = [math]::Round((($os.TotalVisibleMemorySize-$os.FreePhysicalMemory)/$os.TotalVisibleMemorySize)*100)
$memTotalGB = [math]::Round($os.TotalVisibleMemorySize/1MB,1)
$memUsedGB = [math]::Round(($os.TotalVisibleMemorySize-$os.FreePhysicalMemory)/1MB,1)
$sysDrive = Get-CimInstance Win32_LogicalDisk -Filter "DeviceID='C:'"
$diskPct = if ($sysDrive.Size -gt 0) { [math]::Round((($sysDrive.Size-$sysDrive.FreeSpace)/$sysDrive.Size)*100) } else { 0 }
$vms = Get-VM
$vmCount = ($vms | Where-Object { $_.State -ne 'Off' }).Count
$vmTotal = $vms.Count
$uptime = [int]((Get-Date)-$os.LastBootUpTime).TotalSeconds
[PSCustomObject]@{
  cpu_usage = $cpu; mem_usage = $memUsedPct; mem_used_gb = $memUsedGB; mem_max_gb = $memTotalGB
  disk_usage = $diskPct; vm_count = $vmTotal; running_count = $vmCount; uptime = $uptime
} | ConvertTo-Json -Compress
`;
  const r = await executeScript(conn, ps, 30);
  if (r.exitCode !== 0) throw new Error(r.stderr || 'WinRM connection failed — check host, port, and credentials');

  const data = parseJsonSafe(r.stdout.trim(), null);
  if (!data) throw new Error('Could not parse Hyper-V host stats (is the Hyper-V PowerShell module installed?)');

  return [
    {
      node: NODE_NAME, status: 'online',
      cpu_usage: data.cpu_usage || 0, mem_usage: data.mem_usage || 0, disk_usage: data.disk_usage || 0,
      mem_used_gb: String(data.mem_used_gb || 0), mem_max_gb: String(data.mem_max_gb || 0),
      uptime: data.uptime || 0, vm_count: data.vm_count || 0, running_count: data.running_count || 0, lxc_count: 0,
    },
  ];
}

/** Full VM list for the host, including IP addresses (via Hyper-V integration
 * services / KVP, when the guest has them running). */
async function fetchNodeDetail(conn) {
  const ps = `
$ErrorActionPreference='SilentlyContinue'
function Get-VMGuestKvp($vmName) {
  try {
    $cs = Get-CimInstance -Namespace root\\virtualization\\v2 -ClassName Msvm_ComputerSystem -Filter "ElementName='$vmName'"
    if (-not $cs) { return $null }
    $kvp = Get-CimAssociatedInstance -InputObject $cs -ResultClassName Msvm_KvpExchangeComponent
    if (-not $kvp -or -not $kvp.GuestIntrinsicExchangeItems) { return $null }
    $map = @{}
    foreach ($item in $kvp.GuestIntrinsicExchangeItems) {
      $xml = [xml]$item
      $props = $xml.INSTANCE.PROPERTY
      $n = ($props | Where-Object { $_.NAME -eq 'Name' }).VALUE
      $v = ($props | Where-Object { $_.NAME -eq 'Data' }).VALUE
      if ($n) { $map[$n] = $v }
    }
    return $map
  } catch { return $null }
}

$vms = Get-VM
$result = @()
foreach ($vm in $vms) {
  $ip = $null
  $os = $null

  # Primary: KVP guest exchange (needs Hyper-V "Data Exchange" integration service running in the guest)
  $kvp = Get-VMGuestKvp $vm.Name
  if ($kvp) {
    if ($kvp['OSName']) { $os = $kvp['OSName'] }
    if ($kvp['NetworkAddressIPv4']) {
      $ip = ($kvp['NetworkAddressIPv4'] -split ';' | Where-Object { $_ -and $_.Contains('.') -and -not $_.Contains(':') } | Select-Object -First 1)
    }
  }

  # Fallback: VM network adapter reported addresses (needs "Guest Service Interface" instead)
  if (-not $ip) {
    try {
      $adapters = Get-VMNetworkAdapter -VMName $vm.Name
      foreach ($a in $adapters) {
        $addr = $a.IPAddresses | Where-Object { $_ -and $_.Contains('.') -and -not $_.Contains(':') } | Select-Object -First 1
        if ($addr) { $ip = $addr; break }
      }
    } catch {}
  }

  # Disk usage from attached VHD/VHDX files (host-side file size vs. provisioned size)
  $diskUsedBytes = 0; $diskMaxBytes = 0
  try {
    $disks = Get-VMHardDiskDrive -VMName $vm.Name
    foreach ($d in $disks) {
      $vhd = Get-VHD -Path $d.Path
      if ($vhd) { $diskUsedBytes += $vhd.FileSize; $diskMaxBytes += $vhd.Size }
    }
  } catch {}

  $cpuPct = 0
  if ($vm.State -eq 'Running' -and $vm.CPUUsage -ne $null) { $cpuPct = [math]::Round($vm.CPUUsage) }
  $diskPct = if ($diskMaxBytes -gt 0) { [math]::Round(($diskUsedBytes/$diskMaxBytes)*100) } else { $null }

  $result += [PSCustomObject]@{
    vmid = $vm.Name; name = $vm.Name; status = if ($vm.State -eq 'Running') {'running'} else {'stopped'}
    type = 'vm'; os = $os; ip = $ip
    cpu_usage = $cpuPct
    mem_used_gb = [math]::Round($vm.MemoryAssigned/1GB,2); mem_max_gb = [math]::Round($vm.MemoryStartup/1GB,2)
    mem_usage = if ($vm.MemoryStartup -gt 0) { [math]::Round(($vm.MemoryAssigned/$vm.MemoryStartup)*100) } else { 0 }
    disk_used_gb = if ($diskUsedBytes -gt 0) { [math]::Round($diskUsedBytes/1GB,1) } else { $null }
    disk_max_gb = if ($diskMaxBytes -gt 0) { [math]::Round($diskMaxBytes/1GB,1) } else { $null }
    disk_usage = $diskPct
    uptime_s = [int]$vm.Uptime.TotalSeconds; cpus = $vm.ProcessorCount
  }
}
$result | ConvertTo-Json -Compress
`;
  const r = await executeScript(conn, ps, 60);
  if (r.exitCode !== 0) throw new Error(r.stderr || 'Failed to list Hyper-V VMs');

  let vms = parseJsonSafe(r.stdout.trim(), []);
  if (!Array.isArray(vms)) vms = vms ? [vms] : []; // PowerShell emits a single object, not an array, for one VM

  return { vms, lxc: [], storages: [] };
}

/** Power action by VM name (Hyper-V has no numeric vmid the way Proxmox
 * does — the frontend passes the VM's `name` as the identifier here). */
async function powerAction(conn, node, type, vmName, action) {
  const CMDS = {
    start: `Start-VM -Name '${vmName}'`,
    stop: `Stop-VM -Name '${vmName}' -Force`,
    shutdown: `Stop-VM -Name '${vmName}'`,
    reboot: `Restart-VM -Name '${vmName}' -Force`,
    reset: `Restart-VM -Name '${vmName}' -Force`,
    suspend: `Save-VM -Name '${vmName}'`,
    resume: `Start-VM -Name '${vmName}'`,
  };
  const cmd = CMDS[action];
  if (!cmd) throw new Error(`Unsupported action for Hyper-V: ${action}`);
  const r = await executeScript(conn, `$ErrorActionPreference='Stop'; ${cmd}`, 30);
  if (r.exitCode !== 0) throw new Error(r.stderr || `Hyper-V action '${action}' failed`);
}

module.exports = { fetchNodesSummary, fetchNodeDetail, powerAction };
