import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { FETCH_REFSPEC, findRepo, git, type Repo } from '../src/git.js';
import { handleEvent } from '../src/hook.js';
import { rebuild, writeOps } from '../src/store.js';

// Two clones of one bare remote stand in for two teammates' machines.
let dir: string;
let alice: Repo;
let bob: Repo;

const sh = (cwd: string, ...args: string[]) => execFileSync('git', args, { cwd, stdio: 'pipe' });
const sync = (repo: Repo) => {
  git(repo.root, ['push', '-q', 'origin', `${repo.ownRef}:${repo.ownRef}`]);
};
const fetch = (repo: Repo) => {
  git(repo.root, ['fetch', '-q', 'origin', FETCH_REFSPEC]);
  rebuild(repo);
};

beforeAll(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hivemind-test-'));
  sh(dir, 'init', '-q', '--bare', 'remote.git');
  for (const name of ['alice', 'bob']) {
    sh(dir, 'clone', '-q', 'remote.git', name);
    sh(path.join(dir, name), 'config', 'user.email', `${name}@example.com`);
  }
  alice = findRepo(path.join(dir, 'alice'))!;
  bob = findRepo(path.join(dir, 'bob'))!;
  // Keep the test hermetic: the hook would otherwise spawn sync daemons.
  for (const r of [alice, bob]) {
    fs.mkdirSync(r.stateDir, { recursive: true });
    fs.writeFileSync(path.join(r.stateDir, 'daemon.pid'), String(process.pid));
  }
});

afterAll(() => fs.rmSync(dir, { recursive: true, force: true }));

describe('git sync', () => {
  it('gives each clone its own member id', () => {
    expect(alice.memberId).toMatch(/^alice-[0-9a-f]{6}$/);
    expect(bob.memberId).toMatch(/^bob-[0-9a-f]{6}$/);
  });

  it('propagates a contract change from one agent to another agent’s next tool call', () => {
    const bobCtx = handleEvent(bob, 'SessionStart', { session_id: 'b1' });
    expect(bobCtx).toContain('The shared plan is empty.');

    writeOps(alice, [{ kind: 'contract', key: 'User.id', data: { spec: 'int' } }]);
    sync(alice);
    fetch(bob);
    expect(handleEvent(bob, 'PostToolUse', { session_id: 'b1', tool_name: 'Bash' })).toContain('added contract: `User.id`: int');

    writeOps(alice, [{ kind: 'contract', key: 'User.id', data: { spec: 'uuid', breaking: true } }]);
    sync(alice);
    fetch(bob);
    const ctx = handleEvent(bob, 'PostToolUse', { session_id: 'b1', tool_name: 'Bash' });
    expect(ctx).toContain('⚠️ BREAKING');
    expect(ctx).toContain('(was: int)');

    // Already delivered: nothing new on the next call.
    expect(handleEvent(bob, 'PostToolUse', { session_id: 'b1', tool_name: 'Bash' })).toBe('');
  });

  it('does not echo an agent’s own MCP writes back to it', () => {
    handleEvent(alice, 'SessionStart', { session_id: 'a1' });
    const [mine] = writeOps(alice, [{ kind: 'decision', key: 'db', data: { text: 'SQLite' } }]);
    const ctx = handleEvent(alice, 'PostToolUse', {
      session_id: 'a1',
      tool_name: 'mcp__hivemind__decision_log',
      tool_response: [{ type: 'text', text: `Logged decision "db". [op:${mine.id}]` }],
    });
    expect(ctx).toBe('');
  });

  it('shows a second session on the same clone the first session’s writes', () => {
    handleEvent(alice, 'SessionStart', { session_id: 'a2' });
    writeOps(alice, [{ kind: 'task', key: 'signup', data: { title: 'Signup', status: 'doing' } }]);
    expect(handleEvent(alice, 'UserPromptSubmit', { session_id: 'a2' })).toContain('added task: [doing] Signup');
  });

  it('converges when both members write concurrently', () => {
    writeOps(alice, [{ kind: 'goal', key: 'g', data: { text: 'from alice' } }]);
    writeOps(bob, [{ kind: 'goal', key: 'g2', data: { text: 'from bob' } }]);
    sync(alice);
    sync(bob);
    fetch(alice);
    fetch(bob);
    const keys = (r: Repo) => rebuild(r).ops.map((o) => o.id).sort();
    expect(keys(alice)).toEqual(keys(bob));
  });

  it('never touches branches or the working tree', () => {
    expect(git(alice.root, ['status', '--porcelain'])).toBe('');
    expect(git(alice.root, ['branch', '-a'])).not.toContain('hivemind');
  });
});

describe('untrusted input', () => {
  it('ignores malformed ops on a teammate’s ref', () => {
    const blob = git(bob.root, ['hash-object', '-w', '--stdin'], '{"lamport":1}\nnot json\n{"id":"x","member":"m","key":"k","lamport":1,"ts":1,"kind":"nope","type":"upsert","data":{}}\n');
    const tree = git(bob.root, ['mktree'], `100644 blob ${blob}\tops.jsonl\n`);
    git(bob.root, ['update-ref', 'refs/hivemind-remote/mallory', git(bob.root, ['commit-tree', tree, '-m', 'x'])]);
    const before = rebuild(bob).ops.length;
    expect(rebuild(bob).ops.every((o) => o.member !== 'm')).toBe(true);
    expect(before).toBeGreaterThan(0);
  });
});
