import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { formatDiff, formatSummary } from './core/format.js';
import { reduce } from './core/plan.js';
import { ensureDaemon, readSyncStatus } from './daemon.js';
import { isExtracting, lastReviewed, spawnExtract } from './extract.js';
import { FETCH_REFSPEC, findRepo, type Repo } from './git.js';
import { log } from './log.js';
import { PUBLIC_NOTICE, readVisibility, refreshVisibility } from './visibility.js';
import { loadSession, readState, rebuild, saveSession, touchActivity, type Session } from './store.js';

export type HookEvent = 'SessionStart' | 'UserPromptSubmit' | 'PreToolUse' | 'PostToolUse' | 'Stop';

/** Agent-independent view of a hook call. */
export interface HookInput {
  event: HookEvent;
  sessionId: string;
  cwd?: string;
  transcript?: string;
  toolName?: string;
  toolInput?: Record<string, unknown>;
  toolResponse?: unknown;
}

interface Adapter {
  /** Map the agent's raw event + stdin payload to a HookInput, or null to ignore. */
  parse(rawEvent: string, raw: any): HookInput | null;
  /** What to print on stdout for this event. */
  render(event: HookEvent, context: string): string;
}

const CLAUDE_EVENTS = new Set<HookEvent>(['SessionStart', 'UserPromptSubmit', 'PreToolUse', 'PostToolUse', 'Stop']);

/** Claude Code and Codex share a hook protocol. */
const claudeLike = (stopOutput: string): Adapter => ({
  parse(rawEvent, raw) {
    const event = (raw.hook_event_name ?? rawEvent) as HookEvent;
    if (!CLAUDE_EVENTS.has(event)) return null;
    return {
      event,
      sessionId: raw.session_id ?? 'default',
      cwd: raw.cwd,
      transcript: raw.transcript_path ?? undefined,
      toolName: raw.tool_name,
      toolInput: raw.tool_input,
      toolResponse: raw.tool_response,
    };
  },
  render(event, context) {
    if (event === 'Stop') return stopOutput;
    return context ? JSON.stringify({ hookSpecificOutput: { hookEventName: event, additionalContext: context } }) : '';
  },
});

const CURSOR_EVENTS: Record<string, HookEvent> = { sessionStart: 'SessionStart', postToolUse: 'PostToolUse', stop: 'Stop' };

const cursor: Adapter = {
  parse(rawEvent, raw) {
    const event = CURSOR_EVENTS[raw.hook_event_name ?? rawEvent];
    if (!event) return null;
    return {
      event,
      sessionId: raw.conversation_id ?? raw.session_id ?? 'default',
      cwd: raw.cwd ?? raw.workspace_roots?.[0] ?? process.env.CURSOR_PROJECT_DIR,
      transcript: raw.transcript_path ?? process.env.CURSOR_TRANSCRIPT_PATH ?? undefined,
      toolName: raw.tool_name,
      toolInput: raw.tool_input,
      toolResponse: raw.tool_output,
    };
  },
  render(_event, context) {
    // Cursor expects a JSON object on every hook.
    return JSON.stringify(context ? { additional_context: context } : {});
  },
};

export const ADAPTERS: Record<string, Adapter> = {
  claude: claudeLike(''),
  codex: claudeLike('{}'), // Codex requires JSON on stdout from Stop hooks.
  cursor,
};

const INTRO = `[hivemind] This repo shares a live plan with teammates' coding agents on other machines (synced through git). Teammates' changes appear in your context automatically, and the plan is updated automatically from your work.
For anything other agents build against — API routes, schemas, shared types, file ownership — or project-wide decisions, publish it right away with the hivemind MCP tools (contract_publish, decision_log, task_claim, task_update) so teammates don't wait. Mark incompatible contract changes breaking=true.
When the user asks you to plan or split up work, record the plan in hivemind: goal_set for goals, contract_publish for the interfaces between pieces, decision_log for choices, and task_add for the tasks (unassigned unless the user says who does what) so teammates can claim them. Never put credentials, personal details or unfixed security issues in the plan.`;

const SUMMARY_CHARS = 3200;

/** Op ids returned by our own MCP tools, e.g. "[op:abc123]". */
function ownOpIds(input: HookInput): string[] {
  if (!input.toolName?.includes('hivemind')) return [];
  return [...JSON.stringify(input.toolResponse ?? '').matchAll(/\[op:([\w-]+)\]/g)].map((m) => m[1]);
}

/** Tools that change files, across Claude Code, Codex and Cursor. */
export const isEditTool = (name?: string) =>
  !!name && /^(Edit|MultiEdit|Write|NotebookEdit|apply_patch|edit_file|write|search_replace|str_replace_based_edit_tool)$/i.test(name);

/** Is this agent working on a task the team can see? */
function hasClaim(repo: Repo, sessionId: string, session: Session): boolean {
  const own = new Set(session.ownOps);
  const ops = readState(repo).ops;
  if (ops.some((o) => o.kind === 'task' && (own.has(o.id) || o.agent === sessionId))) return true;
  return [...reduce(ops).values()].some((e) => e.kind === 'task' && e.status === 'open' && e.data.owner === repo.memberId && e.data.status === 'doing');
}

function claimNudge(repo: Repo): string {
  const open = [...reduce(readState(repo).ops).values()]
    .filter((e) => e.kind === 'task' && e.status === 'open' && !e.data.owner && (e.data.status ?? 'todo') === 'todo')
    .slice(0, 5)
    .map((e) => `\`${e.key}\` (${String(e.data.title ?? e.key).slice(0, 60)})`);
  const pick = open.length ? ` Unclaimed tasks: ${open.join(', ')}.` : '';
  return `[hivemind] You're about to change files, but the shared plan shows no task in progress for you, so teammates can't see what you're working on. Claim it now with task_claim (an existing task's key, or a new key + title).${pick}`;
}

const CHECK_GRACE_MS = 3 * 60_000;

/** After a turn that changed files: did anything (the agent or the extractor) record it in the plan? */
function updateNudge(repo: Repo, sessionId: string, session: Session): string {
  const check = session.pendingCheck;
  if (!check) return '';
  // Give the background extractor time to finish before judging.
  if (isExtracting(repo, sessionId) && Date.now() - check.at < CHECK_GRACE_MS) return '';
  delete session.pendingCheck;
  const own = new Set(session.ownOps);
  const published = readState(repo).ops.some((o) => (own.has(o.id) || o.agent === sessionId) && o.ts >= check.since);
  if (published || lastReviewed(repo, sessionId) >= check.at) return '';
  const files = check.files.slice(0, 4).join(', ') + (check.files.length > 4 ? ` and ${check.files.length - 4} more` : '');
  return `[hivemind] Your last turn changed ${files}, but the shared plan wasn't updated. Update your task (task_update with status/note), and publish any API, schema or decision changes teammates depend on.`;
}

function touchedFiles(repo: Repo, input: HookInput): string[] {
  const i = input.toolInput ?? {};
  const candidates = [i.file_path, i.path, i.notebook_path, i.target_file].filter((p): p is string => typeof p === 'string');
  return candidates.map((p) => path.relative(repo.root, path.resolve(repo.root, p))).filter((p) => !p.startsWith('..'));
}

/** A clone that has never synced would show an empty plan; fetch once, briefly, before the first summary. */
function firstSync(repo: Repo): void {
  if (readSyncStatus(repo).lastFetch) return;
  try {
    execFileSync('git', ['fetch', '-q', '--no-tags', 'origin', FETCH_REFSPEC], {
      cwd: repo.root,
      timeout: 3_000,
      stdio: 'ignore',
      env: { ...process.env, GIT_TERMINAL_PROMPT: '0' },
    });
    rebuild(repo);
  } catch {}
}

function startSession(repo: Repo, sessionId: string): string {
  firstSync(repo);
  const state = readState(repo);
  saveSession(repo, sessionId, { lastSeq: state.seq, ownOps: [], touched: [], startedAt: Date.now() });
  const notice = readVisibility(repo)?.public ? `\n${PUBLIC_NOTICE}` : '';
  return `${INTRO}${notice}\n\nCurrent shared plan (you are ${repo.memberId}):\n${formatSummary(state.ops, SUMMARY_CHARS)}`;
}

/** Returns the text to inject into the agent's context, or '' for nothing. */
export function handleEvent(repo: Repo, input: HookInput, agent = 'claude'): string {
  const { event, sessionId } = input;
  touchActivity(repo);
  ensureDaemon(repo);

  const existing = loadSession(repo, sessionId);
  if (event === 'SessionStart' || !existing) {
    const context = startSession(repo, sessionId);
    return event === 'Stop' ? '' : context;
  }
  const session: Session = existing;
  const parts: string[] = [];

  if (event === 'PreToolUse') {
    // Nudge 1: before the first edit, make sure teammates can see what this agent is working on.
    if (isEditTool(input.toolName) && !session.nudgedClaim && !hasClaim(repo, sessionId, session)) {
      session.nudgedClaim = true;
      parts.push(claimNudge(repo));
    }
  }

  if (event === 'PostToolUse') {
    session.ownOps.push(...ownOpIds(input));
    const files = touchedFiles(repo, input);
    for (const f of files) if (!session.touched.includes(f)) session.touched.push(f);
    if (isEditTool(input.toolName)) session.turnEdits = [...new Set([...(session.turnEdits ?? []), ...(files.length ? files : [input.toolName!])])];
  }

  if (event === 'UserPromptSubmit' || event === 'PostToolUse') {
    // Nudge 2: the previous turn changed files and nothing recorded it.
    parts.push(updateNudge(repo, sessionId, session));
    const state = readState(repo);
    const own = new Set(session.ownOps);
    parts.push(formatDiff(state.ops, session.lastSeq, { isOwn: (o) => own.has(o.id) || o.agent === sessionId, touched: session.touched }));
    session.lastSeq = state.seq;
  }
  if (event === 'UserPromptSubmit') {
    session.turnStartedAt = Date.now();
    session.turnEdits = [];
  }
  if (event === 'Stop') {
    if (session.turnEdits?.length) {
      session.pendingCheck = { since: session.turnStartedAt ?? session.startedAt, files: session.turnEdits, at: Date.now() };
    }
    session.turnEdits = [];
  }
  saveSession(repo, sessionId, session);

  if (event === 'Stop' && input.transcript && !process.env.HIVEMIND_NO_EXTRACT) spawnExtract(repo, agent, sessionId, input.transcript);
  return parts.filter(Boolean).join('\n\n');
}

function readStdin(): Promise<string> {
  return new Promise((resolve) => {
    if (process.stdin.isTTY) return resolve('');
    let data = '';
    process.stdin.setEncoding('utf8');
    process.stdin.on('data', (d) => (data += d));
    process.stdin.on('end', () => resolve(data));
  });
}

/** `hivemind hook <agent> <event>`: must be fast, silent on failure, and never block the agent. */
export async function runHook(agentName: string, rawEvent: string): Promise<void> {
  const adapter = ADAPTERS[agentName] ?? ADAPTERS.claude;
  const fallback = adapter.render(rawEvent as HookEvent, '');
  let printed = false;
  const done = (out: string) => {
    if (out && !printed) process.stdout.write(out);
    printed = true;
  };
  setTimeout(() => {
    done(fallback);
    process.exit(0);
  }, 4_000).unref();
  if (process.env.HIVEMIND_EXTRACTOR) return done(fallback);

  let repo: Repo | null = null;
  try {
    const raw = await readStdin();
    const input = adapter.parse(rawEvent, raw.trim() ? JSON.parse(raw) : {});
    if (!input) return done(fallback);
    repo = findRepo(input.cwd ?? process.cwd());
    if (!repo) return done(adapter.render(input.event, ''));
    // First session in a clone: learn whether the repo is public before showing the plan (bounded wait).
    if (input.event === 'SessionStart' && !readVisibility(repo)) {
      await Promise.race([refreshVisibility(repo).catch(() => {}), new Promise((r) => setTimeout(r, 1_500))]);
    }
    done(adapter.render(input.event, handleEvent(repo, input, agentName)));
  } catch (err) {
    log(repo, `hook ${agentName} ${rawEvent} failed: ${(err as Error).stack ?? err}`);
    done(fallback);
  }
}
