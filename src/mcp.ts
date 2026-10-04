import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import { describeEntry, formatSummary } from './core/format.js';
import { entryId, reduce } from './core/plan.js';
import { KINDS, type Kind } from './core/types.js';
import { ensureDaemon } from './daemon.js';
import { findRepo, type Repo } from './git.js';
import { readState, touchActivity, writeOps, type NewOp } from './store.js';
import { PUBLIC_NOTICE, readVisibility } from './visibility.js';

const VERSION = '0.1.5';

type Reply = { content: { type: 'text'; text: string }[]; isError?: boolean };
const text = (t: string, isError = false): Reply => ({ content: [{ type: 'text', text: t }], ...(isError ? { isError } : {}) });

const NOT_A_REPO = 'hivemind is inactive here: not inside a git repository with an "origin" remote, or turned off with hivemind disable.';
const PROPAGATES = "Teammates' agents will see it at their next tool call.";

export async function runMcp(): Promise<void> {
  const server = new McpServer({ name: 'hivemind', version: VERSION });

  // Resolved per call: the server may be started before the repo has a remote.
  // Cursor starts MCP servers outside the project, so its config passes the workspace in HIVEMIND_CWD.
  const repo = (): Repo | null => findRepo(process.env.HIVEMIND_CWD || process.cwd());

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

  server.registerTool(
    'plan_get',
    {
      description: "Read the team's shared plan: goals, contracts (APIs/schemas/types), decisions, tasks and open questions.",
      inputSchema: { kind: z.enum(KINDS as [Kind, ...Kind[]]).optional().describe('Only return this kind of entry') },
    },
    async ({ kind }) => {
      const r = repo();
      if (!r) return text(NOT_A_REPO, true);
      touchActivity(r);
      const ops = readState(r).ops.filter((o) => !kind || o.kind === kind);
      const notice = readVisibility(r)?.public ? `${PUBLIC_NOTICE}\n` : '';
      return text(`${notice}You are ${r.memberId}.\n${formatSummary(ops)}`);
    },
  );

  server.registerTool(
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
        r && owner && owner !== r.memberId && prev?.data.status === 'doing' ? ` Warning: ${owner} had already claimed this task; coordinate with them.` : '';
      return publish(
        { kind: 'task', key, data: { ...(title ? { title } : {}), status: 'doing', owner: r?.memberId, ...(areas ? { areas } : {}) } },
        `Claimed task "${key}".${warning}`,
      );
    },
  );

  server.registerTool(
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

  server.registerTool(
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

  server.registerTool(
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

  server.registerTool(
    'decision_log',
    {
      description:
        'Record a project decision teammates should follow (library choice, convention, architecture). If it overturns an earlier decision, pass replaces so the old one is removed instead of contradicting it.',
      inputSchema: { key: z.string(), text: z.string(), rationale: z.string().optional(), replaces: REPLACES },
    },
    async ({ key, text: t, rationale, replaces }) =>
      publishReplacing('decision', key, { text: t, ...(rationale ? { rationale } : {}) }, replaces, `Logged decision "${key}".`),
  );

  server.registerTool(
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

  server.registerTool(
    'question',
    {
      description: 'Ask the team an open question, or answer one (providing answer closes it for discussion).',
      inputSchema: { key: z.string(), text: z.string().optional(), answer: z.string().optional() },
    },
    async ({ key, text: t, answer }) =>
      publish({ kind: 'question', key, data: { ...(t ? { text: t } : {}), ...(answer ? { answer } : {}) } }, answer ? `Answered "${key}".` : `Asked "${key}".`),
  );

  server.registerTool(
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

  server.registerTool(
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
