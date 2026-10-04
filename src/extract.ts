import { execFileSync, spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describeEntry } from './core/format.js';
import { entryId, reduce } from './core/plan.js';
import { KINDS, type Kind } from './core/types.js';
import type { Repo } from './git.js';
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
- decision: project-wide choices others must follow (libraries, conventions, architecture), with rationale if stated.
- question: an open question that needs input from the team.

Rules:
- Only include things explicitly stated or actually done in the transcript. Never guess.
- Skip internal implementation details, debugging, exploration, and anything that only matters to this agent.
- When an item matches an existing plan entry, reuse its exact key and only emit it if something changed.
- Keys: kebab-case for tasks/decisions/questions (e.g. "auth-api"); natural names for contracts (e.g. "POST /api/login", "User").
- Prefer a few high-value entries. An empty list is a good answer when nothing qualifies.
- evidence: a short verbatim quote from the transcript supporting the entry.
- areas: repo-relative files or directories the entry concerns (for tasks: what this agent is changing).
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
        required: ['kind', 'key', 'title', 'status', 'spec', 'breaking', 'text', 'rationale', 'areas', 'confidence', 'evidence'],
        properties: {
          kind: { type: 'string', enum: KINDS.filter((k) => k !== 'goal') },
          key: { type: 'string' },
          title: nullable('string'),
          status: nullable('string', { enum: ['todo', 'doing', 'done', 'blocked', null] }),
          spec: nullable('string'),
          breaking: nullable('boolean'),
          text: nullable('string'),
          rationale: nullable('string'),
          areas: { type: ['array', 'null'], items: { type: 'string' } },
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
  areas?: string[] | null;
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
      code === 0 ? resolve(out) : reject(new Error(`${bin} exited ${code}: ${err.slice(0, 500)}`));
    });
    child.stdin.end(input);
  });
}

async function viaClaude(prompt: string): Promise<Extracted[]> {
  const out = await run(
    'claude',
    [
      '-p', '--model', process.env.HIVEMIND_CLAUDE_MODEL ?? 'haiku',
      '--settings', '{"disableAllHooks":true}', '--setting-sources', '', '--strict-mcp-config', '--tools', '',
      '--system-prompt', SYSTEM_PROMPT, '--output-format', 'json', '--json-schema', JSON.stringify(SCHEMA),
    ],
    prompt,
  );
  const parsed = JSON.parse(out);
  return parsed.structured_output?.ops ?? [];
}

async function viaCodex(prompt: string): Promise<Extracted[]> {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hivemind-'));
  try {
    const schema = path.join(dir, 'schema.json');
    const result = path.join(dir, 'out.json');
    fs.writeFileSync(schema, JSON.stringify(SCHEMA));
    const model = process.env.HIVEMIND_CODEX_MODEL ? ['-m', process.env.HIVEMIND_CODEX_MODEL] : [];
    await run('codex', ['exec', '--ephemeral', '--skip-git-repo-check', '--sandbox', 'read-only', ...model, '--output-schema', schema, '-o', result, '-'], `${SYSTEM_PROMPT}\n\n${prompt}`);
    return JSON.parse(fs.readFileSync(result, 'utf8')).ops ?? [];
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

export type Backend = 'claude' | 'codex';

export function pickBackend(agent: string): Backend | null {
  const forced = process.env.HIVEMIND_EXTRACTOR_BACKEND;
  if (forced === 'none') return null;
  if (forced === 'claude' || forced === 'codex') return forced;
  const order: Backend[] = agent === 'codex' ? ['codex', 'claude'] : ['claude', 'codex'];
  return order.find(has) ?? null;
}

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
        if (!e.text) continue;
        data = { text: e.text };
        break;
      default:
        continue;
    }
    if (Array.isArray(e.areas) && e.areas.length) data.areas = e.areas.filter((a) => typeof a === 'string').slice(0, 10);
    const existing = entries.get(entryId({ kind: e.kind, key: e.key }));
    // A task someone else owns: record progress without stealing ownership.
    if (e.kind === 'task' && existing?.data.owner && existing.data.owner !== repo.memberId) delete data.owner;
    const unchanged = existing?.status === 'open' && Object.entries(data).every(([k, v]) => JSON.stringify(existing.data[k]) === JSON.stringify(v));
    if (unchanged) continue;
    ops.push({ kind: e.kind, key: e.key.trim(), data, source: 'inferred', evidence: String(e.evidence ?? '').slice(0, 300), agent: agentId });
    if (ops.length >= MAX_OPS_PER_RUN) break;
  }
  return ops;
}

export function buildPrompt(repo: Repo, segment: string): string {
  const entries = [...reduce(readState(repo).ops).values()].filter((e) => e.status === 'open');
  const plan = entries.length ? entries.map((e) => `- ${e.kind} "${e.key}": ${describeEntry(e).slice(0, 200)}`).join('\n') : '(empty)';
  return `Current shared plan:\n${plan}\n\nThis agent's team member id: ${repo.memberId}\n\nNew transcript segment:\n${segment}`;
}

// --- orchestration: one extractor per session at a time, never re-reading old transcript ---

interface Cursor {
  offset: number;
}

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
  const save = () => fs.writeFileSync(cursorPath, JSON.stringify({ offset }));
  if (!isSubstantive(segment)) return save();

  const backend = pickBackend(agent);
  if (!backend) return save();
  const started = Date.now();
  const extracted = await (backend === 'claude' ? viaClaude : viaCodex)(buildPrompt(repo, segment));
  const ops = toOps(extracted, repo, session);
  if (ops.length) writeOps(repo, ops);
  save();
  log(repo, `extract ${agent}/${session} via ${backend}: ${lines.length} lines → ${extracted.length} candidates → ${ops.length} ops in ${Date.now() - started}ms`);
}
