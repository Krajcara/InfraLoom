'use strict';

// Runs a long command on a Linux guest DETACHED from whatever carries it there, and follows it by reading its log.
//
// Why: the QEMU guest agent starts the command as its own child, and it only hands back output once the command has
// exited. So (1) an `apt` upgrade that updates or restarts qemu-guest-agent (or anything that restarts it, such as
// needrestart) gets killed together with the agent, and (2) one failed status call — the agent is busy writing an
// initramfs — used to throw the whole run away while the upgrade carried on unseen. Detached, the update lives in its
// own systemd unit (or at least its own session), writes to a log file, and InfraLoom polls that file with short
// commands that survive an agent that is slow or restarting.

const SH_B64 = (s) => Buffer.from(s, 'utf8').toString('base64');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const TRAILER = '@@INFRALOOM@@';
const MAX_CHUNK = 262144;

const paths = (runId) => {
  const base = `/var/tmp/infraloom-patch-${runId}`;
  return { unit: `infraloom-patch-${runId}`, script: `${base}.sh`, log: `${base}.log`, rc: `${base}.rc` };
};

function scriptFor(command, p) {
  return `#!/bin/sh\n# InfraLoom patch run — detached from the guest agent so that restarting the agent cannot kill the update.\n( ${command}\n) > ${p.log} 2>&1 < /dev/null\necho $? > ${p.rc}\n`;
}

function startCommand(p) {
  // systemd-run gives the update its own cgroup (survives a restart of the agent). Without systemd, or if systemd-run
  // refuses, fall back to a new session — still detached from the agent's process, though not from its cgroup.
  return [
    `rm -f ${p.log} ${p.rc}`,
    `if command -v systemd-run >/dev/null 2>&1 && [ -d /run/systemd/system ] && systemd-run --unit=${p.unit} --collect --quiet /bin/sh ${p.script}; then echo STARTED:systemd`,
    `else setsid /bin/sh ${p.script} >/dev/null 2>&1 < /dev/null & echo STARTED:setsid; fi`,
  ].join('; ');
}

// done-flag first, then the new bytes: if the command finishes in between, the next poll still returns the rest.
const pollCommand = (p, offset) =>
  `D=$([ -f ${p.rc} ] && echo done || echo running); tail -c +${offset + 1} ${p.log} 2>/dev/null | head -c ${MAX_CHUNK}; printf "\\n${TRAILER} %s %s\\n" "$D" "$(cat ${p.rc} 2>/dev/null)"`;

function parsePoll(stdout) {
  const i = stdout.lastIndexOf(`\n${TRAILER} `);
  if (i < 0) return null; // truncated or garbled reply: treat the poll as failed
  const [state, rc] = stdout.slice(i + TRAILER.length + 2).trim().split(/\s+/);
  return { chunk: stdout.slice(0, i), done: state === 'done', rc: rc === undefined || rc === '' ? null : Number(rc) };
}

/** @returns {{stdout: string, stderr: string, exitCode: number}} — stdout is the whole log. */
async function runDetached({ exec, command, runId, emit = () => {}, pollMs = 3000, maxPollFailures = 60, maxMs = 3600000 }) {
  const p = paths(runId);
  const put = await exec(`printf %s "${SH_B64(scriptFor(command, p))}" | base64 -d > ${p.script} && chmod 700 ${p.script} && echo WRITTEN`);
  if (!String(put.stdout).includes('WRITTEN')) throw new Error(`Could not prepare the update on the machine: ${(put.stderr || put.stdout || 'no output').trim().slice(0, 200)}`);

  const started = await exec(startCommand(p));
  if (!/STARTED:(systemd|setsid)/.test(started.stdout)) throw new Error(`Could not start the update on the machine: ${(started.stderr || started.stdout || 'no output').trim().slice(0, 200)}`);

  const t0 = Date.now();
  let offset = 0;
  let log = '';
  let failures = 0;
  let lastError = null;
  for (;;) {
    let reply = null;
    try {
      reply = parsePoll((await exec(pollCommand(p, offset))).stdout);
      if (!reply) throw new Error('unreadable status reply');
      failures = 0;
    } catch (err) {
      lastError = err;
      failures += 1;
      if (failures > maxPollFailures) {
        const e = new Error(`Lost contact with the machine while the update was running (${err.message})`);
        e.diagnosis = {
          code: 'agent_lost', title: 'Lost contact with the machine during the update', detail: err.message,
          hint: `The update runs on the machine itself and keeps going: see /var/tmp/infraloom-patch-${runId}.log there, and check "dpkg --audit". InfraLoom repairs an interrupted dpkg by itself on the next run.`,
        };
        e.partialLog = log;
        throw e;
      }
    }
    if (reply) {
      if (reply.chunk) {
        log += reply.chunk;
        offset += Buffer.byteLength(reply.chunk, 'utf8');
        emit(reply.chunk);
      }
      if (reply.done && !reply.chunk) {
        // best-effort tidy-up; the log of a FAILED run is kept for whoever has to look at it
        const m = log.match(/___EXIT_(\d+)___/);
        const exitCode = m ? Number(m[1]) : (reply.rc ?? -1);
        if (exitCode === 0) exec(`rm -f ${p.script} ${p.log} ${p.rc}`).catch(() => {});
        return { stdout: log, stderr: '', exitCode };
      }
      if (reply.chunk) continue; // more may be waiting: read again straight away
    }
    if (Date.now() - t0 > maxMs) {
      const e = new Error(`The update was still running after ${Math.round(maxMs / 60000)} minutes`);
      e.diagnosis = { code: 'timeout', title: 'The update took too long', detail: `${Math.round(maxMs / 60000)} minutes`, hint: `It is still running on the machine (log: /var/tmp/infraloom-patch-${runId}.log). Check it there; do not start another run until it has finished.` };
      throw e;
    }
    await sleep(pollMs);
  }
}

module.exports = { runDetached, paths, startCommand, pollCommand, parsePoll, scriptFor };
