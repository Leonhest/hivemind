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

export function git(cwd: string, args: string[], input?: string): string {
  return execFileSync('git', args, { cwd, input, encoding: 'utf8', env: GIT_ENV, stdio: ['pipe', 'pipe', 'pipe'] }).trim();
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
    execFile('git', args, { cwd, encoding: 'utf8', env: GIT_ENV, timeout: timeoutMs }, (err, stdout, stderr) =>
      err ? reject(new Error(stderr.trim() || err.message)) : resolve(stdout.trim()),
    );
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

export function readOpsFile(repo: Repo, commit: string): string {
  return tryGit(repo.root, ['cat-file', 'blob', `${commit}:ops.jsonl`]) ?? '';
}

/** Append lines to this member's ops.jsonl as a new commit on its ref. Caller holds the store lock. */
export function appendToOwnRef(repo: Repo, lines: string[]): void {
  const prev = tryGit(repo.root, ['rev-parse', '-q', '--verify', repo.ownRef]);
  const existing = prev ? readOpsFile(repo, prev) : '';
  const content = (existing ? existing + '\n' : '') + lines.join('\n') + '\n';
  const blob = git(repo.root, ['hash-object', '-w', '--stdin'], content);
  const tree = git(repo.root, ['mktree'], `100644 blob ${blob}\tops.jsonl\n`);
  const commit = git(repo.root, ['commit-tree', tree, ...(prev ? ['-p', prev] : []), '-m', 'hivemind']);
  git(repo.root, ['update-ref', repo.ownRef, commit, ...(prev ? [prev] : [])]);
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
