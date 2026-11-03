import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { beforeEach, describe, expect, it } from 'vitest';
import { reduce } from '../src/core/plan.js';
import { buildPrompt, recentCommits } from '../src/extract.js';
import { findRepo, type Repo } from '../src/git.js';
import { closeMergedTasks, mergedPrs } from '../src/merged.js';
import { readState, writeOps } from '../src/store.js';

let repo: Repo;
let other: string;
const run = (cwd: string, ...args: string[]) => execFileSync('git', args, { cwd, stdio: 'pipe' }).toString();

beforeEach(() => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hivemind-merged-'));
  run(dir, 'init', '-q', '--bare', '-b', 'main', 'o.git');
  run(dir, 'clone', '-q', 'o.git', 'other');
  other = path.join(dir, 'other');
  run(other, 'commit', '-q', '--allow-empty', '-m', 'start');
  run(other, 'push', '-q', 'origin', 'HEAD:main');
  run(dir, 'clone', '-q', 'o.git', 'me');
  repo = findRepo(path.join(dir, 'me'))!;
});

const task = (key: string) => [...reduce(readState(repo).ops).values()].find((e) => e.key === key)!;

describe('merged PRs', () => {
  it('marks tasks done when the PR they mention is merged into the main branch', async () => {
    writeOps(repo, [
      { kind: 'task', key: 'dino-defaults', data: { title: 'PR #63962 is ready to merge: restore DINO defaults', status: 'doing' } },
      { kind: 'task', key: 'flight-recorder', data: { title: 'Fix capture accounting', status: 'doing', note: 'Opened PR63965' } },
      { kind: 'task', key: 'gh-style', data: { title: 'Signup form (pull request 7)', status: 'todo' } },
      { kind: 'task', key: 'unmerged', data: { title: 'PR 500 waits for review', status: 'doing' } },
      { kind: 'task', key: 'no-pr', data: { title: 'Mentions 63962 but no PR', status: 'doing' } },
    ]);
    run(other, 'commit', '-q', '--allow-empty', '-m', 'Merged PR 63962: fix(ml): restore broad admission');
    run(other, 'commit', '-q', '--allow-empty', '-m', 'Merge pull request 63965 from codex/capture into develop');
    run(other, 'commit', '-q', '--allow-empty', '-m', 'Add signup form (#7)');
    run(other, 'push', '-q', 'origin', 'HEAD:main');

    await closeMergedTasks(repo);

    expect(task('dino-defaults').data).toMatchObject({ status: 'done', note: expect.stringContaining('PR 63962 merged') });
    expect(task('flight-recorder').data.status).toBe('done');
    expect(task('gh-style').data.status).toBe('done');
    expect(task('unmerged').data.status).toBe('doing');
    expect(task('no-pr').data.status).toBe('doing');
    expect([...mergedPrs(repo, 'main').keys()].sort()).toEqual(['63962', '63965', '7']);
  });

  it('lists real commits for the extractor, not hivemind plan writes or branch-sync merges', () => {
    run(other, 'commit', '-q', '--allow-empty', '-m', 'Merged PR 12: real work');
    run(other, 'commit', '-q', '--allow-empty', '-m', "Merge branch 'main' into feature");
    run(other, 'push', '-q', 'origin', 'HEAD:main');
    run(repo.root, 'fetch', '-q', 'origin');
    for (let i = 0; i < 5; i++) writeOps(repo, [{ kind: 'task', key: `t${i}`, data: { title: 'x', status: 'todo' } }]);
    const commits = recentCommits(repo);
    expect(commits).toContain('Merged PR 12: real work');
    expect(commits).not.toContain('Merge branch');
    expect(commits).not.toMatch(/ hivemind$/m);
    expect(buildPrompt(repo, 'segment')).toContain('Merged PR 12');
  });
});
