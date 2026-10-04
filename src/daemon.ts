import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { FETCH_REFSPEC, REMOTE_PREFIX, git, gitAsync, tryGit, type Repo } from './git.js';
import { log } from './log.js';
import { lastActivity, rebuild } from './store.js';

const ACTIVE_FETCH_MS = Number(process.env.HIVEMIND_FETCH_MS ?? 3_000);
const IDLE_FETCH_MS = 30_000;
const ACTIVE_WINDOW_MS = 10 * 60_000;
const EXIT_AFTER_IDLE_MS = 30 * 60_000;

const pidPath = (repo: Repo) => path.join(repo.stateDir, 'daemon.pid');

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

export function daemonPid(repo: Repo): number | null {
  try {
    const pid = Number(fs.readFileSync(pidPath(repo), 'utf8'));
    return pid && alive(pid) ? pid : null;
  } catch {
    return null;
  }
}

/** Start the sync daemon for this clone if it isn't running. Returns immediately. */
export function ensureDaemon(repo: Repo): void {
  if (daemonPid(repo)) return;
  fs.mkdirSync(repo.stateDir, { recursive: true });
  const out = fs.openSync(path.join(repo.stateDir, 'daemon.log'), 'a');
  spawn(process.execPath, [process.argv[1], 'daemon'], { cwd: repo.root, detached: true, stdio: ['ignore', out, out] }).unref();
}

function claimPidFile(repo: Repo): boolean {
  fs.mkdirSync(repo.stateDir, { recursive: true });
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      fs.writeFileSync(pidPath(repo), String(process.pid), { flag: 'wx' });
      return true;
    } catch {
      if (daemonPid(repo)) return false;
      fs.rmSync(pidPath(repo), { force: true });
    }
  }
  return false;
}

export async function runDaemon(repo: Repo): Promise<void> {
  if (!claimPidFile(repo)) return;
  const release = () => {
    if (daemonPid(repo) === process.pid) fs.rmSync(pidPath(repo), { force: true });
  };
  process.on('exit', release);
  for (const sig of ['SIGINT', 'SIGTERM'] as const) process.on(sig, () => process.exit(0));
  log(repo, `daemon started pid=${process.pid} member=${repo.memberId}`);

  const remoteOwn = REMOTE_PREFIX + repo.memberId;
  let lastFetch = 0;
  let failures = 0;

  for (;;) {
    const idleFor = Date.now() - lastActivity(repo);
    if (idleFor > EXIT_AFTER_IDLE_MS) {
      log(repo, 'daemon exiting: idle');
      return;
    }
    const backoff = Math.min(failures, 5) * 5_000;
    try {
      // Push whenever our ref is ahead of what the remote is known to have.
      const local = tryGit(repo.root, ['rev-parse', '-q', '--verify', repo.ownRef]);
      if (local && local !== tryGit(repo.root, ['rev-parse', '-q', '--verify', remoteOwn])) {
        await gitAsync(repo.root, ['push', '-q', 'origin', `${repo.ownRef}:${repo.ownRef}`]);
        git(repo.root, ['update-ref', remoteOwn, local]);
      }
      const interval = (idleFor < ACTIVE_WINDOW_MS ? ACTIVE_FETCH_MS : IDLE_FETCH_MS) + backoff;
      if (Date.now() - lastFetch >= interval) {
        lastFetch = Date.now();
        await gitAsync(repo.root, ['fetch', '-q', '--no-tags', 'origin', FETCH_REFSPEC]);
        rebuild(repo);
      }
      failures = 0;
    } catch (err) {
      failures++;
      log(repo, `sync error (${failures}): ${(err as Error).message}`);
    }
    await new Promise((r) => setTimeout(r, 500));
  }
}
