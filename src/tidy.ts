import fs from 'node:fs';
import path from 'node:path';
import { describeEntry } from './core/format.js';
import { entryId, reduce } from './core/plan.js';
import type { Entry, Kind } from './core/types.js';
import { askAnyModel, pickBackend } from './extract.js';
import { tryGit, type Repo } from './git.js';
import { log } from './log.js';
import { readState, writeOps, type NewOp } from './store.js';

/**
 * Keeps the plan from growing forever. A model pass over the open plan proposes closing what is
 * superseded, duplicated or no longer true, marking tasks done that commits show finished, and
 * moving state-like decisions to the notebook. It never rewrites an entry's content: it only
 * closes, completes or moves, with the reason recorded on each change.
 */

export type TidyAction = 'close_obsolete' | 'close_duplicate' | 'mark_done' | 'to_note' | 'merge';

export interface Proposal {
  ref: string;
  action: TidyAction;
  reason: string;
  superseded_by?: string | null;
  evidence?: string | null;
  merged_text?: string | null;
}

const SYSTEM = `You keep a coding team's shared plan small and current. Agents read the plan at the start of every session, so every entry that nobody will act on costs everyone attention. You get the open plan entries (kind:key, author, age, text) and the repo's recent commits. Propose changes:
- mark_done: an open task (todo/doing/blocked) that the commits or later entries show is finished. evidence: the commit hash and subject, or the entry that shows it.
- close_duplicate: an entry that says the same thing as another open entry. superseded_by: the one to keep (usually the newer or more complete one).
- close_obsolete: an entry that a later entry or commit replaced or made untrue (an old image/deployment after a newer rollout, a plan that was abandoned, a contract for something that was removed). superseded_by: the replacing entry if there is one.
- close_obsolete also for contracts that are not real cross-team interfaces: a component's props, an internal function signature, i18n strings, CSS details, test setup. Real contracts are APIs, schemas, env vars, CLI flags, message formats and types shared between separately built parts.
- merge: several entries of the same kind that are about the same thing (e.g. five decisions about one feature). Propose one merge per entry to remove, with superseded_by = the entry to keep, and merged_text = the kept entry's new text combining what still holds from all of them (concise, nothing invented). Use the same merged_text on every proposal for that kept entry.
- close_obsolete also for questions that are really an agent waiting for its own user's go-ahead, or that later work answered.
- to_note: a decision that is really a fact about state or a finding (what is running or deployed where, measurements, results, what was built) rather than a choice the team must keep following. It moves to the team notebook.
Be conservative: when unsure, leave the entry alone. Never propose anything for an entry younger than a day unless it is a duplicate or clearly finished. reason: one short sentence a teammate would accept.`;

const SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['proposals'],
  properties: {
    proposals: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['ref', 'action', 'reason', 'superseded_by', 'evidence', 'merged_text'],
        properties: {
          ref: { type: 'string' },
          action: { type: 'string', enum: ['close_obsolete', 'close_duplicate', 'mark_done', 'to_note', 'merge'] },
          merged_text: { type: ['string', 'null'] },
          reason: { type: 'string' },
          superseded_by: { type: ['string', 'null'] },
          evidence: { type: ['string', 'null'] },
        },
      },
    },
  },
};

const DAY = 24 * 60 * 60_000;
const age = (e: Entry, now: number) => `${Math.max(0, Math.round((now - e.updatedAt) / DAY))}d`;

/** Open entries the tidy looks at: the plan, without notes and without tasks that are already done. */
function candidates(repo: Repo): Entry[] {
  return [...reduce(readState(repo).ops).values()].filter((e) => e.status === 'open' && e.kind !== 'note' && !(e.kind === 'task' && e.data.status === 'done'));
}

const BATCH = 60;
const STALE_QUESTION_MS = 7 * DAY;

/** Questions nobody has touched for a week: closed without asking a model. */
function staleQuestions(entries: Entry[], now: number): Proposal[] {
  return entries
    .filter((e) => e.kind === 'question' && now - e.updatedAt > STALE_QUESTION_MS)
    .map((e) => ({ ref: entryId(e), action: 'close_obsolete' as const, reason: `unanswered and untouched for ${Math.round((now - e.updatedAt) / DAY)} days` }));
}
const PARALLEL = 3;

/**
 * Long lists make a model stop early, so the plan is reviewed in batches of one kind at a time
 * (sorted by key, so related entries sit together). Each batch also sees a one-line index of the
 * whole plan, so it can point at the entry that replaces one.
 */
export async function proposeTidy(repo: Repo, now = Date.now()): Promise<Proposal[]> {
  const entries = candidates(repo);
  if (entries.length < 5) return [];
  if (!pickBackend('claude')) throw new Error('hivemind tidy needs the claude or codex CLI');
  const commits = tryGit(repo.root, ['log', '--all', '--no-merges', '--since=14 days ago', '-n200', '--date=format:%m-%d', '--format=%h %ad %s'])?.slice(0, 12_000) ?? '';
  const index = entries.map((e) => `${e.kind}:${e.key}: ${describeEntry(e).slice(0, 90)}`).join('\n');
  const batches: Entry[][] = [];
  for (const kind of ['task', 'question', 'decision', 'contract', 'goal'] as Kind[]) {
    const ofKind = entries.filter((e) => e.kind === kind && !(kind === 'question' && now - e.updatedAt > STALE_QUESTION_MS)).sort((a, b) => a.key.localeCompare(b.key));
    for (let i = 0; i < ofKind.length; i += BATCH) batches.push(ofKind.slice(i, i + BATCH));
  }
  const review = async (batch: Entry[]): Promise<Proposal[]> => {
    const listing = batch
      .map((e) => `- ${e.kind}:${e.key} (by ${e.createdBy}, ${age(e, now)} old${e.kind === 'task' ? `, status ${e.data.status ?? 'todo'}` : ''}): ${describeEntry(e).slice(0, 400)}`)
      .join('\n');
    const prompt = `Review EVERY entry in this batch (${batch.length} ${batch[0].kind}s) and propose changes only for these:\n${listing}\n\nThe whole plan, for reference (one line each):\n${index}\n\nRecent commits (newest first):\n${commits || '(none)'}`;
    const { result } = await askAnyModel('claude', SYSTEM, SCHEMA, prompt, { model: process.env.HIVEMIND_TIDY_MODEL ?? 'sonnet', thinking: false });
    const inBatch = new Set(batch.map((e) => entryId(e)));
    return (Array.isArray(result.proposals) ? result.proposals : []).filter((p: Proposal) => inBatch.has(p.ref));
  };
  const results: Proposal[] = [];
  for (let i = 0; i < batches.length; i += PARALLEL) {
    for (const r of await Promise.all(batches.slice(i, i + PARALLEL).map(review))) results.push(...r);
  }
  const open = new Map(entries.map((e) => [entryId(e), e]));
  const seen = new Set<string>();
  // Entries another proposal keeps (merge or duplicate target) must stay open.
  const kept = new Set(results.filter((p) => p.superseded_by && (p.action === 'merge' || p.action === 'close_duplicate')).map((p) => p.superseded_by!));
  // Only act on entries that exist, once, with an action that fits their kind.
  return [...staleQuestions(entries, now), ...results].filter((p) => {
    if (kept.has(p.ref) && p.action !== 'mark_done') return false;
    const e = open.get(p.ref);
    if (!e || seen.has(p.ref)) return false;
    seen.add(p.ref);
    if (p.action === 'mark_done') return e.kind === 'task';
    if (p.action === 'to_note') return e.kind === 'decision';
    // A merge needs a kept entry of the same kind that stays open.
    if (p.action === 'merge') return !!p.superseded_by && p.superseded_by !== p.ref && open.get(p.superseded_by)?.kind === e.kind && !!p.merged_text;
    return true;
  });
}

export function proposalOps(repo: Repo, proposals: Proposal[], now = Date.now()): NewOp[] {
  const entries = reduce(readState(repo).ops);
  const ops: NewOp[] = [];
  const mergedTargets = new Set<string>();
  const base = { source: 'inferred' as const, agent: 'tidy' };
  for (const p of proposals) {
    const [kind, ...rest] = p.ref.split(':');
    const key = rest.join(':');
    const e = entries.get(p.ref);
    if (!e) continue;
    const why = `tidy: ${p.reason}${p.evidence ? ` (${p.evidence})` : ''}`.slice(0, 300);
    switch (p.action) {
      case 'mark_done':
        ops.push({ ...base, kind: 'task', key, data: { status: 'done', note: why }, evidence: why });
        break;
      case 'to_note': {
        const when = new Date(e.updatedAt).toISOString().slice(0, 16).replace('T', ' ');
        ops.push({ ...base, kind: 'note', key, data: { text: `(${when}Z) ${String(e.data.text ?? '')}` }, evidence: why });
        ops.push({ ...base, type: 'close', kind: kind as Kind, key, data: { superseded_by: `note:${key}` }, evidence: why });
        break;
      }
      case 'merge': {
        const target = p.superseded_by!;
        const [tkind, ...trest] = target.split(':');
        const field = tkind === 'contract' ? 'spec' : tkind === 'task' ? 'note' : 'text';
        if (!mergedTargets.has(target)) {
          mergedTargets.add(target);
          ops.push({ ...base, kind: tkind as Kind, key: trest.join(':'), data: { [field]: p.merged_text }, evidence: why });
        }
        ops.push({ ...base, type: 'close', kind: kind as Kind, key, data: { superseded_by: target }, evidence: why });
        break;
      }
      default:
        ops.push({ ...base, type: 'close', kind: kind as Kind, key, data: p.superseded_by ? { superseded_by: p.superseded_by } : {}, evidence: why });
    }
  }
  if (ops.length) {
    const count = (a: TidyAction | TidyAction[]) => proposals.filter((p) => [a].flat().includes(p.action)).length;
    ops.push({
      ...base,
      kind: 'note',
      key: 'hivemind-tidy',
      data: {
        text: `Plan tidied by ${repo.memberId} on ${new Date(now).toISOString().slice(0, 10)}: ${count('mark_done')} tasks marked done, ${count(['close_obsolete', 'close_duplicate'])} entries closed as obsolete or duplicate, ${count('merge')} merged into related entries, ${count('to_note')} decisions moved to the notebook. Each change records its reason.`,
      },
    });
  }
  return ops;
}

export function formatProposals(proposals: Proposal[]): string {
  if (!proposals.length) return 'Nothing to tidy: the plan looks current.';
  const label: Record<TidyAction, string> = { mark_done: 'done', close_duplicate: 'duplicate', close_obsolete: 'obsolete', to_note: '→ notebook', merge: 'merged' };
  return proposals
    .map((p) => `- [${label[p.action]}] ${p.ref}${p.superseded_by ? ` (kept: ${p.superseded_by})` : ''}: ${p.reason}${p.evidence ? ` [${p.evidence}]` : ''}`)
    .join('\n');
}

// --- automatic tidy: at most once a day per repo, only once the plan is big enough to need it ---

const AUTO_MIN_ENTRIES = 40;
const lockFile = (repo: Repo) => path.join(repo.stateDir, 'tidy.lock');

/** When anyone on the team last tidied this repo's plan (the marker note syncs to everyone). */
function lastTidy(repo: Repo): number {
  return reduce(readState(repo).ops).get('note:hivemind-tidy')?.updatedAt ?? 0;
}

export async function maybeAutoTidy(repo: Repo): Promise<void> {
  if (process.env.HIVEMIND_NO_TIDY) return;
  if (Date.now() - lastTidy(repo) < DAY) return;
  if (candidates(repo).length < AUTO_MIN_ENTRIES) return;
  try {
    fs.mkdirSync(lockFile(repo));
  } catch {
    if (Date.now() - fs.statSync(lockFile(repo)).mtimeMs < 10 * 60_000) return;
  }
  try {
    // Big enough to keep up with a busy team's daily inflow.
    const proposals = (await proposeTidy(repo)).slice(0, 150);
    const ops = proposalOps(repo, proposals);
    if (ops.length) writeOps(repo, ops);
    else writeOps(repo, [{ kind: 'note', key: 'hivemind-tidy', data: { text: `Plan checked by ${repo.memberId} on ${new Date().toISOString().slice(0, 10)}: nothing to tidy.` }, source: 'inferred', agent: 'tidy' }]);
    log(repo, `auto-tidy: ${proposals.length} changes`);
  } finally {
    fs.rmSync(lockFile(repo), { recursive: true, force: true });
  }
}
