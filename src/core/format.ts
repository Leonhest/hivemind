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
    case 'goal': {
      const alt = Array.isArray(d.alternative_to) && d.alternative_to.length ? ` (competing proposal vs: ${d.alternative_to.join(', ')})` : '';
      return `${str(d.text)} \`${e.key}\`${alt}`;
    }
    case 'task': {
      const owner = d.owner ? ` @${str(d.owner)}` : d.status === 'todo' || !d.status ? ' (unassigned)' : '';
      const detail = d.note ?? d.description;
      const note = detail ? ` — ${str(detail)}` : '';
      const deps = Array.isArray(d.depends_on) && d.depends_on.length ? ` (after: ${d.depends_on.join(', ')})` : '';
      return `[${str(d.status) || 'todo'}] ${str(d.title) || e.key} \`${e.key}\`${owner}${deps}${note}`;
    }
    case 'contract':
      return `\`${e.key}\`: ${str(d.spec)}${d.breaking ? ' (breaking)' : ''}`;
    case 'decision':
      return `${str(d.text)}${d.rationale ? ` (why: ${str(d.rationale)})` : ''}`;
    case 'question':
      return `${str(d.text)}${d.answer ? ` → ${str(d.answer)}` : ''}`;
    case 'note':
      return `${str(d.text)} \`${e.key}\``;
  }
}

const ago = (ts: number, now: number) => {
  const m = Math.max(0, Math.round((now - ts) / 60_000));
  return m < 60 ? `${m}m ago` : m < 48 * 60 ? `${Math.round(m / 60)}h ago` : `${Math.round(m / 1440)}d ago`;
};

/** Open goals that were added as competing proposals and whose rivals are still open. */
export function competingGoals(entries: Entry[]): string[][] {
  const open = new Set(entries.filter((e) => e.kind === 'goal' && e.status === 'open').map((e) => e.key));
  const groups: string[][] = [];
  for (const e of entries) {
    if (e.kind !== 'goal' || e.status !== 'open' || !Array.isArray(e.data.alternative_to)) continue;
    const rivals = (e.data.alternative_to as string[]).filter((k) => open.has(k));
    if (rivals.length) groups.push([...rivals, e.key]);
  }
  return groups;
}

export const competingWarning = (groups: string[][]) =>
  groups.length
    ? `⚠️ Competing goals: the team hasn't picked one yet (${groups.map((g) => g.join(' vs ')).join('; ')}). Ask the user which applies before building on either, then record it with goal_set replaces=[…].`
    : '';

const DAY = 24 * 60 * 60_000;
const TASK_ORDER: Record<string, number> = { doing: 0, blocked: 1, todo: 2, done: 3 };
const isOpenGoalAlt = (e: Entry, open: Set<string>): Entry =>
  Array.isArray(e.data.alternative_to) ? { ...e, data: { ...e.data, alternative_to: (e.data.alternative_to as string[]).filter((k) => open.has(k)) } } : e;

export interface SummaryOptions {
  maxChars?: number;
  /** Session-start view: active things first, capped per section so nothing important is cut. */
  compact?: boolean;
  /** Only this kind (plan_get kind=…); shows everything of that kind, including finished tasks and old notes. */
  kind?: Kind;
  now?: number;
}

/**
 * The plan, most actionable first: goals, tasks in progress, contracts, decisions, open questions,
 * then the last day of notebook entries. Finished tasks and notes older than a day are hidden
 * (they stay in the history and in plan_get kind=task / notebook_get).
 */
export function formatSummary(ops: Op[], opts: SummaryOptions = {}): string {
  const { maxChars = Infinity, compact = false, kind, now = Date.now() } = opts;
  const all = [...reduce(ops).values()].filter((e) => e.status === 'open');
  const openGoals = new Set(all.filter((e) => e.kind === 'goal').map((e) => e.key));
  const entries = all.map((e) => isOpenGoalAlt(e, openGoals)).filter((e) => !kind || e.kind === kind);
  if (entries.length === 0) return kind ? `No open ${kind}s in the plan.` : 'The shared plan is empty.';

  const recent = (e: Entry) => now - e.updatedAt < DAY;
  const byRecency = (a: Entry, b: Entry) => b.updatedAt - a.updatedAt;
  const of = (k: Kind) => entries.filter((e) => e.kind === k);
  const tasks = of('task')
    .filter((e) => kind === 'task' || e.data.status !== 'done' || recent(e))
    .sort((a, b) => (TASK_ORDER[String(a.data.status ?? 'todo')] ?? 2) - (TASK_ORDER[String(b.data.status ?? 'todo')] ?? 2) || byRecency(a, b));
  const notes = of('note').filter((e) => kind === 'note' || recent(e)).sort(byRecency);

  // [title, items, cap, guaranteed lines in the compact view, render]
  const sections: [string, Entry[], number, number, (e: Entry) => string][] = [
    ['Goals', of('goal').sort(byRecency), 5, 5, describeEntry],
    ['Tasks', tasks, 12, 6, describeEntry],
    ['Contracts (shared APIs, schemas, types)', of('contract').sort(byRecency), 8, 3, describeEntry],
    ['Decisions', of('decision').sort(byRecency), 10, 4, describeEntry],
    ['Open questions', of('question').sort(byRecency), 6, 3, describeEntry],
    [kind === 'note' ? 'Notebook' : 'Notebook (last 24h)', notes, 6, 3, (e) => `${ago(e.updatedAt, now)}: ${describeEntry(e)}`],
  ];
  const line = (render: (e: Entry) => string, e: Entry) => `- ${clip(render(e), compact ? 150 : 400)}`;

  const header: string[] = [];
  const warning = competingWarning(competingGoals(entries));
  if (warning) header.push(warning);
  const hiddenDone = kind ? 0 : of('task').length - tasks.length;
  const olderNotes = kind ? 0 : of('note').length - notes.length;
  const footer =
    hiddenDone || olderNotes
      ? [`(${[hiddenDone && `${hiddenDone} finished tasks`, olderNotes && `${olderNotes} older notes`].filter(Boolean).join(' and ')} hidden: plan_get kind=task / notebook_get)`]
      : [];

  // How many items each section shows. Full view: everything. Compact view: every section first
  // gets a few guaranteed lines, then leftover space goes to sections in priority order up to their cap.
  const shown = sections.map(([, items, cap, floor]) => (compact ? Math.min(items.length, floor, cap) : items.length));
  if (compact && Number.isFinite(maxChars)) {
    const size = () =>
      [...header, ...footer].reduce((n, l) => n + l.length + 1, 0) +
      sections.reduce((n, [title, items, , , render], i) => {
        if (!items.length) return n;
        const body = items.slice(0, shown[i]).reduce((m, e) => m + line(render, e).length + 1, 0);
        return n + title.length + 4 + body + (shown[i] < items.length ? 40 : 0);
      }, 0);
    for (let i = 0; i < sections.length; i++) {
      const [, items, cap, , render] = sections[i];
      while (shown[i] < Math.min(items.length, cap) && size() + line(render, items[shown[i]]).length + 1 <= maxChars) shown[i]++;
    }
  } else if (compact) {
    sections.forEach(([, items, cap], i) => (shown[i] = Math.min(items.length, cap)));
  }

  const lines = [...header];
  sections.forEach(([title, items, , , render], i) => {
    if (!items.length) return;
    lines.push(`## ${title}`);
    for (const e of items.slice(0, shown[i])) lines.push(line(render, e));
    if (shown[i] < items.length) lines.push(`- … ${items.length - shown[i]} more (${items[0].kind === 'note' ? 'notebook_get' : `plan_get kind=${items[0].kind}`})`);
  });
  lines.push(...footer);
  return lines.join('\n');
}

export function describeChange(op: Op, before: Entry | undefined): string {
  const who = op.member;
  if (op.type === 'close') {
    const by = typeof op.data.superseded_by === 'string' ? ` (replaced by ${op.data.superseded_by})` : '';
    return `${who} removed ${op.kind} \`${op.key}\`${by}`;
  }
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
