import { execFile, execFileSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import os from 'node:os';
import path from 'node:path';

// Never let git block on a credential prompt: hooks and the daemon run unattended.
const GIT_ENV = {
  ...process.env,
  GIT_TERMINAL_PROMPT: '0',
  GIT_AUTHOR_NAME: process.env.GIT_AUTHOR_NAME ?? 'hivemind',
  GIT_AUTHOR_EMAIL: process.env.GIT_AUTHOR_EMAIL ?? 'hivemind@localhost',
  GIT_COMMITTER_NAME: process.env.GIT_COMMITTER_NAME ?? 'hivemind',
  GIT_COMMITTER_EMAIL: process.env.GIT_COMMITTER_EMAIL ?? 'hivemind@localhost',
};

// Plan logs can be many MB. Node's default 1 MB output limit once made a read of a large log fail,
// which was then treated as an empty log, so it must never apply here.
const MAX_BUFFER = 1 << 30;

export function git(cwd: string, args: string[], input?: string, env?: Record<string, string>): string {
  return execFileSync('git', args, { cwd, input, encoding: 'utf8', env: env ? { ...GIT_ENV, ...env } : GIT_ENV, stdio: ['pipe', 'pipe', 'pipe'], maxBuffer: MAX_BUFFER }).trim();
}

export function tryGit(cwd: string, args: string[]): string | null {
  try {
    return git(cwd, args) || null;
  } catch {
    return null;
  }
}

export function gitAsync(cwd: string, args: string[], timeoutMs = 30_000): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile('git', args, { cwd, encoding: 'utf8', env: GIT_ENV, timeout: timeoutMs, maxBuffer: MAX_BUFFER }, (err, stdout, stderr) => {
      if (!err) return resolve(stdout.trim());
      const killed = (err as { killed?: boolean }).killed;
      reject(new Error(killed ? `git ${args[0]} timed out after ${Math.round(timeoutMs / 1000)}s` : stderr.trim() || err.message));
    });
  });
}

/** Is `ancestor` contained in `descendant`'s history? (Answered by exit code, not output.) */
export function isAncestor(cwd: string, ancestor: string, descendant: string): boolean {
  try {
    git(cwd, ['merge-base', '--is-ancestor', ancestor, descendant]);
    return true;
  } catch {
    return false;
  }
}

export interface Repo {
  root: string;
  /** Shared .git dir (same for all worktrees of a clone). */
  commonDir: string;
  stateDir: string;
  memberId: string;
  ownRef: string;
}

export const LOCAL_PREFIX = 'refs/hivemind/';
export const REMOTE_PREFIX = 'refs/hivemind-remote/';
export const FETCH_REFSPEC = `+${LOCAL_PREFIX}*:${REMOTE_PREFIX}*`;

const slug = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 32) || 'member';

/**
 * This clone's member id, chosen once and stored in .git/config (hivemind.member).
 * It used to be derived from the hostname, which macOS changes between networks, splitting one
 * person into several members. Existing clones keep the id they already publish under.
 */
function stableMemberId(root: string): string {
  const stored = tryGit(root, ['config', 'hivemind.member']);
  if (stored) return stored;
  const who = slug(tryGit(root, ['config', 'user.email'])?.split('@')[0] ?? tryGit(root, ['config', 'user.name']) ?? os.userInfo().username);
  // Reuse our newest existing log, so upgrading doesn't start yet another member.
  const existing = tryGit(root, ['for-each-ref', '--sort=-committerdate', '--format=%(refname:lstrip=2)', LOCAL_PREFIX])
    ?.split('\n')
    .find((id) => personOf(id) === who);
  const id = existing ?? `${who}-${randomBytes(3).toString('hex')}`;
  tryGit(root, ['config', 'hivemind.member', id]);
  return id;
}

/** "anders03-vestrum-3fc98f" → "anders03-vestrum": the person behind a member id. */
export const personOf = (memberId: string) => memberId.replace(/-[0-9a-f]{6}$/, '');

/** Same person, possibly under an older id (from before ids were stable) or another clone. */
export const samePerson = (a: unknown, b: unknown) => typeof a === 'string' && typeof b === 'string' && (a === b || personOf(a) === personOf(b));

/**
 * The repo containing `cwd`, or null if hivemind should stay out of the way:
 * no git repo, no origin remote, or turned off with `hivemind disable` (unless includeDisabled).
 */
export function findRepo(cwd: string, opts: { includeDisabled?: boolean } = {}): Repo | null {
  const root = tryGit(cwd, ['rev-parse', '--show-toplevel']);
  if (!root) return null;
  if (!tryGit(root, ['remote', 'get-url', 'origin'])) return null;
  if (!opts.includeDisabled && !isEnabled(root)) return null;
  const commonDir = path.resolve(root, git(root, ['rev-parse', '--git-common-dir']));
  const memberId = process.env.HIVEMIND_MEMBER ?? stableMemberId(root);
  return { root, commonDir, stateDir: path.join(commonDir, 'hivemind'), memberId, ownRef: LOCAL_PREFIX + memberId };
}

export function readRefs(repo: Repo): Record<string, string> {
  const out = tryGit(repo.root, ['for-each-ref', '--format=%(refname) %(objectname)', LOCAL_PREFIX, REMOTE_PREFIX]);
  const refs: Record<string, string> = {};
  for (const line of out?.split('\n') ?? []) {
    const [name, sha] = line.split(' ');
    if (name && sha) refs[name] = sha;
  }
  return refs;
}

/**
 * Log layout in a member's ref:
 *   ops.jsonl                     legacy single file (hivemind ≤ 0.1.11), no longer rewritten
 *   log/<bucket>/<n>.jsonl        one small file per write (hivemind ≥ 0.1.12)
 * Writing one new file per batch keeps commits and pushes small; rewriting one growing file made
 * every write cost the whole log.
 */
const LOG_DIR = 'log/';
const isLogPath = (p: string) => p === 'ops.jsonl' || p.startsWith(LOG_DIR);

/** Blob ids of every log file in a commit, keyed by path. */
export function logBlobs(repo: Repo, commit: string): { path: string; sha: string }[] {
  const out = tryGit(repo.root, ['ls-tree', '-r', commit]);
  const files: { path: string; sha: string }[] = [];
  for (const line of out?.split('\n') ?? []) {
    const m = line.match(/^\d+ blob ([0-9a-f]+)\t(.+)$/);
    if (m && isLogPath(m[2])) files.push({ path: m[2], sha: m[1] });
  }
  return files;
}

/** Contents of many blobs in one git process. */
export function readBlobs(repo: Repo, shas: string[]): Map<string, string> {
  const result = new Map<string, string>();
  for (let i = 0; i < shas.length; i += 200) {
    const batch = shas.slice(i, i + 200);
    const out = execFileSync('git', ['cat-file', '--batch'], { cwd: repo.root, input: batch.join('\n') + '\n', env: GIT_ENV, maxBuffer: MAX_BUFFER });
    let at = 0;
    while (at < out.length) {
      const nl = out.indexOf(10, at);
      const [sha, type, size] = out.subarray(at, nl).toString('utf8').split(' ');
      if (type === 'missing') {
        at = nl + 1;
        continue;
      }
      const len = Number(size);
      result.set(sha, out.subarray(nl + 1, nl + 1 + len).toString('utf8'));
      at = nl + 1 + len + 1;
    }
  }
  return result;
}

/** Every op line in a commit's log (legacy file plus per-write files). */
export function readLog(repo: Repo, commit: string): string {
  const files = logBlobs(repo, commit);
  const blobs = readBlobs(repo, files.map((f) => f.sha));
  return files.map((f) => blobs.get(f.sha) ?? '').join('\n');
}

/** Kept for callers that only need the legacy file (tests, recovery). */
export function readOpsFile(repo: Repo, commit: string): string {
  return readLog(repo, commit);
}

/** Append lines to this member's ops.jsonl as a new commit on its ref. Caller holds the store lock. */
/** True while this member's log is still a single legacy ops.jsonl (written by hivemind ≤ 0.1.11). */
export function isLegacyLog(repo: Repo): boolean {
  const prev = tryGit(repo.root, ['rev-parse', '-q', '--verify', repo.ownRef]);
  if (!prev) return false;
  const files = logBlobs(repo, prev);
  return files.some((f) => f.path === 'ops.jsonl') && !files.some((f) => f.path.startsWith(LOG_DIR));
}

/**
 * Add lines to this member's log as one new file in a new commit. Caller holds the store lock.
 * `legacyAppend`, if given, is appended to the legacy ops.jsonl as well, so clients older than
 * 0.1.12 (which only read that file) still see it.
 */
export function appendToOwnRef(repo: Repo, lines: string[], legacyAppend: string[] = []): void {
  const prev = tryGit(repo.root, ['rev-parse', '-q', '--verify', repo.ownRef]);
  const index = { GIT_INDEX_FILE: path.join(repo.stateDir, 'log.index') };
  git(repo.root, prev ? ['read-tree', `${prev}^{tree}`] : ['read-tree', '--empty'], undefined, index);
  const existing = git(repo.root, ['ls-files', LOG_DIR], undefined, index);
  const n = (existing ? existing.split('\n').length : 0) + 1;
  const file = `${LOG_DIR}${String(Math.floor(n / 256)).padStart(4, '0')}/${String(n).padStart(8, '0')}.jsonl`;
  const blob = git(repo.root, ['hash-object', '-w', '--stdin'], lines.join('\n') + '\n');
  git(repo.root, ['update-index', '--add', '--cacheinfo', `100644,${blob},${file}`], undefined, index);
  if (legacyAppend.length) {
    const legacy = prev && logBlobs(repo, prev).find((f) => f.path === 'ops.jsonl');
    const old = legacy ? readBlobs(repo, [legacy.sha]).get(legacy.sha) ?? '' : '';
    const merged = (old.endsWith('\n') || !old ? old : old + '\n') + legacyAppend.join('\n') + '\n';
    const lblob = git(repo.root, ['hash-object', '-w', '--stdin'], merged);
    git(repo.root, ['update-index', '--add', '--cacheinfo', `100644,${lblob},ops.jsonl`], undefined, index);
  }
  const tree = git(repo.root, ['write-tree'], undefined, index);
  const commit = git(repo.root, ['commit-tree', tree, ...(prev ? ['-p', prev] : []), '-m', 'hivemind']);
  git(repo.root, ['update-ref', repo.ownRef, commit, ...(prev ? [prev] : [])]);
}

/**
 * Replace this member's log history with one commit holding every entry once. Old-format logs
 * carried a full copy of the growing file in every commit, so their history could take longer to
 * push than any timeout. Only this clone ever writes its own ref, so rewriting it is safe; the
 * push that follows uses --force-with-lease. A small legacy ops.jsonl tells older clients to update.
 */
export function compactOwnLog(repo: Repo, legacyNotice: string): boolean {
  const head = tryGit(repo.root, ['rev-parse', '-q', '--verify', repo.ownRef]);
  if (!head) return false;
  const seen = new Set<string>();
  const lines: string[] = [];
  for (const line of readLog(repo, head).split('\n')) {
    const id = line.match(/"id":"([^"]+)"/)?.[1];
    if (id && !seen.has(id)) {
      seen.add(id);
      lines.push(line);
    }
  }
  const index = { GIT_INDEX_FILE: path.join(repo.stateDir, 'log.index') };
  git(repo.root, ['read-tree', '--empty'], undefined, index);
  const blob = git(repo.root, ['hash-object', '-w', '--stdin'], lines.join('\n') + '\n');
  git(repo.root, ['update-index', '--add', '--cacheinfo', `100644,${blob},${LOG_DIR}0000/00000001.jsonl`], undefined, index);
  const notice = git(repo.root, ['hash-object', '-w', '--stdin'], legacyNotice + '\n');
  git(repo.root, ['update-index', '--add', '--cacheinfo', `100644,${notice},ops.jsonl`], undefined, index);
  const tree = git(repo.root, ['write-tree'], undefined, index);
  const commit = git(repo.root, ['commit-tree', tree, '-m', `hivemind: compacted log (was ${head.slice(0, 12)})`]);
  git(repo.root, ['update-ref', repo.ownRef, commit, head]);
  return true;
}

/**
 * Before 0.1.12 a log over 1 MB was read as empty and silently restarted, dropping older entries
 * from the head of the log (they still exist in its history). Returns every op line ever written
 * to this member's log that the current head lacks.
 */
export function lostOwnOps(repo: Repo): string[] {
  const head = tryGit(repo.root, ['rev-parse', '-q', '--verify', repo.ownRef]);
  if (!head) return [];
  const idOf = (line: string) => line.match(/"id":"([^"]+)"/)?.[1];
  const have = new Set(readLog(repo, head).split('\n').map(idOf).filter(Boolean));
  const shas = new Set<string>();
  for (const c of tryGit(repo.root, ['rev-list', head])?.split('\n') ?? []) {
    const legacy = logBlobs(repo, c).find((f) => f.path === 'ops.jsonl');
    if (legacy) shas.add(legacy.sha);
  }
  const lost = new Map<string, string>();
  const all = [...shas];
  for (let i = 0; i < all.length; i += 50) {
    for (const text of readBlobs(repo, all.slice(i, i + 50)).values()) {
      for (const line of text.split('\n')) {
        const id = line.trim() && idOf(line);
        if (id && !have.has(id) && !lost.has(id)) lost.set(id, line);
      }
    }
  }
  return [...lost.values()];
}

// --- per-clone on/off switch (stored in .git/config, never shared) ---

export const isEnabled = (root: string) => tryGit(root, ['config', '--bool', 'hivemind.enabled']) !== 'false';

export function setEnabled(repo: Repo, enabled: boolean): void {
  if (enabled) tryGit(repo.root, ['config', '--unset', 'hivemind.enabled']);
  else git(repo.root, ['config', '--bool', 'hivemind.enabled', 'false']);
}

/** owner/name for GitHub remotes (https or ssh), else null. */
export function githubSlug(remoteUrl: string): string | null {
  const m = remoteUrl.trim().match(/github\.com[:/]([^/]+)\/([^/]+?)(?:\.git)?\/?$/);
  return m ? `${m[1]}/${m[2]}` : null;
}
