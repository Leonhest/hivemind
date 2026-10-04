import { describeEntry } from './core/format.js';
import { reduce } from './core/plan.js';
import { askModel, pickBackend } from './extract.js';
import type { Repo } from './git.js';
import { readState } from './store.js';

export interface Conflict {
  entries: string[];
  summary: string;
  suggestion: string;
}

const SYSTEM = `You review the shared plan of a team of coding agents and find places where it contradicts itself: two goals pointing in different directions, decisions that can't both hold, contracts describing the same thing differently, tasks that only make sense under an abandoned approach, or open tasks that duplicate finished ones.
Check every area: product direction, the demo, where data is stored, where and how the app is deployed, which services/libraries are used, and who the user/persona is. Compare decisions against contracts that describe what was actually built (e.g. a decision to deploy on one platform vs a contract describing a deployment elsewhere). Contradictions by the same author count too: people change their minds without removing the old entry.
Only report real contradictions or clearly obsolete entries, not entries that are merely related or complementary. Cite entries as "kind:key". summary: one or two plain sentences on what conflicts. suggestion: the concrete resolution (which to keep, which to remove, or what question the team must answer). Return an empty list if the plan is consistent.`;

const SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['conflicts'],
  properties: {
    conflicts: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['entries', 'summary', 'suggestion'],
        properties: { entries: { type: 'array', items: { type: 'string' } }, summary: { type: 'string' }, suggestion: { type: 'string' } },
      },
    },
  },
};

export async function reviewPlan(repo: Repo): Promise<Conflict[]> {
  const entries = [...reduce(readState(repo).ops).values()].filter((e) => e.status === 'open');
  if (entries.length < 2) return [];
  const backend = pickBackend('claude');
  if (!backend) throw new Error('hivemind review needs the claude or codex CLI');
  const plan = entries
    .sort((a, b) => a.updatedAt - b.updatedAt)
    .map((e) => `- ${e.kind}:${e.key} (by ${e.createdBy}, ${new Date(e.updatedAt).toISOString().slice(11, 16)}): ${describeEntry(e).slice(0, 400)}`)
    .join('\n');
  // Sonnet without thinking: ~13s and coherent groupings; Haiku over-reports and, with thinking, takes ~100s.
  const out = await askModel(backend, SYSTEM, SCHEMA, `Plan entries, oldest first:\n${plan}`, { model: process.env.HIVEMIND_REVIEW_MODEL ?? 'sonnet', thinking: false });
  return Array.isArray(out.conflicts) ? out.conflicts : [];
}

export function formatConflicts(conflicts: Conflict[]): string {
  if (!conflicts.length) return 'No contradictions found in the plan.';
  return conflicts
    .map((c, i) => `${i + 1}. ${c.entries.join(' vs ')}\n   ${c.summary}\n   → ${c.suggestion}`)
    .join('\n\n');
}
