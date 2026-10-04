import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import { formatSummary } from './core/format.js';
import { entryId, reduce } from './core/plan.js';
import { KINDS, type Kind } from './core/types.js';
import { ensureDaemon } from './daemon.js';
import { findRepo, type Repo } from './git.js';
import { readState, touchActivity, writeOps, type NewOp } from './store.js';
import { PUBLIC_NOTICE, readVisibility } from './visibility.js';

const VERSION = '0.1.4';

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

  server.registerTool(
    'contract_publish',
    {
      description:
        'Publish or change something other agents build against: an API route and its request/response shape, a DB schema, a shared type, an env var, or file ownership. Set breaking=true if existing consumers must change.',
      inputSchema: {
        key: z.string().describe('Stable name, e.g. "POST /api/login" or "User"'),
        spec: z.string().describe('The concrete shape, e.g. "{ id: uuid, email: string }"'),
        breaking: z.boolean().optional(),
        areas: z.array(z.string()).optional(),
      },
    },
    async ({ key, spec, breaking, areas }) =>
      publish(
        { kind: 'contract', key, data: { spec, breaking: breaking ?? false, ...(areas ? { areas } : {}) } },
        `Published contract "${key}"${breaking ? ' as BREAKING' : ''}.`,
      ),
  );

  server.registerTool(
    'decision_log',
    {
      description: 'Record a project decision teammates should follow (library choice, convention, architecture).',
      inputSchema: { key: z.string(), text: z.string(), rationale: z.string().optional() },
    },
    async ({ key, text: t, rationale }) =>
      publish({ kind: 'decision', key, data: { text: t, ...(rationale ? { rationale } : {}) } }, `Logged decision "${key}".`),
  );

  server.registerTool(
    'goal_set',
    {
      description: 'Set or change a project goal / scope statement.',
      inputSchema: { key: z.string(), text: z.string() },
    },
    async ({ key, text: t }) => publish({ kind: 'goal', key, data: { text: t } }, `Set goal "${key}".`),
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
      description: 'Remove an obsolete entry from the plan.',
      inputSchema: { kind: z.enum(KINDS as [Kind, ...Kind[]]), key: z.string() },
    },
    async ({ kind, key }) => publish({ type: 'close', kind, key }, `Removed ${kind} "${key}".`),
  );

  await server.connect(new StdioServerTransport());
}
