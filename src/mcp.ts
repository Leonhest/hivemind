import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import { formatSummary } from './core/format.js';
import { entryId, reduce } from './core/plan.js';
import { KINDS, type Kind } from './core/types.js';
import { ensureDaemon } from './daemon.js';
import { findRepo, type Repo } from './git.js';
import { readState, touchActivity, writeOps, type NewOp } from './store.js';

const VERSION = '0.1.0';

type Reply = { content: { type: 'text'; text: string }[]; isError?: boolean };
const text = (t: string, isError = false): Reply => ({ content: [{ type: 'text', text: t }], ...(isError ? { isError } : {}) });

const NOT_A_REPO = 'hivemind is inactive here: not inside a git repository with an "origin" remote.';
const PROPAGATES = "Teammates' agents will see it at their next tool call.";

export async function runMcp(): Promise<void> {
  const server = new McpServer({ name: 'hivemind', version: VERSION });

  // Resolved per call: the server may be started before the repo has a remote.
  const repo = (): Repo | null => findRepo(process.cwd());

  const publish = (op: NewOp, message: string): Reply => {
    const r = repo();
    if (!r) return text(NOT_A_REPO, true);
    touchActivity(r);
    ensureDaemon(r);
    const [written] = writeOps(r, [op]);
    return text(`${message} ${PROPAGATES} [op:${written.id}]`);
  };

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
      return text(`You are ${r.memberId}.\n${formatSummary(ops)}`);
    },
  );

  server.registerTool(
    'task_claim',
    {
      description: 'Claim a task so teammates know you are working on it. Call before starting a piece of work.',
      inputSchema: {
        key: z.string().describe('Short stable id, e.g. "auth-api"'),
        title: z.string(),
        areas: z.array(z.string()).optional().describe('Files, directories or topics this task touches'),
      },
    },
    async ({ key, title, areas }) => {
      const r = repo();
      const prev = r && entry(r, 'task', key);
      const owner = prev?.status === 'open' ? prev.data.owner : undefined;
      const warning =
        r && owner && owner !== r.memberId && prev?.data.status === 'doing' ? ` Warning: ${owner} had already claimed this task; coordinate with them.` : '';
      return publish(
        { kind: 'task', key, data: { title, status: 'doing', owner: r?.memberId, ...(areas ? { areas } : {}) } },
        `Claimed task "${key}".${warning}`,
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
