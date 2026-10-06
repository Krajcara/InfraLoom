'use strict';

// Turns the raw console output of a failed patch run into one plain sentence about the cause and a hint — so the
// run says "Another package manager was running" instead of leaving you to read 200 lines of apt output.
// Patterns come from real apt/dpkg messages. Order matters: the first match wins, most specific first.

const tail = (s, n = 60000) => (s.length > n ? s.slice(-n) : s);

/** @returns {{code: string, title: string, detail: string|null, hint: string}|null} null when nothing is recognised. */
function diagnose(output) {
  const text = tail(String(output || ''));
  let m;

  // Another apt/dpkg (unattended-upgrades, PackageKit, a second run) holds a lock.
  if ((m = /Could not get lock (\S+?)\.?\s+It is held by process (\d+) \(([^)]+)\)/.exec(text))) {
    return {
      code: 'lock', title: 'Another package manager was running',
      detail: `${m[3]} (PID ${m[2]}) holds ${m[1]}`,
      hint: 'InfraLoom waits for it for up to 10 minutes before starting. If this keeps happening, tick "Pause automatic updaters" when you approve. InfraLoom never kills apt or dpkg — stopping one mid-write is what corrupts the package database.',
    };
  }
  if (/Unable to acquire the dpkg (frontend )?lock/.test(text)) {
    return { code: 'lock', title: 'Another package manager was running', detail: null, hint: 'Run the update again in a few minutes, or tick "Pause automatic updaters" when you approve.' };
  }

  // dpkg left half-done by an earlier interrupted run — InfraLoom repairs this itself, so reaching here means the repair failed.
  if (/dpkg was interrupted/.test(text)) {
    return { code: 'dpkg_interrupted', title: 'dpkg was left in an interrupted state', detail: null, hint: 'InfraLoom tries "dpkg --configure -a" automatically. If it still fails, run that on the machine and read the first error it prints.' };
  }

  // A service the upgrade tried to restart would not come back.
  const restart = /invoke-rc\.d: initscript (\S+), action "(?:re)?start" failed/.exec(text) || /Job for (\S+?)\.service failed/.exec(text);
  if (restart) {
    const svc = restart[1];
    return {
      code: 'service_restart', title: `The service "${svc}" failed to restart during the upgrade`, detail: svc,
      hint: `On the machine: "systemctl status ${svc}" and "journalctl -xeu ${svc}". Something usually keeps it from stopping or starting (a stuck process, a port already in use, a bad config). Fix that, then run the update again.`,
    };
  }

  // A package's own install script failed.
  if ((m = /dpkg: error processing package (\S+)/.exec(text))) {
    const why = /(?:pre|post)-(?:installation|removal) script (?:subprocess )?returned error exit status (\d+)/.exec(text);
    return {
      code: 'package_error', title: `Package "${m[1]}" failed to install`, detail: why ? `its ${why[0].split(' ')[0]} script exited with status ${why[1]}` : null,
      hint: 'Read the lines just above the error in the console: the script usually says what it could not do. Fix that on the machine, then run "dpkg --configure -a" and update again.',
    };
  }

  if (/No space left on device/.test(text)) {
    return { code: 'disk_full', title: 'The machine ran out of disk space', detail: null, hint: 'Free space (apt-get clean, remove old kernels, grow the disk) and run the update again.' };
  }

  if (/NO_PUBKEY|is not signed|The repository .* does not have a Release file|Release file for .* is not valid yet|Clearsigned file isn.t valid|signatures couldn.t be verified/.test(text)) {
    return { code: 'repository', title: 'A software repository could not be verified', detail: (/(NO_PUBKEY \S+|Release file for \S+)/.exec(text) || [])[1] || null, hint: 'A missing signing key, an unsupported repository, or a wrong clock on the machine ("not valid yet"). Check the date/time first.' };
  }

  if ((m = /(Temporary failure resolving '([^']+)'|Could not resolve '([^']+)'|Failed to fetch (\S+)|Connection timed out|Unable to connect to (\S+))/.exec(text))) {
    return { code: 'network', title: 'The machine could not reach its package mirror', detail: m[2] || m[3] || m[4] || m[5] || null, hint: 'Check DNS, the default gateway/firewall and any proxy on the machine, then run the update again.' };
  }

  if (/Unmet dependencies|held broken packages|You might want to run .apt --fix-broken install/.test(text)) {
    return { code: 'broken_packages', title: 'Packages are in a broken or held state', detail: null, hint: 'On the machine run "apt-get -f install" and read what it says; remove or unhold the package it complains about.' };
  }

  return null;
}

module.exports = { diagnose };
