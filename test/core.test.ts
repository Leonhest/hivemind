import { describe, expect, it } from 'vitest';
import { formatDiff, formatSummary } from '../src/core/format.js';
import { reduce } from '../src/core/plan.js';
import type { Op, StoredOp } from '../src/core/types.js';

let n = 0;
const op = (p: Partial<Op> & Pick<Op, 'kind' | 'key'>): Op => ({
  id: `op${++n}`,
  member: 'alice',
  lamport: n,
  ts: n,
  type: 'upsert',
  data: {},
  source: 'explicit',
  ...p,
});
const stored = (ops: Op[]): StoredOp[] => ops.map((o, i) => ({ ...o, seq: i + 1 }));

describe('reduce', () => {
  it('merges upserts field by field and closes entries', () => {
    const entries = reduce([
      op({ kind: 'task', key: 't', data: { title: 'Auth', status: 'doing' } }),
      op({ kind: 'task', key: 't', data: { status: 'done' }, member: 'bob' }),
      op({ kind: 'decision', key: 'd', data: { text: 'x' } }),
      op({ kind: 'decision', key: 'd', type: 'close' }),
    ]);
    expect(entries.get('task:t')).toMatchObject({ data: { title: 'Auth', status: 'done' }, createdBy: 'alice', updatedBy: 'bob', revisions: 2 });
    expect(entries.get('decision:d')?.status).toBe('closed');
  });

  it('is independent of arrival order', () => {
    const a = op({ kind: 'contract', key: 'User', data: { spec: 'int' }, lamport: 1 });
    const b = op({ kind: 'contract', key: 'User', data: { spec: 'uuid' }, lamport: 2, member: 'bob' });
    expect(reduce([b, a]).get('contract:User')?.data.spec).toBe('uuid');
  });
});

describe('formatDiff', () => {
  const ops = stored([
    op({ kind: 'contract', key: 'User.id', data: { spec: 'int' } }),
    op({ kind: 'task', key: 'ui', data: { title: 'UI', status: 'doing' }, member: 'carol' }),
    op({ kind: 'contract', key: 'User.id', data: { spec: 'uuid', breaking: true }, member: 'bob' }),
  ]);

  it('reports only changes after lastSeq, breaking first, with the previous spec', () => {
    const diff = formatDiff(ops, 1, new Set());
    const lines = diff.split('\n');
    expect(lines[1]).toBe('⚠️ BREAKING bob updated contract: `User.id`: uuid (breaking) (was: int)');
    expect(lines[2]).toContain('carol added task');
    expect(diff).toContain('adapt it');
  });

  it('skips the session’s own ops and returns empty when nothing is new', () => {
    expect(formatDiff(ops, 1, new Set([ops[1].id, ops[2].id]))).toBe('');
    expect(formatDiff(ops, 3, new Set())).toBe('');
  });

  it('respects the size cap', () => {
    const many = stored(Array.from({ length: 50 }, (_, i) => op({ kind: 'decision', key: `d${i}`, data: { text: 'x'.repeat(100) } })));
    const diff = formatDiff(many, 0, new Set(), 600);
    expect(diff.length).toBeLessThan(700);
    expect(diff).toMatch(/more \(call the hivemind plan_get tool\)/);
  });
});

describe('formatSummary', () => {
  it('groups open entries by kind', () => {
    const s = formatSummary([
      op({ kind: 'goal', key: 'g', data: { text: 'Todo app' } }),
      op({ kind: 'task', key: 't', data: { title: 'Auth', status: 'doing', owner: 'alice' } }),
    ]);
    expect(s).toContain('## Goals\n- Todo app');
    expect(s).toContain('[doing] Auth @alice');
  });
});
