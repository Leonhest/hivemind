import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { beforeEach, describe, expect, it } from 'vitest';
import { findRepo, type Repo } from '../src/git.js';
import { handleEvent } from '../src/hook.js';
import { writeOps } from '../src/store.js';

let repo: Repo;
let n = 0;
const sid = () => `s${++n}`;
const ev = (event: any, sessionId: string, extra: object = {}) => handleEvent(repo, { event, sessionId, ...extra });
const edit = (sessionId: string, file = 'src/app.ts') => {
  const pre = ev('PreToolUse', sessionId, { toolName: 'Edit', toolInput: { file_path: file } });
  ev('PostToolUse', sessionId, { toolName: 'Edit', toolInput: { file_path: file } });
  return pre;
};

beforeEach(() => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hivemind-nudge-'));
  execFileSync('git', ['init', '-q', '--bare', 'remote.git'], { cwd: dir });
  execFileSync('git', ['clone', '-q', 'remote.git', 'me'], { cwd: dir, stdio: 'pipe' });
  execFileSync('git', ['config', 'user.email', 'me@example.com'], { cwd: path.join(dir, 'me') });
  repo = findRepo(path.join(dir, 'me'))!;
  fs.mkdirSync(repo.stateDir, { recursive: true });
  fs.writeFileSync(path.join(repo.stateDir, 'daemon.pid'), String(process.pid));
});

describe('claim nudge (before the first edit)', () => {
  it('fires once, before the first file edit, listing unclaimed tasks', () => {
    writeOps(repo, [{ kind: 'task', key: 'signup', data: { title: 'Signup form', status: 'todo' } }]);
    const s = sid();
    ev('SessionStart', s);
    ev('UserPromptSubmit', s);
    expect(ev('PreToolUse', s, { toolName: 'Read', toolInput: { file_path: 'a' } })).toBe('');
    const first = edit(s);
    expect(first).toContain("You're about to change files");
    expect(first).toContain('`signup` (Signup form)');
    expect(edit(s)).toBe('');
  });

  it('stays quiet when this member already has a task in progress', () => {
    writeOps(repo, [{ kind: 'task', key: 'auth', data: { title: 'Auth', status: 'doing', owner: repo.memberId } }]);
    const s = sid();
    ev('SessionStart', s);
    expect(edit(s)).toBe('');
  });

  it('stays quiet once the session claimed a task through the MCP tool', () => {
    const s = sid();
    ev('SessionStart', s);
    const [op] = writeOps(repo, [{ kind: 'task', key: 'ui', data: { title: 'UI', status: 'doing', owner: 'someone-else' } }]);
    ev('PostToolUse', s, { toolName: 'mcp__hivemind__task_claim', toolResponse: `Claimed task "ui". [op:${op.id}]` });
    expect(edit(s)).toBe('');
  });
});

describe('update nudge (after a turn that changed files)', () => {
  const turn = (s: string) => {
    ev('UserPromptSubmit', s);
    edit(s, 'src/api/login.ts');
    ev('Stop', s);
  };

  it('fires on the next prompt when nothing recorded the turn', () => {
    const s = sid();
    ev('SessionStart', s);
    turn(s);
    const next = ev('UserPromptSubmit', s);
    expect(next).toContain('Your last turn changed src/api/login.ts');
    expect(ev('UserPromptSubmit', s)).not.toContain('Your last turn');
  });

  it('stays quiet when the agent published something during the turn', () => {
    const s = sid();
    ev('SessionStart', s);
    ev('UserPromptSubmit', s);
    edit(s);
    writeOps(repo, [{ kind: 'task', key: 'x', data: { status: 'done' }, agent: s }]);
    ev('Stop', s);
    expect(ev('UserPromptSubmit', s)).not.toContain('Your last turn');
  });

  it('stays quiet when the extractor reviewed the turn, even if it found nothing to record', () => {
    const s = sid();
    ev('SessionStart', s);
    turn(s);
    fs.writeFileSync(path.join(repo.stateDir, 'sessions', `${s}.extract.json`), JSON.stringify({ offset: 10, reviewedAt: Date.now() + 1 }));
    expect(ev('UserPromptSubmit', s)).not.toContain('Your last turn');
  });

  it('waits while the extractor is still running', () => {
    const s = sid();
    ev('SessionStart', s);
    turn(s);
    fs.mkdirSync(path.join(repo.stateDir, 'sessions', `${s}.extract.lock`));
    expect(ev('UserPromptSubmit', s)).not.toContain('Your last turn');
    fs.rmSync(path.join(repo.stateDir, 'sessions', `${s}.extract.lock`), { recursive: true });
    expect(ev('UserPromptSubmit', s)).toContain('Your last turn');
  });

  it('ignores turns without file edits', () => {
    const s = sid();
    ev('SessionStart', s);
    ev('UserPromptSubmit', s);
    ev('PostToolUse', s, { toolName: 'Bash', toolInput: { command: 'ls' } });
    ev('Stop', s);
    expect(ev('UserPromptSubmit', s)).toBe('');
  });
});
