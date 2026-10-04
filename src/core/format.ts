import { entryId, reduce } from './plan.js';
import type { Entry, Kind, Op, StoredOp } from './types.js';

const str = (v: unknown) => (v === undefined || v === null ? '' : typeof v === 'string' ? v : JSON.stringify(v));

function clip(text: string, max: number): string {
  return text.length <= max ? text : text.slice(0, max - 1) + '…';
}

export function describeEntry(e: Entry): string {
  const d = e.data;
  switch (e.kind) {
    case 'goal':
      return str(d.text);
    case 'task': {
      const owner = d.owner ? ` @${str(d.owner)}` : '';
      const note = d.note ? ` — ${str(d.note)}` : '';
      return `[${str(d.status) || 'todo'}] ${str(d.title) || e.key}${owner}${note}`;
    }
    case 'contract':
      return `\`${e.key}\`: ${str(d.spec)}${d.breaking ? ' (breaking)' : ''}`;
    case 'decision':
      return `${str(d.text)}${d.rationale ? ` (why: ${str(d.rationale)})` : ''}`;
    case 'question':
      return `${str(d.text)}${d.answer ? ` → ${str(d.answer)}` : ''}`;
  }
}

const SECTIONS: [Kind, string][] = [
  ['goal', 'Goals'],
  ['contract', 'Contracts (shared APIs, schemas, types)'],
  ['decision', 'Decisions'],
  ['task', 'Tasks'],
  ['question', 'Open questions'],
];

/** Full plan, used at session start and by plan_get. */
export function formatSummary(ops: Op[], maxChars = Infinity): string {
  const entries = [...reduce(ops).values()].filter((e) => e.status === 'open');
  if (entries.length === 0) return 'The shared plan is empty.';
  const lines: string[] = [];
  for (const [kind, title] of SECTIONS) {
    const items = entries.filter((e) => e.kind === kind).sort((a, b) => b.updatedAt - a.updatedAt);
    if (!items.length) continue;
    lines.push(`## ${title}`);
    for (const e of items) lines.push(`- ${clip(describeEntry(e), 300)}`);
  }
  let out = '';
  for (let i = 0; i < lines.length; i++) {
    if (out.length + lines[i].length + 1 > maxChars) {
      out += `… ${lines.length - i} more lines (call the hivemind plan_get tool for everything)\n`;
      break;
    }
    out += lines[i] + '\n';
  }
  return out.trimEnd();
}

function describeChange(op: Op, before: Entry | undefined): string {
  const who = op.member;
  if (op.type === 'close') return `${who} closed ${op.kind} \`${op.key}\``;
  const after = { ...(before ?? { kind: op.kind, key: op.key, status: 'open', createdBy: who, updatedBy: who, updatedAt: op.ts, revisions: 0 }), data: { ...before?.data, ...op.data } } as Entry;
  const verb = before ? 'updated' : 'added';
  let line = `${who} ${verb} ${op.kind}: ${clip(describeEntry(after), 240)}`;
  if (op.kind === 'contract' && before && before.data.spec !== undefined && op.data.spec !== undefined && before.data.spec !== op.data.spec) {
    line += ` (was: ${clip(str(before.data.spec), 120)})`;
  }
  if (op.source === 'inferred') line += ' [inferred]';
  return line;
}

const isBreaking = (op: Op) => op.kind === 'contract' && op.data.breaking === true;

/**
 * Changes made by others since `lastSeq`, most important first.
 * Returns '' when there is nothing to report.
 */
export function formatDiff(ops: StoredOp[], lastSeq: number, ownOpIds: Set<string>, maxChars = 1200): string {
  const fresh = ops.filter((o) => o.seq > lastSeq && !ownOpIds.has(o.id));
  if (!fresh.length) return '';
  const known = reduce(ops.filter((o) => o.seq <= lastSeq));
  const ordered = [...fresh].sort((a, b) => Number(isBreaking(b)) - Number(isBreaking(a)) || a.seq - b.seq);
  const lines: string[] = [];
  for (const op of ordered) {
    lines.push(`${isBreaking(op) ? '⚠️ BREAKING ' : '- '}${describeChange(op, known.get(entryId(op)))}`);
  }
  let out = '[hivemind] Teammates updated the shared plan since you last checked:\n';
  for (let i = 0; i < lines.length; i++) {
    if (out.length + lines[i].length + 1 > maxChars) {
      out += `… ${lines.length - i} more (call the hivemind plan_get tool)\n`;
      break;
    }
    out += lines[i] + '\n';
  }
  if (fresh.some(isBreaking)) out += 'Check whether your current work depends on the breaking changes above and adapt it.\n';
  return out.trimEnd();
}
