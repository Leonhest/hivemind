import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { toOps, type Extracted } from '../src/extract.js';
import { findRepo, type Repo } from '../src/git.js';
import { ADAPTERS } from '../src/hook.js';
import { writeOps } from '../src/store.js';
import { isSubstantive, renderTranscript } from '../src/transcript.js';

const j = (v: unknown) => JSON.stringify(v);

describe('renderTranscript', () => {
  it('renders Claude Code transcripts, skipping injected context and hivemind tools', () => {
    const text = renderTranscript([
      j({ type: 'user', message: { content: 'build the auth API' } }),
      j({ type: 'user', message: { content: '[hivemind] Teammates updated…' } }),
      j({ type: 'assistant', message: { content: [{ type: 'text', text: 'Switching User.id to uuid.' }, { type: 'tool_use', id: 't1', name: 'Edit', input: { file_path: 'src/db.ts', old_string: 'id: int', new_string: 'id: uuid' } }] } }),
      j({ type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 't1', content: 'ok' }] } }),
      j({ type: 'assistant', message: { content: [{ type: 'tool_use', id: 't2', name: 'mcp__hivemind__plan_get', input: {} }] } }),
      j({ type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 't2', content: 'the plan' }] } }),
      j({ type: 'assistant', isSidechain: true, message: { content: [{ type: 'text', text: 'subagent chatter' }] } }),
      'not json',
    ]);
    expect(text).toBe('USER: build the auth API\nASSISTANT: Switching User.id to uuid.\nTOOL Edit: src/db.ts\n- id: int\n+ id: uuid\nRESULT: ok');
  });

  it('renders Codex rollouts', () => {
    const text = renderTranscript([
      j({ type: 'response_item', payload: { type: 'message', role: 'developer', content: [{ type: 'input_text', text: 'sys' }] } }),
      j({ type: 'response_item', payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'add signup' }] } }),
      j({ type: 'response_item', payload: { type: 'function_call', name: 'shell', call_id: 'c1', arguments: '{"cmd":"ls"}' } }),
      j({ type: 'response_item', payload: { type: 'function_call_output', call_id: 'c1', output: 'src' } }),
      j({ type: 'event_msg', payload: { type: 'token_count' } }),
    ]);
    expect(text).toBe('USER: add signup\nTOOL shell: {"cmd":"ls"}\nRESULT: src');
  });

  it('keeps the most recent part when too long', () => {
    const lines = Array.from({ length: 100 }, (_, i) => j({ type: 'user', message: { content: `msg ${i} ${'x'.repeat(50)}` } }));
    const text = renderTranscript(lines, 500);
    expect(text.length).toBeLessThan(510);
    expect(text).toContain('msg 99');
  });

  it('only treats requests and changes as worth extracting', () => {
    expect(isSubstantive('TOOL Read: {"file_path":"a"}\nRESULT: …')).toBe(false);
    expect(isSubstantive('USER: add signup')).toBe(true);
    expect(isSubstantive('TOOL Write: src/a.ts')).toBe(true);
  });
});

describe('toOps', () => {
  let dir: string;
  let repo: Repo;
  beforeAll(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hivemind-extract-'));
    execFileSync('git', ['init', '-q', '--bare', 'remote.git'], { cwd: dir });
    execFileSync('git', ['clone', '-q', 'remote.git', 'me'], { cwd: dir, stdio: 'pipe' });
    execFileSync('git', ['config', 'user.email', 'me@example.com'], { cwd: path.join(dir, 'me') });
    repo = findRepo(path.join(dir, 'me'))!;
  });
  afterAll(() => fs.rmSync(dir, { recursive: true, force: true }));

  const ex = (e: Partial<Extracted>): Extracted => ({ kind: 'decision', key: 'k', confidence: 0.9, evidence: 'q', ...e }) as Extracted;

  it('drops low-confidence and incomplete candidates, tags the rest as inferred', () => {
    const ops = toOps(
      [
        ex({ key: 'orm', text: 'Use Drizzle' }),
        ex({ key: 'maybe', text: 'Perhaps Redis', confidence: 0.4 }),
        ex({ kind: 'contract', key: 'User', spec: null }),
        ex({ kind: 'task', key: 'auth', title: 'Auth API', status: 'doing', areas: ['src/api'] }),
      ],
      repo,
      's1',
    );
    expect(ops.map((o) => o.key)).toEqual(['orm', 'auth']);
    expect(ops[1]).toMatchObject({ source: 'inferred', agent: 's1', data: { owner: repo.memberId, areas: ['src/api'] } });
  });

  it('skips unchanged entries and never steals a teammate’s task', () => {
    writeOps(repo, [
      { kind: 'decision', key: 'orm', data: { text: 'Use Drizzle' } },
      { kind: 'task', key: 'ui', data: { title: 'UI', status: 'doing', owner: 'bob-123456' } },
    ]);
    const ops = toOps([ex({ key: 'orm', text: 'Use Drizzle' }), ex({ kind: 'task', key: 'ui', title: 'UI', status: 'done' })], repo, 's1');
    expect(ops).toHaveLength(1);
    expect(ops[0].data).toEqual({ title: 'UI', status: 'done' });
  });
});

describe('adapters', () => {
  it('Cursor: maps events and fields, always answers with JSON', () => {
    const input = ADAPTERS.cursor.parse('postToolUse', {
      hook_event_name: 'postToolUse',
      conversation_id: 'c1',
      workspace_roots: ['/w'],
      tool_name: 'Write',
      tool_input: { file_path: '/w/a.ts' },
      tool_output: '{}',
    });
    expect(input).toMatchObject({ event: 'PostToolUse', sessionId: 'c1', cwd: '/w', toolName: 'Write' });
    expect(ADAPTERS.cursor.render('PostToolUse', 'hi')).toBe('{"additional_context":"hi"}');
    expect(ADAPTERS.cursor.render('Stop', '')).toBe('{}');
    expect(ADAPTERS.cursor.parse('beforeReadFile', {})).toBeNull();
  });

  it('Codex: Claude-style payloads, JSON on Stop', () => {
    const input = ADAPTERS.codex.parse('PostToolUse', { hook_event_name: 'PostToolUse', session_id: 's', cwd: '/r', tool_name: 'shell' });
    expect(input).toMatchObject({ event: 'PostToolUse', sessionId: 's', cwd: '/r' });
    expect(ADAPTERS.codex.render('Stop', '')).toBe('{}');
    expect(JSON.parse(ADAPTERS.codex.render('SessionStart', 'ctx'))).toEqual({ hookSpecificOutput: { hookEventName: 'SessionStart', additionalContext: 'ctx' } });
    expect(ADAPTERS.claude.render('Stop', '')).toBe('');
  });
});
