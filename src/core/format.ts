import { entryId, reduce } from './plan.js';
import type { Entry, Kind, Op, StoredOp } from './types.js';

/** Single-line rendering: entries are shown as bullets. */
const str = (v: unknown) => (v === undefined || v === null ? '' : typeof v === 'string' ? v : JSON.stringify(v)).replace(/\s*\n\s*/g, ' ');

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

export interface DiffOptions {
  /** Ops this agent wrote itself; never echoed back to it. */
  isOwn?: (op: StoredOp) => boolean;
  /** Repo-relative paths this agent has touched, for relevance. */
  touched?: string[];
  maxChars?: number;
}

export function overlaps(areas: unknown, touched: string[]): boolean {
  if (!Array.isArray(areas) || !touched.length) return false;
  return areas.some((a) => typeof a === 'string' && a.length > 1 && touched.some((t) => t.includes(a) || a.includes(t)));
}

const MAX_ROUTINE_TASK_LINES = 4;

/**
 * Changes made by others since `lastSeq`, most important first:
 * breaking contracts, then anything overlapping this agent's files, then the rest.
 * Returns '' when there is nothing to report.
 */
export function formatDiff(ops: StoredOp[], lastSeq: number, opts: DiffOptions = {}): string {
  const { isOwn = () => false, touched = [], maxChars = 1200 } = opts;
  const fresh = ops.filter((o) => o.seq > lastSeq && !isOwn(o));
  if (!fresh.length) return '';
  const known = reduce(ops.filter((o) => o.seq <= lastSeq));
  const after = reduce(ops);
  const relevant = (op: Op) => overlaps(after.get(entryId(op))?.data.areas ?? op.data.areas, touched);
  const rank = (op: Op) => (isBreaking(op) ? 0 : relevant(op) ? 1 : op.kind === 'task' ? 3 : 2);
  const ordered = [...fresh].sort((a, b) => rank(a) - rank(b) || a.seq - b.seq);

  const lines: string[] = [];
  const routineTasks = ordered.filter((o) => rank(o) === 3);
  for (const op of ordered) {
    const r = rank(op);
    if (r === 3 && routineTasks.length > MAX_ROUTINE_TASK_LINES) continue;
    const prefix = r === 0 ? '⚠️ BREAKING ' : r === 1 ? '🎯 (overlaps files you touched) ' : '- ';
    lines.push(prefix + describeChange(op, known.get(entryId(op))));
  }
  if (routineTasks.length > MAX_ROUTINE_TASK_LINES) {
    const who = [...new Set(routineTasks.map((o) => o.member))].join(', ');
    lines.push(`- ${routineTasks.length} task updates by ${who} (call the hivemind plan_get tool for details)`);
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
  const conflicts = fresh.filter((o) => o.kind === 'task' && o.data.status === 'doing' && relevant(o));
  if (conflicts.length) out += `Possible conflict: ${[...new Set(conflicts.map((o) => o.member))].join(', ')} started work overlapping files you touched. Coordinate before continuing.\n`;
  return out.trimEnd();
}
