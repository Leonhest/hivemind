import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { formatSummary } from '../src/core/format.js';
import type { Op } from '../src/core/types.js';
import { toOps, type Extracted } from '../src/extract.js';
import { findRepo, personOf, samePerson } from '../src/git.js';
import { writeOps } from '../src/store.js';

const NOW = Date.UTC(2026, 9, 15, 12);
const HOUR = 3_600_000;
let n = 0;
const op = (p: Partial<Op> & Pick<Op, 'kind' | 'key'>): Op => ({ id: `o${++n}`, member: 'anders-aaaaaa', lamport: n, ts: NOW - HOUR, type: 'upsert', data: {}, source: 'explicit', ...p });

const clone = (email: string) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hivemind-id-'));
  execFileSync('git', ['init', '-q', '--bare', 'remote.git'], { cwd: dir });
  execFileSync('git', ['clone', '-q', 'remote.git', 'me'], { cwd: dir, stdio: 'pipe' });
  execFileSync('git', ['config', 'user.email', email], { cwd: path.join(dir, 'me') });
  return path.join(dir, 'me');
};

describe('member ids', () => {
  it('are chosen once and stored, so they survive hostname changes', () => {
    const root = clone('anders03.vestrum@example.com');
    const id = findRepo(root)!.memberId;
    expect(id).toMatch(/^anders03-vestrum-[0-9a-f]{6}$/);
    expect(execFileSync('git', ['config', 'hivemind.member'], { cwd: root, encoding: 'utf8' }).trim()).toBe(id);
    expect(findRepo(root)!.memberId).toBe(id);
  });

  it('upgrading keeps publishing under the existing log instead of starting a new member', () => {
    const root = clone('leon.hesthaug@example.com');
    execFileSync('git', ['update-ref', 'refs/hivemind/leon-hesthaug-cf5b19', execFileSync('git', ['commit-tree', '4b825dc642cb6eb9a060e54bf8d69288fbee4904', '-m', 'x'], { cwd: root, encoding: 'utf8' }).trim()], { cwd: root });
    expect(findRepo(root)!.memberId).toBe('leon-hesthaug-cf5b19');
  });

  it('treat older ids of the same person as the same owner', () => {
    expect(personOf('anders03-vestrum-3fc98f')).toBe('anders03-vestrum');
    expect(samePerson('anders03-vestrum-3fc98f', 'anders03-vestrum-00c878')).toBe(true);
    expect(samePerson('anders03-vestrum-3fc98f', 'erik-123abc')).toBe(false);
    expect(samePerson(undefined, 'x')).toBe(false);
  });
});

describe('plan summary', () => {
  const ops = [
    op({ kind: 'decision', key: 'old-decision', data: { text: 'Use Postgres' }, ts: NOW - 72 * HOUR }),
    op({ kind: 'task', key: 'shipped', data: { title: 'Shipped long ago', status: 'done' }, ts: NOW - 48 * HOUR }),
    op({ kind: 'task', key: 'fresh-done', data: { title: 'Just finished', status: 'done' } }),
    op({ kind: 'task', key: 'later', data: { title: 'Backlog item', status: 'todo' } }),
    op({ kind: 'task', key: 'now', data: { title: 'In progress', status: 'doing', owner: 'anders-aaaaaa' } }),
    op({ kind: 'note', key: 'lab', data: { text: 'Lab box busy until 14:00' }, ts: NOW - 2 * HOUR }),
    op({ kind: 'note', key: 'stale', data: { text: 'Disk was full last week' }, ts: NOW - 100 * HOUR }),
  ];

  it('puts tasks first (in progress on top), hides old finished tasks and notes, shows recent notes', () => {
    const s = formatSummary(ops, { now: NOW, compact: true });
    const order = ['## Tasks', '[doing] In progress', '[todo] Backlog item', '[done] Just finished', '## Decisions', '## Notebook (last 24h)', '2h ago: Lab box busy until 14:00'];
    let at = -1;
    for (const part of order) {
      const i = s.indexOf(part);
      expect(i, part).toBeGreaterThan(at);
      at = i;
    }
    expect(s).not.toContain('Shipped long ago');
    expect(s).not.toContain('Disk was full');
    expect(s).toContain('(1 finished tasks and 1 older notes hidden');
  });

  it('shows every section within the budget, even for a large plan', () => {
    const long = 'x'.repeat(200);
    const big = [
      ...Array.from({ length: 30 }, (_, i) => op({ kind: 'task', key: `t${i}`, data: { title: `task ${i} ${long}`, status: 'doing' } })),
      ...Array.from({ length: 30 }, (_, i) => op({ kind: 'contract', key: `c${i}`, data: { spec: long } })),
      ...Array.from({ length: 30 }, (_, i) => op({ kind: 'decision', key: `d${i}`, data: { text: long } })),
      ...Array.from({ length: 10 }, (_, i) => op({ kind: 'question', key: `q${i}`, data: { text: long } })),
      ...Array.from({ length: 10 }, (_, i) => op({ kind: 'note', key: `n${i}`, data: { text: long } })),
    ];
    const s = formatSummary(big, { now: NOW, compact: true, maxChars: 6000 });
    for (const h of ['## Tasks', '## Contracts', '## Decisions', '## Open questions', '## Notebook (last 24h)']) expect(s).toContain(h);
    expect(s.length).toBeLessThanOrEqual(6000);
  });

  it('kind filter shows everything of that kind', () => {
    expect(formatSummary(ops, { now: NOW, kind: 'task' })).toContain('Shipped long ago');
    expect(formatSummary(ops, { now: NOW, kind: 'note' })).toContain('Disk was full');
  });

  it('caps each section in the compact view so later sections are never cut off', () => {
    const many = [...Array.from({ length: 30 }, (_, i) => op({ kind: 'decision', key: `d${i}`, data: { text: `decision ${i}` } })), op({ kind: 'task', key: 't', data: { title: 'Visible task', status: 'doing' } })];
    const s = formatSummary(many, { now: NOW, compact: true, maxChars: 4000 });
    expect(s).toContain('Visible task');
    expect(s).toContain('… 20 more (plan_get kind=decision)');
  });
});

describe('extractor: notes and answered questions', () => {
  const root = clone('dev@example.com');
  const repo = findRepo(root)!;
  writeOps(repo, [{ kind: 'question', key: 'which-db', data: { text: 'Postgres or SQLite?' } }]);
  const ex = (e: Partial<Extracted>) => ({ confidence: 0.9, evidence: 'q', ...e }) as Extracted;

  it('records state as notes and closes questions the work answered', () => {
    const ops = toOps([ex({ kind: 'note', key: 'lab-status', text: 'Lab box busy until 14:00' }), ex({ kind: 'question', key: 'which-db', answer: 'Postgres' })], repo, 's1');
    expect(ops[0]).toMatchObject({ kind: 'note', key: 'lab-status', data: { text: 'Lab box busy until 14:00' } });
    expect(ops[1]).toMatchObject({ type: 'close', kind: 'question', key: 'which-db', data: { answer: 'Postgres' } });
  });
});
