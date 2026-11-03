import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { reduce } from '../src/core/plan.js';
import { concludeTasks, sessionTasks } from '../src/extract.js';
import { findRepo, type Repo } from '../src/git.js';
import { handleEvent } from '../src/hook.js';
import { readState, writeOps } from '../src/store.js';
import { staleEntries } from '../src/tidy.js';

let repo: Repo;
beforeEach(() => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hivemind-life-'));
  execFileSync('git', ['init', '-q', '--bare', 'o.git'], { cwd: dir });
  execFileSync('git', ['clone', '-q', 'o.git', 'me'], { cwd: dir, stdio: 'pipe' });
  repo = findRepo(path.join(dir, 'me'))!;
  fs.mkdirSync(repo.stateDir, { recursive: true });
  fs.writeFileSync(path.join(repo.stateDir, 'daemon.pid'), String(process.pid));
  process.env.HIVEMIND_EXTRACTOR_BACKEND = 'none';
});
afterEach(() => {
  delete process.env.HIVEMIND_EXTRACTOR_BACKEND;
});

const task = (key: string) => reduce(readState(repo).ops).get(`task:${key}`);

describe('when a session ends', () => {
  it("settles the tasks that session worked on, and leaves other people's alone", async () => {
    handleEvent(repo, { event: 'SessionStart', sessionId: 's1' });
    writeOps(repo, [{ kind: 'task', key: 'mine', data: { title: 'Mine', status: 'doing', owner: repo.memberId }, agent: 's1' }]);
    writeOps(repo, [{ kind: 'task', key: 'other-session', data: { title: 'Other', status: 'doing', owner: repo.memberId }, agent: 's2' }]);
    expect(sessionTasks(repo, 's1').map((e) => e.key)).toEqual(['mine']);

    await concludeTasks(repo, 'claude', 's1', '');
    expect(task('mine')?.data).toMatchObject({ status: 'todo', note: 'The session working on this ended before it was confirmed finished.' });
    expect(task('mine')?.data.owner).toBe(repo.memberId);
    expect(task('other-session')?.data.status).toBe('doing');
  });

  it('counts tasks claimed through the MCP tool in that session', async () => {
    handleEvent(repo, { event: 'SessionStart', sessionId: 's3' });
    const [op] = writeOps(repo, [{ kind: 'task', key: 'claimed', data: { title: 'Claimed', status: 'doing' } }]);
    handleEvent(repo, { event: 'PostToolUse', sessionId: 's3', toolName: 'mcp__hivemind__task_claim', toolResponse: `Claimed task "claimed". [op:${op.id}]` });
    expect(sessionTasks(repo, 's3').map((e) => e.key)).toEqual(['claimed']);
  });

  it('a session that worked on no task changes nothing', async () => {
    handleEvent(repo, { event: 'SessionStart', sessionId: 's4' });
    const before = readState(repo).ops.length;
    await concludeTasks(repo, 'claude', 's4', '');
    expect(readState(repo).ops.length).toBe(before);
  });
});

describe('stale work', () => {
  it('closes unfinished tasks and questions untouched for a week, never finished or recent ones', () => {
    const now = Date.now();
    const e = (kind: 'task' | 'question', key: string, ageDays: number, status?: string) => ({
      kind, key, data: status ? { status } : {}, status: 'open' as const, createdBy: 'm', updatedBy: 'm', updatedAt: now - ageDays * 86_400_000, revisions: 1,
    });
    const out = staleEntries([e('task', 'old', 9, 'doing'), e('task', 'fresh', 2, 'doing'), e('task', 'done-old', 30, 'done'), e('question', 'q-old', 8)], now);
    expect(out.map((p) => [p.ref, p.reason])).toEqual([
      ['task:old', 'abandoned: no update for 9 days'],
      ['question:q-old', 'unanswered and untouched for 8 days'],
    ]);
  });
});
