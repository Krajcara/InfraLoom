'use strict';

// A look at a guest right before and after patching: who else is using the package manager, which automatic
// updaters are running, and whether the machine now needs a restart. Plain POSIX sh in one line, no single
// quotes — the same command string travels through the QEMU agent, `pct exec` and SSH.

// The only things InfraLoom will ever pause — and only when asked, and always started again afterwards.
const UPDATER_UNITS = ['unattended-upgrades.service', 'packagekit.service', 'apt-daily.timer', 'apt-daily-upgrade.timer'];

const PREFLIGHT_SH = [
  `for u in ${UPDATER_UNITS.join(' ')}; do s=$(systemctl is-active $u 2>/dev/null); case "$s" in active) echo "SVC:$u";; esac; done`,
  // Holders of apt/dpkg locks. Detection by lock, not by process name: unattended-upgrades keeps an idle helper running all day.
  'lslocks -n -r -o PID,COMMAND,PATH 2>/dev/null | while read pid cmd path; do case "$path" in /var/lib/dpkg/lock*|/var/lib/apt/lists/lock|/var/cache/apt/archives/lock) echo "LOCK:$pid:$cmd";; esac; done',
].join('; ');

// Restart needed? Ubuntu (update-notifier-common) writes /var/run/reboot-required. Plain Debian does not, so fall back to
// "a newer kernel of the SAME flavour is installed than the one running". INFRALOOM_* only exist so this can be tested.
const REBOOT_DEBIAN_SH = [
  'BOOT=${INFRALOOM_BOOT:-/boot}; run=${INFRALOOM_KERNEL:-$(uname -r)}',
  'if [ -f /var/run/reboot-required ]; then echo "REBOOT:yes"; [ -f /var/run/reboot-required.pkgs ] && sort -u /var/run/reboot-required.pkgs | head -20 | sed "s/^/PKG:/"',
  'else fl=${run#*-}; fl=${fl#*-}; latest=$(ls $BOOT/vmlinuz-*-$fl 2>/dev/null | sed "s|.*/vmlinuz-||" | sort -V | tail -1); if [ -n "$latest" ] && [ "$latest" != "$run" ]; then echo "REBOOT:yes"; echo "PKG:kernel $latest installed, $run running"; else echo "REBOOT:no"; fi; fi',
].join('; ');

const REBOOT_RHEL_SH =
  'if command -v needs-restarting >/dev/null 2>&1; then needs-restarting -r >/dev/null 2>&1; rc=$?; if [ $rc -eq 1 ]; then echo "REBOOT:yes"; elif [ $rc -eq 0 ]; then echo "REBOOT:no"; else echo "REBOOT:unknown"; fi; else echo "REBOOT:unknown"; fi';

const INSPECT = {
  debian: `${PREFLIGHT_SH}; ${REBOOT_DEBIAN_SH}; echo INSPECT_DONE`,
  rhel: `${REBOOT_RHEL_SH}; echo INSPECT_DONE`,
};

function parseInspect(out) {
  const r = { complete: String(out).includes('INSPECT_DONE'), locks: [], updaters: [], reboot: null, rebootPackages: [] };
  const seen = new Set();
  for (const raw of String(out).split('\n')) {
    const l = raw.trim();
    if (l.startsWith('SVC:')) {
      const u = l.slice(4);
      if (UPDATER_UNITS.includes(u) && !r.updaters.includes(u)) r.updaters.push(u);
    } else if (l.startsWith('LOCK:')) {
      const [, pid, ...rest] = l.split(':');
      if (!seen.has(pid)) { seen.add(pid); r.locks.push({ pid: Number(pid), name: rest.join(':') || '?' }); }
    } else if (l.startsWith('REBOOT:')) {
      const v = l.slice(7);
      r.reboot = v === 'yes' ? true : v === 'no' ? false : null;
    } else if (l.startsWith('PKG:')) {
      r.rebootPackages.push(l.slice(4));
    }
  }
  return r;
}

/** Only allowlisted unit names ever reach a shell. */
function unitsCommand(verb, units) {
  const ok = [...new Set(units)].filter((u) => UPDATER_UNITS.includes(u));
  if (!ok.length) throw new Error('No known updater units to ' + verb);
  return `systemctl ${verb} ${ok.join(' ')}`;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const describeLocks = (locks) => locks.map((l) => `${l.name} (PID ${l.pid})`).join(', ');

/** Waits (never kills) while another package manager holds apt/dpkg locks. Progress goes to `emit` so it shows in the console.
 * Throws an error carrying a ready-made `diagnosis` if the lock is still held after `timeoutMs`. */
async function waitForPackageManagers({ exec, emit, timeoutMs = 600000, intervalMs = 10000 }) {
  const t0 = Date.now();
  let announced = false;
  for (;;) {
    const pf = parseInspect((await exec(INSPECT.debian)).stdout);
    if (!pf.locks.length) {
      if (announced) emit('[InfraLoom] the other package manager has finished — continuing\n');
      return { waited: announced };
    }
    const who = describeLocks(pf.locks);
    if (!announced) {
      emit(`[InfraLoom] ${who} is using the package manager right now — waiting for it to finish (up to ${Math.round(timeoutMs / 60000)} min). InfraLoom never stops apt or dpkg.\n`);
      announced = true;
    }
    if (Date.now() - t0 >= timeoutMs) {
      const err = new Error(`${who} still holds the package manager lock after ${Math.round(timeoutMs / 60000)} minutes`);
      err.diagnosis = {
        code: 'lock', title: 'Another package manager kept running', detail: who,
        hint: 'Let it finish (or find out why it is stuck) and run the update again. InfraLoom never kills apt or dpkg — that is what corrupts the package database.',
      };
      throw err;
    }
    await sleep(intervalMs);
  }
}

module.exports = { UPDATER_UNITS, INSPECT, parseInspect, unitsCommand, waitForPackageManagers };
