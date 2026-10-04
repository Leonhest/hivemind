import path from 'node:path';
import { formatDiff, formatSummary } from './core/format.js';
import { ensureDaemon } from './daemon.js';
import { spawnExtract } from './extract.js';
import { findRepo, type Repo } from './git.js';
import { log } from './log.js';
import { loadSession, readState, saveSession, touchActivity, type Session } from './store.js';

export type HookEvent = 'SessionStart' | 'UserPromptSubmit' | 'PostToolUse' | 'Stop';

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

const CLAUDE_EVENTS = new Set<HookEvent>(['SessionStart', 'UserPromptSubmit', 'PostToolUse', 'Stop']);

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
For anything other agents build against — API routes, schemas, shared types, file ownership — or project-wide decisions, publish it right away with the hivemind MCP tools (contract_publish, decision_log, task_claim, task_update) so teammates don't wait. Mark incompatible contract changes breaking=true.`;

const SUMMARY_CHARS = 3200;

/** Op ids returned by our own MCP tools, e.g. "[op:abc123]". */
function ownOpIds(input: HookInput): string[] {
  if (!input.toolName?.includes('hivemind')) return [];
  return [...JSON.stringify(input.toolResponse ?? '').matchAll(/\[op:([\w-]+)\]/g)].map((m) => m[1]);
}

function touchedFiles(repo: Repo, input: HookInput): string[] {
  const i = input.toolInput ?? {};
  const candidates = [i.file_path, i.path, i.notebook_path, i.target_file].filter((p): p is string => typeof p === 'string');
  return candidates.map((p) => path.relative(repo.root, path.resolve(repo.root, p))).filter((p) => !p.startsWith('..'));
}

function startSession(repo: Repo, sessionId: string): string {
  const state = readState(repo);
  saveSession(repo, sessionId, { lastSeq: state.seq, ownOps: [], touched: [], startedAt: Date.now() });
  return `${INTRO}\n\nCurrent shared plan (you are ${repo.memberId}):\n${formatSummary(state.ops, SUMMARY_CHARS)}`;
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

  if (event === 'PostToolUse') {
    session.ownOps.push(...ownOpIds(input));
    for (const f of touchedFiles(repo, input)) if (!session.touched.includes(f)) session.touched.push(f);
  }

  let context = '';
  if (event === 'UserPromptSubmit' || event === 'PostToolUse') {
    const state = readState(repo);
    const own = new Set(session.ownOps);
    context = formatDiff(state.ops, session.lastSeq, { isOwn: (o) => own.has(o.id) || o.agent === sessionId, touched: session.touched });
    session.lastSeq = state.seq;
  }
  saveSession(repo, sessionId, session);

  if (event === 'Stop' && input.transcript && !process.env.HIVEMIND_NO_EXTRACT) spawnExtract(repo, agent, sessionId, input.transcript);
  return context;
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
    done(adapter.render(input.event, handleEvent(repo, input, agentName)));
  } catch (err) {
    log(repo, `hook ${agentName} ${rawEvent} failed: ${(err as Error).stack ?? err}`);
    done(fallback);
  }
}
