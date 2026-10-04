import { formatDiff, formatSummary } from './core/format.js';
import { ensureDaemon } from './daemon.js';
import { findRepo, type Repo } from './git.js';
import { log } from './log.js';
import { loadSession, readState, saveSession, touchActivity, type Session } from './store.js';

/** Fields Claude Code (and Codex) send on stdin. */
interface HookInput {
  session_id?: string;
  cwd?: string;
  hook_event_name?: string;
  tool_name?: string;
  tool_input?: Record<string, unknown>;
  tool_response?: unknown;
}

const INTRO = `[hivemind] This repo shares a live plan with teammates' coding agents (synced through git). Updates from teammates will appear in your context automatically.
When you make something other agents depend on — an API route, schema, shared type, file ownership, or a project decision — publish it with the hivemind MCP tools (contract_publish, decision_log, task_claim, task_update). Claim your task before starting. Mark breaking contract changes with breaking=true.`;

const SUMMARY_CHARS = 3200;

function readStdin(): Promise<string> {
  return new Promise((resolve) => {
    if (process.stdin.isTTY) return resolve('');
    let data = '';
    process.stdin.setEncoding('utf8');
    process.stdin.on('data', (d) => (data += d));
    process.stdin.on('end', () => resolve(data));
  });
}

/** Op ids returned by our own MCP tools, e.g. "[op:abc123]". */
function ownOpIds(input: HookInput): string[] {
  if (!input.tool_name?.includes('hivemind')) return [];
  return [...JSON.stringify(input.tool_response ?? '').matchAll(/\[op:([\w-]+)\]/g)].map((m) => m[1]);
}

function touchedFile(input: HookInput): string | null {
  const p = input.tool_input?.file_path ?? input.tool_input?.path;
  return typeof p === 'string' ? p : null;
}

function startSession(repo: Repo, sessionId: string): { session: Session; context: string } {
  const state = readState(repo);
  const session: Session = { lastSeq: state.seq, ownOps: [], touched: [], startedAt: Date.now() };
  saveSession(repo, sessionId, session);
  return { session, context: `${INTRO}\n\nCurrent shared plan (you are ${repo.memberId}):\n${formatSummary(state.ops, SUMMARY_CHARS)}` };
}

/** Returns the text to inject into the agent's context, or '' for nothing. */
export function handleEvent(repo: Repo, event: string, input: HookInput): string {
  const sessionId = input.session_id ?? 'default';
  touchActivity(repo);
  ensureDaemon(repo);

  const existing = loadSession(repo, sessionId);
  if (event === 'SessionStart' || !existing) return startSession(repo, sessionId).context;

  const session = existing;
  if (event === 'PostToolUse') {
    session.ownOps.push(...ownOpIds(input));
    const file = touchedFile(input);
    if (file && !session.touched.includes(file)) session.touched.push(file);
  }

  let context = '';
  if (event === 'UserPromptSubmit' || event === 'PostToolUse') {
    const state = readState(repo);
    context = formatDiff(state.ops, session.lastSeq, new Set(session.ownOps));
    session.lastSeq = state.seq;
  }
  saveSession(repo, sessionId, session);
  return context;
}

const INJECTABLE = new Set(['SessionStart', 'UserPromptSubmit', 'PostToolUse']);

/** `hivemind hook claude <Event>`: must be fast, silent on failure, and always exit 0. */
export async function runHook(agent: string, event: string): Promise<void> {
  setTimeout(() => process.exit(0), 4_000).unref();
  if (process.env.HIVEMIND_EXTRACTOR) return;
  let repo: Repo | null = null;
  try {
    const raw = await readStdin();
    const input: HookInput = raw.trim() ? JSON.parse(raw) : {};
    repo = findRepo(input.cwd ?? process.cwd());
    if (!repo) return;
    const context = handleEvent(repo, event, input);
    if (context && INJECTABLE.has(event)) {
      process.stdout.write(JSON.stringify({ hookSpecificOutput: { hookEventName: event, additionalContext: context } }));
    }
  } catch (err) {
    log(repo, `hook ${agent} ${event} failed: ${(err as Error).stack ?? err}`);
  }
}
