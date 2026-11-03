import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { beforeEach, describe, expect, it } from 'vitest';
import { findRepo, git, logBlobs, type Repo } from '../src/git.js';
import { readState, rebuild, recoverOwnLog, writeOps } from '../src/store.js';

let dir: string;
let repo: Repo;
const op = (id: string, lamport: number, key = id) =>
  JSON.stringify({ id, member: repo.memberId, lamport, ts: 1, type: 'upsert', kind: 'note', key, data: { text: 'x'.repeat(900) }, source: 'explicit' });

/** Write a legacy (≤ 0.1.11) commit whose single ops.jsonl holds exactly `lines`. */
const legacyCommit = (lines: string[]) => {
  let prev: string | null = null;
  try {
    prev = git(repo.root, ['rev-parse', '-q', '--verify', repo.ownRef]);
  } catch {}
  const blob = git(repo.root, ['hash-object', '-w', '--stdin'], lines.join('\n') + '\n');
  const tree = git(repo.root, ['mktree'], `100644 blob ${blob}\tops.jsonl\n`);
  const commit = git(repo.root, ['commit-tree', tree, ...(prev ? ['-p', prev] : []), '-m', 'hivemind']);
  git(repo.root, ['update-ref', repo.ownRef, commit]);
};

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hivemind-storage-'));
  execFileSync('git', ['init', '-q', '--bare', 'o.git'], { cwd: dir });
  execFileSync('git', ['clone', '-q', 'o.git', 'me'], { cwd: dir, stdio: 'pipe' });
  repo = findRepo(path.join(dir, 'me'))!;
});

describe('log storage', () => {
  it('writes one small file per write instead of rewriting a growing file', () => {
    writeOps(repo, [{ kind: 'note', key: 'a', data: { text: 'one' } }]);
    writeOps(repo, [{ kind: 'note', key: 'b', data: { text: 'two' } }]);
    const head = git(repo.root, ['rev-parse', repo.ownRef]);
    expect(logBlobs(repo, head).map((f) => f.path)).toEqual(['log/0000/00000001.jsonl', 'log/0000/00000002.jsonl']);
    expect(readState(repo).ops.map((o) => o.key)).toEqual(['a', 'b']);
  });

  it('reads logs far beyond 1 MB (the old limit made them look empty)', () => {
    legacyCommit(Array.from({ length: 1500 }, (_, i) => op(`big${i}`, i + 1)));
    const state = rebuild(repo);
    expect(state.ops).toHaveLength(1500);
  });

  it('keeps the legacy file readable and leaves one update notice in it for older clients', () => {
    legacyCommit([op('old1', 1)]);
    writeOps(repo, [{ kind: 'note', key: 'new1', data: { text: 'n' } }]);
    writeOps(repo, [{ kind: 'note', key: 'new2', data: { text: 'n' } }]);
    const head = git(repo.root, ['rev-parse', repo.ownRef]);
    const legacy = git(repo.root, ['cat-file', 'blob', `${head}:ops.jsonl`]);
    expect(legacy.split('\n')).toHaveLength(2);
    expect(legacy).toContain('update-hivemind-log-format');
    expect(rebuild(repo).ops.map((o) => o.key).sort()).toEqual(['new1', 'new2', 'old1', 'update-hivemind-log-format']);
  });

  it('recovers entries an old version dropped from the head of the log', () => {
    // History of the old bug: the log grew, then a failed read restarted it with only new lines.
    legacyCommit([op('a', 1), op('b', 2)]);
    legacyCommit([op('a', 1), op('b', 2), op('c', 3)]);
    legacyCommit([op('d', 4)]);
    expect(recoverOwnLog(repo)).toBe(3);
    const head = git(repo.root, ['rev-parse', repo.ownRef]);
    const ids = new Set(rebuild(repo).ops.map((o) => o.id));
    for (const id of ['a', 'b', 'c', 'd']) expect(ids.has(id)).toBe(true);
    expect(logBlobs(repo, head).some((f) => f.path.startsWith('log/'))).toBe(true);
    // Once only.
    expect(recoverOwnLog(repo)).toBe(0);
  });

  it('compacts a long old-format history into one commit, keeping every entry', () => {
    for (let i = 1; i <= 60; i++) legacyCommit(Array.from({ length: i }, (_, j) => op(`c${j}`, j + 1)));
    recoverOwnLog(repo);
    expect(git(repo.root, ['rev-list', '--count', repo.ownRef])).toBe('1');
    const ids = new Set(rebuild(repo).ops.map((o) => o.id));
    for (let j = 0; j < 60; j++) expect(ids.has(`c${j}`)).toBe(true);
    const head = git(repo.root, ['rev-parse', repo.ownRef]);
    expect(git(repo.root, ['cat-file', 'blob', `${head}:ops.jsonl`])).toContain('update-hivemind-log-format');
  });

  it('pushes a compacted log over the old one, but never over something unexpected', async () => {
    const { pushOwnRef } = await import('../src/daemon.js');
    for (let i = 1; i <= 60; i++) legacyCommit([op(`p${i}`, i)]);
    expect(await pushOwnRef(repo)).toBe('pushed');
    recoverOwnLog(repo);
    expect(await pushOwnRef(repo)).toBe('pushed');
    const remote = git(repo.root, ['ls-remote', 'origin', repo.ownRef]).split('\t')[0];
    expect(remote).toBe(git(repo.root, ['rev-parse', repo.ownRef]));
  });
});
