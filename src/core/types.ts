export type Kind = 'goal' | 'task' | 'contract' | 'decision' | 'question';
export const KINDS: Kind[] = ['goal', 'task', 'contract', 'decision', 'question'];

/** One line in a member's ops.jsonl. Append-only. */
export interface Op {
  id: string;
  member: string;
  /** Agent session that wrote it, when known. */
  agent?: string;
  lamport: number;
  ts: number;
  type: 'upsert' | 'close';
  kind: Kind;
  key: string;
  data: Record<string, unknown>;
  source: 'explicit' | 'inferred';
  evidence?: string;
}

/** An op as seen by this clone, with a local, monotonic sequence number. */
export interface StoredOp extends Op {
  seq: number;
}

export interface Entry {
  kind: Kind;
  key: string;
  data: Record<string, unknown>;
  status: 'open' | 'closed';
  createdBy: string;
  updatedBy: string;
  updatedAt: number;
  revisions: number;
}

export interface State {
  /** Highest seq assigned so far. */
  seq: number;
  ops: StoredOp[];
  /** refname -> commit sha, used to skip rebuilds when nothing changed. */
  refs: Record<string, string>;
}
