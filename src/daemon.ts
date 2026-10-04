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
const syncPath = (repo: Repo) => path.join(repo.stateDir, 'sync.json');

export interface SyncStatus {
  lastFetch?: number;
  lastPush?: number;
  lastError?: string;
  lastErrorAt?: number;
}

export function readSyncStatus(repo: Repo): SyncStatus {
  try {
    return JSON.parse(fs.readFileSync(syncPath(repo), 'utf8'));
  } catch {
    return {};
  }
}

function recordSync(repo: Repo, update: SyncStatus): void {
  try {
    fs.writeFileSync(syncPath(repo), JSON.stringify({ ...readSyncStatus(repo), ...update }));
  } catch {}
}

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
  let fetchFailures = 0;
  let pushFailures = 0;
  let nextPushAt = 0;
  const backoff = (n: number) => Math.min(60_000, 2_500 * 2 ** Math.min(n, 5));
  const fail = (what: string, err: unknown, n: number) => {
    log(repo, `${what} error (${n}): ${(err as Error).message}`);
    recordSync(repo, { lastError: `${what}: ${(err as Error).message.slice(0, 500)}`, lastErrorAt: Date.now() });
  };

  for (;;) {
    const idleFor = Date.now() - lastActivity(repo);
    if (idleFor > EXIT_AFTER_IDLE_MS) {
      log(repo, 'daemon exiting: idle');
      return;
    }
    // Push whenever our ref is ahead of what the remote is known to have.
    // Failures (e.g. no push access) back off independently, so fetching keeps working.
    const local = tryGit(repo.root, ['rev-parse', '-q', '--verify', repo.ownRef]);
    if (local && Date.now() >= nextPushAt && local !== tryGit(repo.root, ['rev-parse', '-q', '--verify', remoteOwn])) {
      try {
        await gitAsync(repo.root, ['push', '-q', 'origin', `${repo.ownRef}:${repo.ownRef}`]);
        git(repo.root, ['update-ref', remoteOwn, local]);
        recordSync(repo, { lastPush: Date.now() });
        pushFailures = 0;
      } catch (err) {
        fail('push', err, ++pushFailures);
        nextPushAt = Date.now() + backoff(pushFailures);
      }
    }
    const interval = (idleFor < ACTIVE_WINDOW_MS ? ACTIVE_FETCH_MS : IDLE_FETCH_MS) + (fetchFailures ? backoff(fetchFailures) : 0);
    if (Date.now() - lastFetch >= interval) {
      lastFetch = Date.now();
      try {
        await gitAsync(repo.root, ['fetch', '-q', '--no-tags', 'origin', FETCH_REFSPEC]);
        rebuild(repo);
        recordSync(repo, { lastFetch: Date.now() });
        fetchFailures = 0;
      } catch (err) {
        fail('fetch', err, ++fetchFailures);
      }
    }
    await new Promise((r) => setTimeout(r, 500));
  }
}
