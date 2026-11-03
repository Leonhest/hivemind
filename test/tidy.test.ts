import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { beforeEach, describe, expect, it } from 'vitest';
import { formatSummary } from '../src/core/format.js';
import { reduce } from '../src/core/plan.js';
import { toOps, type Extracted } from '../src/extract.js';
import { findRepo, type Repo } from '../src/git.js';
import { readState, writeOps } from '../src/store.js';
import { formatProposals, proposalOps, type Proposal } from '../src/tidy.js';

let repo: Repo;
beforeEach(() => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hivemind-tidy-'));
  execFileSync('git', ['init', '-q', '--bare', 'o.git'], { cwd: dir });
  execFileSync('git', ['clone', '-q', 'o.git', 'me'], { cwd: dir, stdio: 'pipe' });
  repo = findRepo(path.join(dir, 'me'))!;
  writeOps(repo, [
    { kind: 'task', key: 'fix-gps', data: { title: 'Fix GPS loop', status: 'todo' } },
    { kind: 'contract', key: 'Button-props', data: { spec: '{ onClick }' } },
    { kind: 'decision', key: 'lab-busy', data: { text: 'Lab box busy until 14:00' } },
    { kind: 'question', key: 'colour', data: { text: 'Which colour?' } },
    { kind: 'question', key: 'colour-2', data: { text: 'Which colour for the route?' } },
  ]);
});

const open = () => [...reduce(readState(repo).ops).values()].filter((e) => e.status === 'open');

describe('tidy', () => {
  it('applies proposals as done / close / move, with the reason on each change, and logs the run in the notebook', () => {
    const proposals: Proposal[] = [
      { ref: 'task:fix-gps', action: 'mark_done', reason: 'AR settles on GPS', evidence: '9e099c3 Review fixes' },
      { ref: 'contract:Button-props', action: 'close_obsolete', reason: 'Component props, not an interface' },
      { ref: 'decision:lab-busy', action: 'to_note', reason: 'State, not a choice' },
      { ref: 'question:colour', action: 'close_duplicate', reason: 'Same question', superseded_by: 'question:colour-2' },
    ];
    writeOps(repo, proposalOps(repo, proposals));
    const byId = new Map(open().map((e) => [`${e.kind}:${e.key}`, e]));
    expect(byId.get('task:fix-gps')?.data).toMatchObject({ status: 'done', note: 'tidy: AR settles on GPS (9e099c3 Review fixes)' });
    expect(byId.has('contract:Button-props')).toBe(false);
    expect(byId.has('decision:lab-busy')).toBe(false);
    expect(String(byId.get('note:lab-busy')?.data.text)).toContain('Lab box busy until 14:00');
    expect(byId.has('question:colour')).toBe(false);
    expect(byId.has('question:colour-2')).toBe(true);
    expect(String(byId.get('note:hivemind-tidy')?.data.text)).toMatch(/1 tasks marked done, 2 entries closed as obsolete or duplicate, 0 merged into related entries, 1 decisions moved/);
    const closed = reduce(readState(repo).ops).get('question:colour');
    expect(closed?.data.superseded_by).toBe('question:colour-2');
  });

  it('merges related entries into one, keeping what still holds', () => {
    writeOps(repo, [
      { kind: 'decision', key: 'cups-a', data: { text: 'Cups are index-only negatives' } },
      { kind: 'decision', key: 'cups-b', data: { text: 'Cup rows are re-embedded after each training run' } },
    ]);
    writeOps(
      repo,
      proposalOps(repo, [
        { ref: 'decision:cups-b', action: 'merge', reason: 'Same feature', superseded_by: 'decision:cups-a', merged_text: 'Cups are index-only negatives, re-embedded after each training run.' },
      ]),
    );
    const byId = new Map(open().map((e) => [`${e.kind}:${e.key}`, e]));
    expect(byId.get('decision:cups-a')?.data.text).toBe('Cups are index-only negatives, re-embedded after each training run.');
    expect(byId.has('decision:cups-b')).toBe(false);
    expect(reduce(readState(repo).ops).get('decision:cups-b')?.data.superseded_by).toBe('decision:cups-a');
  });

  it('formats a readable dry run', () => {
    const out = formatProposals([{ ref: 'task:fix-gps', action: 'mark_done', reason: 'Fixed', evidence: 'abc123' }]);
    expect(out).toBe('- [done] task:fix-gps: Fixed [abc123]');
    expect(formatProposals([])).toContain('Nothing to tidy');
  });
});

describe('stale tasks and new contracts', () => {
  it('marks work in progress that has not moved for days', () => {
    const now = Date.now();
    const ops = [{ id: 'a', member: 'm', lamport: 1, ts: now - 6 * 86_400_000, type: 'upsert' as const, kind: 'task' as const, key: 'old', data: { title: 'Old work', status: 'doing' }, source: 'explicit' as const }];
    expect(formatSummary(ops, { compact: true, now })).toContain('Old work `old` (no update for 6d)');
  });

  it('a brand-new contract can never be flagged breaking', () => {
    const ex = (e: Partial<Extracted>) => ({ confidence: 0.9, evidence: 'q', ...e }) as Extracted;
    const [fresh] = toOps([ex({ kind: 'contract', key: 'GET /api/new', spec: '{ ok }', breaking: true })], repo, 's');
    expect(fresh.data?.breaking).toBe(false);
    writeOps(repo, [{ kind: 'contract', key: 'GET /api/new', data: { spec: '{ ok }' } }]);
    const [change] = toOps([ex({ kind: 'contract', key: 'GET /api/new', spec: '{ ok, id }', breaking: true })], repo, 's');
    expect(change.data?.breaking).toBe(true);
  });
});
