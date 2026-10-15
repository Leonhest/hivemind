import { execFileSync, spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describeEntry } from './core/format.js';
import { entryId, reduce } from './core/plan.js';
import { KINDS, type Kind } from './core/types.js';
import { samePerson, type Repo } from './git.js';
import { log } from './log.js';
import { readState, writeOps, type NewOp } from './store.js';
import { isSubstantive, renderTranscript } from './transcript.js';

const MIN_CONFIDENCE = 0.7;
const MAX_OPS_PER_RUN = 8;
const TIMEOUT_MS = 180_000;

export const SYSTEM_PROMPT = `You maintain a shared plan for a team of coding agents working in the same repository, each on a different machine. You read a new segment of ONE agent's transcript and extract only facts the OTHER agents need in order to avoid conflicts and duplicated work.

Entry kinds:
- task: what this agent is working on (from the user's request), notable progress, completion, or being blocked. status: todo | doing | done | blocked.
- contract: anything other agents build against — API routes with request/response shapes, database schemas, shared types, env vars, CLI flags, module/file ownership. spec must be concrete. breaking=true only if it changes an existing contract incompatibly.
- decision: a CHOICE the team must keep following (a library, a convention, an architecture, a rule like "never bulk-copy over the store uplink"), with rationale if stated. Not a fact about the current state.
- question: an open question that needs input from the team. If the transcript answers or resolves an existing open question, emit it with its exact key and the answer in "answer" (it is then closed).
- note: the team notebook for STATE and FINDINGS that teammates benefit from but that aren't choices: what's running where, which machine is busy, disk/space, what was deployed or built (and where), measurements, eval/benchmark results, root causes found, incidents. Reuse a key to update a running status (e.g. "lab-box-status").

Telling decision and note apart: "We use Postgres" / "Don't deploy on Fridays" → decision. "dev-2 is busy until 14:00" / "precision is 0.82 on the eval set" / "image built locally, not pushed" → note.

Rules:
- Only include things explicitly stated or actually done in the transcript. Never guess.
- Skip internal implementation details, debugging, exploration, and anything that only matters to this agent.
- When an item matches an existing plan entry, reuse its exact key and only emit it if something changed.
- Keys: kebab-case for tasks/decisions/questions (e.g. "auth-api"); natural names for contracts (e.g. "POST /api/login", "User").
- Prefer a few high-value entries. An empty list is a good answer when nothing qualifies.
- evidence: a short verbatim quote from the transcript supporting the entry.
- replaces: when the work clearly abandons or overturns an existing plan entry (a new approach, a switched library, a dropped feature), list that entry's exact key so it is removed. Only for explicit changes of direction, never because something is merely related.
- areas: repo-relative files or directories the entry concerns (for tasks: what this agent is changing).
- NEVER include credentials, tokens, keys, passwords, personal details (emails, phone numbers, real names other than member ids), customer or company names that aren't part of the product, or unfixed security vulnerabilities. Describe the work generically instead (e.g. "hardening auth checks"), or leave it out.
- Use null for fields that don't apply.`;

const nullable = (type: string, extra: object = {}) => ({ type: [type, 'null'], ...extra });
export const SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['ops'],
  properties: {
    ops: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['kind', 'key', 'title', 'status', 'spec', 'breaking', 'text', 'rationale', 'answer', 'areas', 'replaces', 'confidence', 'evidence'],
        properties: {
          kind: { type: 'string', enum: KINDS.filter((k) => k !== 'goal') },
          key: { type: 'string' },
          title: nullable('string'),
          status: nullable('string', { enum: ['todo', 'doing', 'done', 'blocked', null] }),
          spec: nullable('string'),
          breaking: nullable('boolean'),
          text: nullable('string'),
          rationale: nullable('string'),
          answer: nullable('string'),
          areas: { type: ['array', 'null'], items: { type: 'string' } },
          replaces: { type: ['array', 'null'], items: { type: 'string' } },
          confidence: { type: 'number' },
          evidence: { type: 'string' },
        },
      },
    },
  },
};

export interface Extracted {
  kind: Exclude<Kind, 'goal'>;
  key: string;
  title?: string | null;
  status?: string | null;
  spec?: string | null;
  breaking?: boolean | null;
  text?: string | null;
  rationale?: string | null;
  answer?: string | null;
  areas?: string[] | null;
  replaces?: string[] | null;
  confidence: number;
  evidence: string;
}

// --- backends: run on the member's own agent login ---

const has = (bin: string) => {
  try {
    execFileSync('which', [bin], { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
};

/** The human-readable error from a claude -p JSON result, if it is one. */
function modelError(out: string): string | null {
  try {
    const parsed = JSON.parse(out);
    return parsed.is_error ? String(parsed.result ?? 'unknown error') : null;
  } catch {
    return null;
  }
}

const childEnv = () => ({ ...process.env, HIVEMIND_EXTRACTOR: '1' });

function run(bin: string, args: string[], input: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn(bin, args, { env: childEnv(), stdio: ['pipe', 'pipe', 'pipe'] });
    let out = '';
    let err = '';
    const timer = setTimeout(() => child.kill('SIGKILL'), TIMEOUT_MS);
    child.stdout.on('data', (d) => (out += d));
    child.stderr.on('data', (d) => (err += d));
    child.on('error', reject);
    child.on('close', (code) => {
      clearTimeout(timer);
      // claude -p reports errors as JSON on stdout, so include both streams.
      code === 0 ? resolve(out) : reject(new Error(`${bin} exited ${code}: ${(err.trim() || modelError(out) || out).slice(0, 500)}`));
    });
    child.stdin.end(input);
  });
}

export interface ModelOptions {
  /** Claude model alias; default haiku. */
  model?: string;
  /** Hidden thinking is on by default in claude -p and can multiply latency ~5x. */
  thinking?: boolean;
}

async function viaClaude(system: string, schema: object, prompt: string, opts: ModelOptions): Promise<any> {
  const settings = { disableAllHooks: true, ...(opts.thinking === false ? { alwaysThinkingEnabled: false } : {}) };
  const out = await run(
    'claude',
    [
      '-p', '--model', process.env.HIVEMIND_CLAUDE_MODEL ?? opts.model ?? 'haiku',
      '--settings', JSON.stringify(settings), '--setting-sources', '', '--strict-mcp-config', '--tools', '',
      '--system-prompt', system, '--output-format', 'json', '--json-schema', JSON.stringify(schema),
    ],
    prompt,
  );
  const failure = modelError(out);
  if (failure) throw new Error(`claude: ${failure}`);
  const parsed = JSON.parse(out);
  if (process.env.HIVEMIND_DEBUG) {
    console.error(`[hivemind] claude: ${parsed.duration_ms}ms (api ${parsed.duration_api_ms}ms), ${parsed.num_turns} turns, in ${parsed.usage?.input_tokens}+${parsed.usage?.cache_read_input_tokens ?? 0} out ${parsed.usage?.output_tokens}`);
  }
  return parsed.structured_output ?? {};
}

async function viaCodex(system: string, schema: object, prompt: string, _opts: ModelOptions): Promise<any> {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hivemind-'));
  try {
    const schemaFile = path.join(dir, 'schema.json');
    const result = path.join(dir, 'out.json');
    fs.writeFileSync(schemaFile, JSON.stringify(schema));
    const model = process.env.HIVEMIND_CODEX_MODEL ? ['-m', process.env.HIVEMIND_CODEX_MODEL] : [];
    await run('codex', ['exec', '--ephemeral', '--skip-git-repo-check', '--sandbox', 'read-only', ...model, '--output-schema', schemaFile, '-o', result, '-'], `${system}\n\n${prompt}`);
    return JSON.parse(fs.readFileSync(result, 'utf8'));
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

/** One structured model call on the member's own agent login. */
export function askModel(backend: Backend, system: string, schema: object, prompt: string, opts: ModelOptions = {}): Promise<any> {
  return (backend === 'claude' ? viaClaude : viaCodex)(system, schema, prompt, opts);
}

export type Backend = 'claude' | 'codex';

const healthFile = () => path.join(os.homedir(), '.hivemind', 'backends.json');
type Health = Partial<Record<Backend, { failedAt: number; error: string }>>;
const FAILURE_COOLDOWN_MS = 60 * 60_000;

export function backendHealth(): Health {
  try {
    return JSON.parse(fs.readFileSync(healthFile(), 'utf8'));
  } catch {
    return {};
  }
}

function recordHealth(backend: Backend, error: string | null): void {
  try {
    const health = backendHealth();
    if (error) health[backend] = { failedAt: Date.now(), error: error.slice(0, 300) };
    else delete health[backend];
    fs.mkdirSync(path.dirname(healthFile()), { recursive: true });
    fs.writeFileSync(healthFile(), JSON.stringify(health));
  } catch {}
}

/** Installed backends in preference order, skipping ones that failed within the last hour. */
export function backendOrder(agent: string): Backend[] {
  const forced = process.env.HIVEMIND_EXTRACTOR_BACKEND;
  if (forced === 'none') return [];
  if (forced === 'claude' || forced === 'codex') return [forced];
  const health = backendHealth();
  const order: Backend[] = agent === 'codex' ? ['codex', 'claude'] : ['claude', 'codex'];
  const installed = order.filter(has);
  const healthy = installed.filter((b) => !health[b] || Date.now() - health[b]!.failedAt > FAILURE_COOLDOWN_MS);
  return healthy.length ? healthy : installed;
}

export const pickBackend = (agent: string): Backend | null => backendOrder(agent)[0] ?? null;

/** Ask the first backend that works; remember failures so the next run skips a broken one. */
async function askAnyModel(agent: string, system: string, schema: object, prompt: string, opts: ModelOptions = {}): Promise<{ backend: Backend; result: any }> {
  const errors: string[] = [];
  for (const backend of backendOrder(agent)) {
    try {
      const result = await askModel(backend, system, schema, prompt, opts);
      recordHealth(backend, null);
      return { backend, result };
    } catch (err) {
      recordHealth(backend, (err as Error).message);
      errors.push((err as Error).message);
    }
  }
  throw new Error(errors.join(' | ') || 'no extraction backend (claude or codex) installed');
}
export { askAnyModel };

// --- turning model output into plan ops ---

export function toOps(extracted: Extracted[], repo: Repo, agentId: string): NewOp[] {
  const entries = reduce(readState(repo).ops);
  const ops: NewOp[] = [];
  for (const e of extracted) {
    if (!e || typeof e.key !== 'string' || !e.key.trim() || !(e.confidence >= MIN_CONFIDENCE)) continue;
    let data: Record<string, unknown>;
    switch (e.kind) {
      case 'task':
        data = { title: e.title ?? e.text ?? e.key, status: e.status ?? 'doing', owner: repo.memberId };
        break;
      case 'contract':
        if (!e.spec) continue;
        data = { spec: e.spec, breaking: e.breaking ?? false };
        break;
      case 'decision':
        if (!e.text) continue;
        data = { text: e.text, ...(e.rationale ? { rationale: e.rationale } : {}) };
        break;
      case 'question':
        if (e.answer) {
          // Resolved: close it, keeping the answer on the closed entry.
          const q = entries.get(entryId({ kind: 'question', key: e.key }));
          if (q?.status === 'open') ops.push({ type: 'close', kind: 'question', key: e.key.trim(), data: { answer: e.answer }, source: 'inferred', evidence: String(e.evidence ?? '').slice(0, 300), agent: agentId });
          continue;
        }
        if (!e.text) continue;
        data = { text: e.text };
        break;
      case 'note':
        if (!e.text) continue;
        data = { text: e.text };
        break;
      default:
        continue;
    }
    if (Array.isArray(e.areas) && e.areas.length) data.areas = e.areas.filter((a) => typeof a === 'string').slice(0, 10);
    const existing = entries.get(entryId({ kind: e.kind, key: e.key }));
    // A task someone else owns: record progress without stealing ownership.
    if (e.kind === 'task' && existing?.data.owner && !samePerson(existing.data.owner, repo.memberId)) delete data.owner;
    const unchanged = existing?.status === 'open' && Object.entries(data).every(([k, v]) => JSON.stringify(existing.data[k]) === JSON.stringify(v));
    if (unchanged && !e.replaces?.length) continue;
    ops.push({ kind: e.kind, key: e.key.trim(), data, source: 'inferred', evidence: String(e.evidence ?? '').slice(0, 300), agent: agentId });
    for (const old of e.replaces ?? []) {
      const target = entries.get(entryId({ kind: e.kind, key: old }));
      if (old === e.key || target?.status !== 'open') continue;
      ops.push({ type: 'close', kind: e.kind, key: old, data: { superseded_by: `${e.kind}:${e.key.trim()}` }, source: 'inferred', evidence: String(e.evidence ?? '').slice(0, 300), agent: agentId });
    }
    if (ops.length >= MAX_OPS_PER_RUN) break;
  }
  return ops;
}

export function buildPrompt(repo: Repo, segment: string): string {
  // The plan plus only the last day of notes: the full notebook would swamp the prompt.
  const dayAgo = Date.now() - 24 * 60 * 60_000;
  const entries = [...reduce(readState(repo).ops).values()].filter((e) => e.status === 'open' && (e.kind !== 'note' || e.updatedAt > dayAgo));
  const plan = entries.length ? entries.map((e) => `- ${e.kind} "${e.key}": ${describeEntry(e).slice(0, 200)}`).join('\n') : '(empty)';
  return `Current shared plan:\n${plan}\n\nThis agent's team member id: ${repo.memberId}\n\nNew transcript segment:\n${segment}`;
}

// --- orchestration: one extractor per session at a time, never re-reading old transcript ---

interface Cursor {
  offset: number;
  /** When the extractor last reviewed this session's work (even if it found nothing to record). */
  reviewedAt?: number;
}

/** Last time the extractor finished reviewing this session, if ever. */
export function lastReviewed(repo: Repo, session: string): number {
  try {
    return (JSON.parse(fs.readFileSync(sessionFile(repo, session, 'extract.json'), 'utf8')) as Cursor).reviewedAt ?? 0;
  } catch {
    return 0;
  }
}

export const isExtracting = (repo: Repo, session: string) => fs.existsSync(sessionFile(repo, session, 'extract.lock'));

const sessionFile = (repo: Repo, session: string, suffix: string) =>
  path.join(repo.stateDir, 'sessions', `${session.replace(/[^\w-]/g, '_')}.${suffix}`);

function newLines(file: string, offset: number): { lines: string[]; offset: number } {
  const text = fs.readFileSync(file, 'utf8');
  // Ignore a trailing partial line; it'll be complete next time.
  const complete = text.slice(0, text.lastIndexOf('\n') + 1);
  const all = complete.split('\n').filter(Boolean);
  return { lines: all.slice(offset), offset: all.length };
}

/** Starts extraction in a detached background process and returns immediately. */
export function spawnExtract(repo: Repo, agent: string, session: string, transcript: string): void {
  fs.mkdirSync(path.join(repo.stateDir, 'sessions'), { recursive: true });
  const out = fs.openSync(path.join(repo.stateDir, 'extract.log'), 'a');
  spawn(process.execPath, [process.argv[1], 'extract', agent, session, transcript], {
    cwd: repo.root,
    detached: true,
    stdio: ['ignore', out, out],
  }).unref();
}

export async function runExtract(repo: Repo, agent: string, session: string, transcript: string): Promise<void> {
  const lock = sessionFile(repo, session, 'extract.lock');
  const pending = sessionFile(repo, session, 'extract.pending');
  fs.mkdirSync(path.dirname(lock), { recursive: true });
  try {
    fs.mkdirSync(lock);
  } catch {
    // Another extractor is running for this session; ask it to go again when done.
    if (Date.now() - fs.statSync(lock).mtimeMs < TIMEOUT_MS + 30_000) return void fs.writeFileSync(pending, '');
    fs.rmSync(lock, { recursive: true, force: true });
    fs.mkdirSync(lock);
  }
  try {
    do {
      fs.rmSync(pending, { force: true });
      await extractOnce(repo, agent, session, transcript);
    } while (fs.existsSync(pending));
  } finally {
    fs.rmSync(lock, { recursive: true, force: true });
  }
}

async function extractOnce(repo: Repo, agent: string, session: string, transcript: string): Promise<void> {
  if (!transcript || !fs.existsSync(transcript)) return;
  const cursorPath = sessionFile(repo, session, 'extract.json');
  const cursor: Cursor = fs.existsSync(cursorPath) ? JSON.parse(fs.readFileSync(cursorPath, 'utf8')) : { offset: 0 };
  const { lines, offset } = newLines(transcript, cursor.offset);
  const segment = renderTranscript(lines);
  const save = (reviewed: boolean) =>
    fs.writeFileSync(cursorPath, JSON.stringify({ offset, reviewedAt: reviewed ? Date.now() : cursor.reviewedAt }));
  if (!isSubstantive(segment)) return save(true);

  if (!pickBackend(agent)) return save(false);
  const started = Date.now();
  let backend: Backend;
  let extracted: Extracted[];
  try {
    const answer = await askAnyModel(agent, SYSTEM_PROMPT, SCHEMA, buildPrompt(repo, segment));
    backend = answer.backend;
    extracted = answer.result.ops ?? [];
  } catch (err) {
    // Leave the cursor where it was: this part of the transcript is retried next turn.
    log(repo, `extract ${agent}/${session} failed: ${(err as Error).message}`);
    throw err;
  }
  const ops = toOps(extracted, repo, session);
  if (ops.length) writeOps(repo, ops);
  save(true);
  log(repo, `extract ${agent}/${session} via ${backend}: ${lines.length} lines → ${extracted.length} candidates → ${ops.length} ops in ${Date.now() - started}ms`);
}
