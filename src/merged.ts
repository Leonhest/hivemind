import { reduce } from './core/plan.js';
import type { Entry } from './core/types.js';
import { gitAsync, tryGit, type Repo } from './git.js';
import { log } from './log.js';
import { readState, writeOps, type NewOp } from './store.js';

/**
 * Marks tasks done when the PR they mention is merged into the main branch. Works from merge
 * commit subjects alone, so it catches merges no agent was told about. Runs in the daemon.
 */

const MERGE_SUBJECTS = [
  /^Merged PR (\d+)\b/i, // Azure DevOps
  /^Merge pull request #?(\d+)\b/i, // GitHub merge commit (Azure also writes it without #)
  /\(#(\d+)\)$/, // GitHub squash merge
];

const PR_MENTION = /\b(?:PR|pull request)\s*#?\s*(\d{1,7})\b/gi;

export function mainBranch(repo: Repo): string | null {
  const head = tryGit(repo.root, ['symbolic-ref', '--short', 'refs/remotes/origin/HEAD']);
  if (head) return head.replace(/^origin\//, '');
  for (const name of ['main', 'master', 'develop']) if (tryGit(repo.root, ['rev-parse', '--verify', '-q', `refs/remotes/origin/${name}`])) return name;
  return null;
}

/** PR number → "hash subject" for PRs merged into the main branch in the last `days` days. */
export function mergedPrs(repo: Repo, branch: string, days = 14): Map<string, string> {
  const out = tryGit(repo.root, ['log', `refs/remotes/origin/${branch}`, '--first-parent', `--since=${days} days ago`, '-n2000', '--format=%h %s']) ?? '';
  const prs = new Map<string, string>();
  for (const line of out.split('\n')) {
    const subject = line.slice(line.indexOf(' ') + 1);
    for (const re of MERGE_SUBJECTS) {
      const m = subject.match(re);
      if (m) {
        if (!prs.has(m[1])) prs.set(m[1], line);
        break;
      }
    }
  }
  return prs;
}

export function prsMentioned(e: Entry): string[] {
  const text = `${e.data.title ?? ''} ${e.data.note ?? ''}`;
  return [...new Set([...text.matchAll(PR_MENTION)].map((m) => m[1]))];
}

/** Unfinished tasks whose mentioned PR has been merged. */
export function mergedTaskOps(entries: Entry[], prs: Map<string, string>): NewOp[] {
  const ops: NewOp[] = [];
  for (const e of entries) {
    if (e.kind !== 'task' || e.status !== 'open' || e.data.status === 'done') continue;
    const pr = prsMentioned(e).find((n) => prs.has(n));
    if (!pr) continue;
    const commit = prs.get(pr)!;
    ops.push({ kind: 'task', key: e.key, data: { status: 'done', note: `PR ${pr} merged (${commit.split(' ')[0]}).` }, source: 'inferred', evidence: commit.slice(0, 300) });
  }
  return ops;
}

/** Fetch the main branch and close tasks for merged PRs. Errors are logged, never thrown. */
export async function closeMergedTasks(repo: Repo): Promise<void> {
  try {
    const branch = mainBranch(repo);
    if (!branch) return;
    await gitAsync(repo.root, ['fetch', '-q', '--no-tags', 'origin', `+refs/heads/${branch}:refs/remotes/origin/${branch}`], 120_000).catch(() => {});
    const prs = mergedPrs(repo, branch);
    if (!prs.size) return;
    const ops = mergedTaskOps([...reduce(readState(repo).ops).values()], prs);
    if (!ops.length) return;
    writeOps(repo, ops);
    log(repo, `merged PRs: marked done ${ops.map((o) => o.key).join(', ')}`);
  } catch (err) {
    log(repo, `merged-PR check failed: ${(err as Error).message}`);
  }
}
