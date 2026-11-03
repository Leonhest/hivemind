import { AsyncLocalStorage } from 'node:async_hooks';
import fs from 'node:fs';
import path from 'node:path';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import { describeEntry, formatSummary, isExpiredNote } from './core/format.js';
import { entryId, reduce } from './core/plan.js';
import { KINDS, type Kind } from './core/types.js';
import { lastAgentCwd } from './agentcwd.js';
import { ensureDaemon } from './daemon.js';
import { findRepo, samePerson, type Repo } from './git.js';
import { readState, touchActivity, writeOps, type NewOp } from './store.js';
import { PUBLIC_NOTICE, readVisibility } from './visibility.js';

const VERSION = '0.1.13';

type Reply = { content: { type: 'text'; text: string }[]; isError?: boolean };
const text = (t: string, isError = false): Reply => ({ content: [{ type: 'text', text: t }], ...(isError ? { isError } : {}) });

const NOT_A_REPO =
  'hivemind can\'t tell which repo you mean: neither your current directory nor the session\'s start directory is a git repository with an "origin" remote (or hivemind is turned off there with hivemind disable). Call the tool again with repo set to the path of the repo you are working in.';
const PROPAGATES = "Teammates' agents will see it at their next tool call.";

/** The nearest existing directory at or above `p` (agents sometimes name files that don't exist yet). */
function existingDir(p: string): string {
  let dir = path.resolve(p);
  while (!fs.existsSync(dir) && path.dirname(dir) !== dir) dir = path.dirname(dir);
  return fs.existsSync(dir) && !fs.statSync(dir).isDirectory() ? path.dirname(dir) : dir;
}

export async function runMcp(): Promise<void> {
  const server = new McpServer({ name: 'hivemind', version: VERSION });

  // Resolved per call: the server may be started before the repo has a remote.
  // Which repo a call is about, in order: the tool's optional `repo` argument; where the agent's
  // hooks last saw it (it may have moved into a repo after the session started); Cursor's
  // HIVEMIND_CWD; the directory this server was started in.
  const callRepo = new AsyncLocalStorage<string | undefined>();
  const repo = (): Repo | null => {
    const explicit = callRepo.getStore();
    // An explicit path must be honoured or fail: falling back could write to the wrong team's plan.
    if (explicit) return findRepo(existingDir(explicit));
    for (const c of [lastAgentCwd(), process.env.HIVEMIND_CWD, process.cwd()]) {
      const r = c ? findRepo(existingDir(c)) : null;
      if (r) return r;
    }
    return null;
  };
  const REPO_ARG = z.string().optional().describe("Path inside the repo you're working in. Only needed if hivemind says it can't tell which repo you mean.");
  // Every tool takes the optional repo argument.
  const register = <S extends z.ZodRawShape>(
    name: string,
    def: { description: string; inputSchema: S },
    handler: (args: z.infer<z.ZodObject<S>>) => Promise<Reply>,
  ) =>
    server.registerTool(name, { ...def, inputSchema: { ...def.inputSchema, repo: REPO_ARG } } as any, ((args: any) =>
      callRepo.run(args?.repo, () => handler(args))) as any);

  const publishMany = (ops: NewOp[], message: string): Reply => {
    const r = repo();
    if (!r) return text(NOT_A_REPO, true);
    touchActivity(r);
    ensureDaemon(r);
    const written = writeOps(r, ops);
    return text(`${message} ${PROPAGATES} ${written.map((w) => `[op:${w.id}]`).join(' ')}`);
  };
  const publish = (op: NewOp, message: string): Reply => publishMany([op], message);

  const entry = (r: Repo, kind: Kind, key: string) => reduce(readState(r).ops).get(entryId({ kind, key }));

  register(
    'plan_get',
    {
      description:
        "Read the team's shared plan: goals, tasks, contracts (APIs/schemas/types), decisions, open questions, and the last day of notebook entries. Pass kind to see everything of one kind, including finished tasks.",
      inputSchema: { kind: z.enum(KINDS as [Kind, ...Kind[]]).optional().describe('Only return this kind of entry') },
    },
    async ({ kind }) => {
      const r = repo();
      if (!r) return text(NOT_A_REPO, true);
      touchActivity(r);
      const notice = readVisibility(r)?.public ? `${PUBLIC_NOTICE}\n` : '';
      return text(`${notice}You are ${r.memberId}.\n${formatSummary(readState(r).ops, { kind })}`);
    },
  );

  register(
    'task_claim',
    {
      description:
        'Claim a task so teammates know you are working on it. Call before starting a piece of work. To pick up a task already in the plan, pass just its key.',
      inputSchema: {
        key: z.string().describe('Short stable id, e.g. "auth-api"'),
        title: z.string().optional().describe('Required when the task is not in the plan yet'),
        areas: z.array(z.string()).optional().describe('Files, directories or topics this task touches'),
      },
    },
    async ({ key, title, areas }) => {
      const r = repo();
      const prev = r ? entry(r, 'task', key) : undefined;
      const open = prev?.status === 'open';
      if (!title && !open) return text(`There is no task "${key}" in the plan yet; pass a title to create and claim it.`, true);
      const owner = open ? prev.data.owner : undefined;
      const warning =
        r && owner && !samePerson(owner, r.memberId) && prev?.data.status === 'doing' ? ` Warning: ${owner} had already claimed this task; coordinate with them.` : '';
      return publish(
        { kind: 'task', key, data: { ...(title ? { title } : {}), status: 'doing', owner: r?.memberId, ...(areas ? { areas } : {}) } },
        `Claimed task "${key}".${warning}`,
      );
    },
  );

  register(
    'task_add',
    {
      description:
        "Add tasks to the shared plan without starting them, e.g. when breaking work down for the team. Tasks are unassigned unless you set owner; teammates' agents pick them up with task_claim.",
      inputSchema: {
        tasks: z
          .array(
            z.object({
              key: z.string().describe('Short stable id, e.g. "signup-form"'),
              title: z.string(),
              description: z.string().optional().describe('What done looks like, in a sentence or two'),
              areas: z.array(z.string()).optional().describe('Files, directories or topics this task touches'),
              depends_on: z.array(z.string()).optional().describe('Keys of tasks that must be done first'),
              owner: z.string().optional().describe('Member id to assign it to; omit to leave it open for anyone'),
            }),
          )
          .min(1),
      },
    },
    async ({ tasks }) => {
      const r = repo();
      const existing = r ? tasks.filter((t) => entry(r, 'task', t.key)?.status === 'open').map((t) => t.key) : [];
      const note = existing.length ? ` Updated existing: ${existing.join(', ')}.` : '';
      return publishMany(
        tasks.map((t) => ({
          kind: 'task' as const,
          key: t.key,
          data: {
            title: t.title,
            status: 'todo',
            ...(t.description ? { description: t.description } : {}),
            ...(t.areas ? { areas: t.areas } : {}),
            ...(t.depends_on ? { depends_on: t.depends_on } : {}),
            ...(t.owner ? { owner: t.owner } : {}),
          },
        })),
        `Added ${tasks.length} task${tasks.length === 1 ? '' : 's'}: ${tasks.map((t) => t.key).join(', ')}.${note}`,
      );
    },
  );

  register(
    'task_update',
    {
      description: 'Update a task: progress note, status change, or mark done/blocked.',
      inputSchema: {
        key: z.string(),
        status: z.enum(['todo', 'doing', 'done', 'blocked']).optional(),
        note: z.string().optional(),
      },
    },
    async ({ key, status, note }) =>
      publish({ kind: 'task', key, data: { ...(status ? { status } : {}), ...(note ? { note } : {}) } }, `Updated task "${key}".`),
  );

  // --- replacing entries: the plan should never silently hold two directions ---

  const REPLACES = z
    .array(z.string())
    .optional()
    .describe('Keys of existing entries this one replaces (they are removed from the plan). Use "kind:key" to replace a different kind.');

  /** Close ops for the entries a new entry replaces; returns an error message for unknown keys. */
  const replacementOps = (r: Repo, kind: Kind, newKey: string, refs: string[] = []): NewOp[] | string => {
    const ops: NewOp[] = [];
    for (const ref of refs) {
      const [k, key] = ref.includes(':') && KINDS.includes(ref.split(':')[0] as Kind) ? [ref.split(':')[0] as Kind, ref.slice(ref.indexOf(':') + 1)] : [kind, ref];
      if (k === kind && key === newKey) continue;
      if (entry(r, k, key)?.status !== 'open') return `Nothing to replace: there is no open ${k} "${key}" in the plan.`;
      ops.push({ type: 'close', kind: k, key, data: { superseded_by: `${kind}:${newKey}` } });
    }
    return ops;
  };

  /** Same-kind entries the agent should look at before adding a new one. */
  const neighbours = (r: Repo, kind: Kind, key: string, max = 6) =>
    [...reduce(readState(r).ops).values()]
      .filter((e) => e.kind === kind && e.status === 'open' && e.key !== key)
      .sort((a, b) => b.updatedAt - a.updatedAt)
      .slice(0, max);

  const reviewHint = (r: Repo, kind: Kind, key: string, isNew: boolean) => {
    if (!isNew) return '';
    const others = neighbours(r, kind, key);
    if (!others.length) return '';
    return `\nExisting ${kind}s: ${others.map((e) => `"${e.key}" (${describeEntry(e).slice(0, 90)})`).join('; ')}. If the new one contradicts or replaces any of them, remove them with plan_remove (superseded_by="${kind}:${key}") or call again with replaces.`;
  };

  /** Shared path for goal/decision/contract writes that may replace older entries. */
  const publishReplacing = (kind: Kind, key: string, data: Record<string, unknown>, replaces: string[] | undefined, message: string): Reply => {
    const r = repo();
    if (!r) return text(NOT_A_REPO, true);
    const closes = replacementOps(r, kind, key, replaces);
    if (typeof closes === 'string') return text(closes, true);
    const isNew = entry(r, kind, key)?.status !== 'open';
    const hint = replaces?.length ? '' : reviewHint(r, kind, key, isNew);
    const replaced = closes.length ? ` Replaced: ${closes.map((c) => `${c.kind} "${c.key}"`).join(', ')}.` : '';
    return publishMany([{ kind, key, data }, ...closes], `${message}${replaced}${hint}`);
  };

  register(
    'contract_publish',
    {
      description:
        'Publish or change something other agents build against: an API route and its request/response shape, a DB schema, a shared type, an env var, or file ownership. Set breaking=true if existing consumers must change. If it supersedes an existing contract under another key, pass replaces.',
      inputSchema: {
        key: z.string().describe('Stable name, e.g. "POST /api/login" or "User"'),
        spec: z.string().describe('The concrete shape, e.g. "{ id: uuid, email: string }"'),
        breaking: z.boolean().optional(),
        areas: z.array(z.string()).optional(),
        replaces: REPLACES,
      },
    },
    async ({ key, spec, breaking, areas, replaces }) =>
      publishReplacing('contract', key, { spec, breaking: breaking ?? false, ...(areas ? { areas } : {}) }, replaces, `Published contract "${key}"${breaking ? ' as BREAKING' : ''}.`),
  );

  register(
    'decision_log',
    {
      description:
        'Record a project decision teammates should follow (library choice, convention, architecture). If it overturns an earlier decision, pass replaces so the old one is removed instead of contradicting it.',
      inputSchema: { key: z.string(), text: z.string(), rationale: z.string().optional(), replaces: REPLACES },
    },
    async ({ key, text: t, rationale, replaces }) =>
      publishReplacing('decision', key, { text: t, ...(rationale ? { rationale } : {}) }, replaces, `Logged decision "${key}".`),
  );

  register(
    'goal_set',
    {
      description:
        "Set or change a project goal. If the plan already has goals, you must say how the new one relates: replaces=[keys] when it supersedes them (they are removed), or alongside=true when it's a competing proposal the team hasn't chosen between yet. If you don't know which, ask the user first.",
      inputSchema: {
        key: z.string(),
        text: z.string(),
        replaces: REPLACES,
        alongside: z.boolean().optional().describe('Keep existing goals and mark this as a competing proposal'),
      },
    },
    async ({ key, text: t, replaces, alongside }) => {
      const r = repo();
      if (!r) return text(NOT_A_REPO, true);
      const others = neighbours(r, 'goal', key, 20);
      const updatingSelf = entry(r, 'goal', key)?.status === 'open';
      if (others.length && !updatingSelf && !replaces?.length && !alongside) {
        return text(
          `Not saved yet. The plan already has goals:\n${others.map((e) => `- "${e.key}" by ${e.createdBy}: ${String(e.data.text).slice(0, 160)}`).join('\n')}\n` +
            'Call goal_set again with replaces=[…] if your goal supersedes some of them, or alongside=true if it is a competing proposal the team still has to choose between. If you are not sure which, ask the user.',
          true,
        );
      }
      // Always written, so resolving a competition (replaces / plain update) clears the old marker.
      const data: Record<string, unknown> = { text: t, alternative_to: alongside ? others.map((e) => e.key) : [] };
      return publishReplacing('goal', key, data, replaces, alongside ? `Set goal "${key}" as a competing proposal; the plan now flags that the team must choose.` : `Set goal "${key}".`);
    },
  );

  register(
    'question',
    {
      description: 'Ask the team an open question, or answer one: providing answer resolves it and removes it from the open questions.',
      inputSchema: { key: z.string(), text: z.string().optional(), answer: z.string().optional() },
    },
    async ({ key, text: t, answer }) =>
      answer
        ? publish({ type: 'close', kind: 'question', key, data: { ...(t ? { text: t } : {}), answer } }, `Answered and closed "${key}".`)
        : publish({ kind: 'question', key, data: t ? { text: t } : {} }, `Asked "${key}".`),
  );

  register(
    'note_add',
    {
      description:
        "Write to the team notebook: status, observations, measurements, results, environment state (e.g. 'lab box is busy until 14:00', 'eval run: precision 0.82', 'image built locally, not in the registry'). Use this instead of decision_log for anything that is a fact about the current state rather than a choice the team must follow. Notes from the last 24h are shown to every agent.",
      inputSchema: {
        text: z.string(),
        key: z.string().optional().describe('Reuse a key to update a running note (e.g. "lab-status"); omit for a one-off note'),
        areas: z.array(z.string()).optional(),
      },
    },
    async ({ text: t, key, areas }) => {
      const k = key ?? `note-${new Date().toISOString().slice(0, 16).replace(/[:T]/g, '')}-${Math.random().toString(36).slice(2, 5)}`;
      return publish({ kind: 'note', key: k, data: { text: t, ...(areas ? { areas } : {}) } }, `Noted "${k}".`);
    },
  );

  register(
    'notebook_get',
    {
      description: 'Read the team notebook (status notes, observations, results), newest first. Optionally only notes matching a search term.',
      inputSchema: {
        query: z.string().optional().describe('Case-insensitive text to match'),
        limit: z.number().int().min(1).max(200).optional().describe('Default 40'),
        include_expired: z.boolean().optional().describe('Also show notes older than 7 days (they describe state that has probably changed)'),
      },
    },
    async ({ query, limit, include_expired }) => {
      const r = repo();
      if (!r) return text(NOT_A_REPO, true);
      const q = query?.toLowerCase();
      const notes = [...reduce(readState(r).ops).values()]
        .filter((e) => e.kind === 'note' && e.status === 'open' && (include_expired || !isExpiredNote(e)) && (!q || JSON.stringify(e.data).toLowerCase().includes(q) || e.key.toLowerCase().includes(q)))
        .sort((a, b) => b.updatedAt - a.updatedAt)
        .slice(0, limit ?? 40);
      if (!notes.length) return text(q ? `No notes match "${query}".` : 'The notebook is empty.');
      return text(notes.map((e) => `- ${new Date(e.updatedAt).toISOString().slice(0, 16).replace('T', ' ')}Z ${e.updatedBy}: ${describeEntry(e)}`).join('\n'));
    },
  );

  register(
    'plan_remove',
    {
      description: 'Remove an obsolete entry from the plan, optionally naming what replaced it.',
      inputSchema: {
        kind: z.enum(KINDS as [Kind, ...Kind[]]),
        key: z.string(),
        superseded_by: z.string().optional().describe('"kind:key" of the entry that replaces it, if any'),
      },
    },
    async ({ kind, key, superseded_by }) =>
      publish({ type: 'close', kind, key, data: superseded_by ? { superseded_by } : {} }, `Removed ${kind} "${key}".`),
  );

  register(
    'plan_tidy',
    {
      description:
        'Find plan entries that are finished, duplicated or outdated (tasks the commits show done, superseded images/deployments, contracts that are only internal details, decisions that are really status). Returns proposals; pass apply=true to apply them. Takes ~20s.',
      inputSchema: { apply: z.boolean().optional() },
    },
    async ({ apply }) => {
      const r = repo();
      if (!r) return text(NOT_A_REPO, true);
      const { proposeTidy, proposalOps, formatProposals } = await import('./tidy.js');
      try {
        const proposals = await proposeTidy(r);
        if (apply && proposals.length) {
          writeOps(r, proposalOps(r, proposals));
          ensureDaemon(r);
          return text(`Applied ${proposals.length} changes:\n${formatProposals(proposals)}`);
        }
        return text(`${formatProposals(proposals)}${proposals.length ? '\n\nCall again with apply=true to apply.' : ''}`);
      } catch (err) {
        return text(`Tidy failed: ${(err as Error).message}`, true);
      }
    },
  );

  register(
    'plan_review',
    {
      description:
        'Check the shared plan for contradictions (competing goals, decisions that cannot both hold, obsolete tasks). Takes ~15s. Use it when the plan looks inconsistent, then resolve with goal_set/decision_log replaces or plan_remove, asking the user when it is a team choice.',
      inputSchema: {},
    },
    async () => {
      const r = repo();
      if (!r) return text(NOT_A_REPO, true);
      const { reviewPlan, formatConflicts } = await import('./review.js');
      try {
        return text(formatConflicts(await reviewPlan(r)));
      } catch (err) {
        return text(`Review failed: ${(err as Error).message}`, true);
      }
    },
  );

  await server.connect(new StdioServerTransport());
}
