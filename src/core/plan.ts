import type { Entry, Op } from './types.js';

export const entryId = (o: { kind: string; key: string }) => `${o.kind}:${o.key}`;

/** Total order every clone agrees on, regardless of arrival order. */
export function compareOps(a: Op, b: Op): number {
  return a.lamport - b.lamport || a.member.localeCompare(b.member) || a.id.localeCompare(b.id);
}

export function applyOp(entries: Map<string, Entry>, op: Op): void {
  const id = entryId(op);
  const prev = entries.get(id);
  if (op.type === 'close') {
    // Close ops may carry why (e.g. superseded_by), kept on the closed entry.
    if (prev) entries.set(id, { ...prev, data: { ...prev.data, ...op.data }, status: 'closed', updatedBy: op.member, updatedAt: op.ts, revisions: prev.revisions + 1 });
    return;
  }
  entries.set(id, {
    kind: op.kind,
    key: op.key,
    data: { ...prev?.data, ...op.data },
    status: 'open',
    createdBy: prev?.createdBy ?? op.member,
    updatedBy: op.member,
    updatedAt: op.ts,
    revisions: (prev?.revisions ?? 0) + 1,
  });
}

export function reduce(ops: Op[]): Map<string, Entry> {
  const entries = new Map<string, Entry>();
  for (const op of [...ops].sort(compareOps)) applyOp(entries, op);
  return entries;
}
