import { randomBytes } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { compareOps } from './core/plan.js';
import { redact, redactDeep } from './core/redact.js';
import { KINDS, type Kind, type Op, type State, type StoredOp } from './core/types.js';
import { appendToOwnRef, compactOwnLog, isLegacyLog, logBlobs, lostOwnOps, readBlobs, readRefs, tryGit, type Repo } from './git.js';

const EMPTY: State = { seq: 0, ops: [], refs: {} };

const statePath = (repo: Repo) => path.join(repo.stateDir, 'state.json');

function writeJsonAtomic(file: string, value: unknown): void {
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(value));
  fs.renameSync(tmp, file);
}

function readJson<T>(file: string, fallback: T): T {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8')) as T;
  } catch {
    return fallback;
  }
}

/** Cross-process mutex via mkdir. Stale locks (crashed holder) expire after 10s. */
export function withLock<T>(repo: Repo, fn: () => T): T {
  fs.mkdirSync(repo.stateDir, { recursive: true });
  const lock = path.join(repo.stateDir, 'lock');
  const deadline = Date.now() + 5_000;
  for (;;) {
    try {
      fs.mkdirSync(lock);
      break;
    } catch {
      try {
        if (Date.now() - fs.statSync(lock).mtimeMs > 10_000) fs.rmSync(lock, { recursive: true, force: true });
      } catch {}
      if (Date.now() > deadline) throw new Error('hivemind: timed out waiting for lock');
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 20);
    }
  }
  try {
    return fn();
  } finally {
    fs.rmSync(lock, { recursive: true, force: true });
  }
}

export function readState(repo: Repo): State {
  return readJson(statePath(repo), EMPTY);
}

/** Ops come from other people's refs: drop anything malformed rather than trusting it. */
function isOp(v: any): v is Op {
  return (
    v && typeof v.id === 'string' && typeof v.member === 'string' && typeof v.key === 'string' &&
    Number.isFinite(v.lamport) && Number.isFinite(v.ts) && KINDS.includes(v.kind) &&
    (v.type === 'upsert' || v.type === 'close') && typeof v.data === 'object' && v.data !== null
  );
}

function parseOps(text: string): Op[] {
  const ops: Op[] = [];
  for (const line of text.split('\n')) {
    if (!line.trim()) continue;
    try {
      const v = JSON.parse(line);
      if (isOp(v)) ops.push(v);
    } catch {}
  }
  return ops;
}

/** Merge every member's ref into state.json. Cheap no-op when no ref moved. */
export function rebuild(repo: Repo): State {
  return withLock(repo, () => {
    const state = readState(repo);
    const refs = readRefs(repo);
    if (JSON.stringify(refs) === JSON.stringify(state.refs)) return state;

    const known = new Set(state.ops.map((o) => o.id));
    const read = new Set(state.blobs ?? []);
    const fresh = new Map<string, Op>();
    // Only blobs not seen before: with one file per write, a ref that moved adds a few small files.
    const unread = new Set<string>();
    for (const commit of new Set(Object.values(refs))) for (const f of logBlobs(repo, commit)) if (!read.has(f.sha)) unread.add(f.sha);
    for (const [sha, text] of readBlobs(repo, [...unread])) {
      for (const op of parseOps(text)) if (!known.has(op.id)) fresh.set(op.id, op);
      read.add(sha);
    }
    let seq = state.seq;
    const added: StoredOp[] = [...fresh.values()].sort(compareOps).map((op) => ({ ...op, seq: ++seq }));
    const next: State = { seq, ops: [...state.ops, ...added], refs, blobs: [...read] };
    writeJsonAtomic(statePath(repo), next);
    return next;
  });
}

/**
 * One-time repair for logs written by hivemind ≤ 0.1.11, which could silently drop older entries
 * once a log passed 1 MB. Restores every entry from the log's history that the head lacks.
 * Returns how many were restored.
 */
export function recoverOwnLog(repo: Repo): number {
  const recovered = tryGit(repo.root, ['config', 'hivemind.logVersion']) === '2';
  const compacted = tryGit(repo.root, ['config', 'hivemind.compacted']) === 'true';
  if (recovered && compacted) return 0;
  const restored = withLock(repo, () => {
    let lost: string[] = [];
    if (!recovered) {
      lost = lostOwnOps(repo);
      if (lost.length) appendToOwnRef(repo, lost);
    }
    // A long old-format history is too big to push; keep the entries, drop the copies. Once.
    const commits = Number(tryGit(repo.root, ['rev-list', '--count', repo.ownRef]) ?? 0);
    if (!compacted && commits > 50) compactOwnLog(repo, upgradeNotice(repo, readState(repo).ops.reduce((m, o) => Math.max(m, o.lamport), 0) + 1));
    return lost.length;
  });
  tryGit(repo.root, ['config', 'hivemind.logVersion', '2']);
  tryGit(repo.root, ['config', '--bool', 'hivemind.compacted', 'true']);
  rebuild(repo);
  return restored;
}

/** The task older clients see in the legacy file, telling them to update. */
function upgradeNotice(repo: Repo, lamport: number): string {
  return JSON.stringify({
    id: `${Date.now().toString(36)}upgrade`,
    member: repo.memberId,
    lamport,
    ts: Date.now(),
    type: 'upsert',
    kind: 'task',
    key: 'update-hivemind-log-format',
    data: { title: `Update hivemind (npx hivemind-agents@latest install): ${repo.memberId} now writes the plan in a format older versions can't read`, status: 'todo' },
    source: 'explicit',
  });
}

export interface NewOp {
  type?: 'upsert' | 'close';
  kind: Kind;
  key: string;
  data?: Record<string, unknown>;
  source?: 'explicit' | 'inferred';
  evidence?: string;
  agent?: string;
}

/** Record ops as this member, then refresh the local cache so other sessions on this clone see them immediately. */
export function writeOps(repo: Repo, inputs: NewOp[]): Op[] {
  const written = withLock(repo, () => {
    const state = readState(repo);
    let lamport = state.ops.reduce((m, o) => Math.max(m, o.lamport), 0);
    const ops: Op[] = inputs.map((i) => ({
      id: `${Date.now().toString(36)}${randomBytes(4).toString('hex')}`,
      member: repo.memberId,
      ...(i.agent ? { agent: i.agent } : {}),
      lamport: ++lamport,
      ts: Date.now(),
      type: i.type ?? 'upsert',
      kind: i.kind,
      key: redact(i.key),
      data: redactDeep(i.data ?? {}),
      source: i.source ?? 'explicit',
      ...(i.evidence ? { evidence: redact(i.evidence) } : {}),
    }));
    // First write in the new log layout: leave a note in the legacy file, which is all that
    // teammates on hivemind ≤ 0.1.11 can read, so they know to update.
    const legacy = isLegacyLog(repo) ? [upgradeNotice(repo, ++lamport)] : [];
    appendToOwnRef(repo, ops.map((o) => JSON.stringify(o)), legacy);
    return ops;
  });
  rebuild(repo);
  return written;
}

// --- per-agent-session bookkeeping ---

export interface Session {
  lastSeq: number;
  /** Ops this session wrote itself; never echoed back to it as "teammate updates". */
  ownOps: string[];
  touched: string[];
  startedAt: number;
  /** The "claim a task first" reminder was shown. */
  nudgedClaim?: boolean;
  turnStartedAt?: number;
  /** Files edited during the current turn. */
  turnEdits?: string[];
  /** A finished turn that changed files, still to be checked for a plan update. */
  pendingCheck?: { since: number; files: string[]; at: number };
}

const sessionPath = (repo: Repo, id: string) => path.join(repo.stateDir, 'sessions', `${id.replace(/[^\w-]/g, '_')}.json`);

export function loadSession(repo: Repo, id: string): Session | null {
  return readJson<Session | null>(sessionPath(repo, id), null);
}

export function saveSession(repo: Repo, id: string, s: Session): void {
  fs.mkdirSync(path.dirname(sessionPath(repo, id)), { recursive: true });
  s.ownOps = s.ownOps.slice(-500);
  s.touched = s.touched.slice(-200);
  writeJsonAtomic(sessionPath(repo, id), s);
}

/** Marks agent activity; the daemon polls faster while recent and exits when stale. */
export function touchActivity(repo: Repo): void {
  fs.mkdirSync(repo.stateDir, { recursive: true });
  const f = path.join(repo.stateDir, 'activity');
  const now = new Date();
  try {
    fs.utimesSync(f, now, now);
  } catch {
    fs.writeFileSync(f, '');
  }
}

export function lastActivity(repo: Repo): number {
  try {
    return fs.statSync(path.join(repo.stateDir, 'activity')).mtimeMs;
  } catch {
    return 0;
  }
}
