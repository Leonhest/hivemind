import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

// Talks to the real built MCP server over stdio, in a throwaway repo.
let dir: string;
let client: Client;
const call = async (name: string, args: Record<string, unknown>) => {
  const res: any = await client.callTool({ name, arguments: args });
  return { text: res.content.map((c: any) => c.text).join('\n') as string, isError: Boolean(res.isError) };
};

beforeAll(async () => {
  execFileSync(process.execPath, ['build.mjs']);
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hivemind-mcp-'));
  execFileSync('git', ['init', '-q', '--bare', 'remote.git'], { cwd: dir });
  execFileSync('git', ['clone', '-q', 'remote.git', 'me'], { cwd: dir, stdio: 'pipe' });
  execFileSync('git', ['config', 'user.email', 'lead@example.com'], { cwd: path.join(dir, 'me') });
  // Keep it hermetic: a live pid in daemon.pid stops the server from spawning a sync daemon.
  fs.mkdirSync(path.join(dir, 'me', '.git', 'hivemind'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'me', '.git', 'hivemind', 'daemon.pid'), String(process.pid));
  client = new Client({ name: 'test', version: '0' });
  await client.connect(new StdioClientTransport({ command: process.execPath, args: [path.resolve('dist/hivemind.mjs'), 'mcp'], cwd: path.join(dir, 'me') }));
});

afterAll(async () => {
  await client?.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

describe('MCP tools', () => {
  it('exposes the planning tools', async () => {
    const names = (await client.listTools()).tools.map((t) => t.name);
    expect(names).toEqual(expect.arrayContaining(['plan_get', 'task_add', 'task_claim', 'task_update', 'contract_publish', 'decision_log', 'goal_set']));
  });

  it('task_add creates several unassigned tasks in one call', async () => {
    const res = await call('task_add', {
      tasks: [
        { key: 'api-auth', title: 'Auth API', description: 'POST /api/login + signup', areas: ['src/api/auth'] },
        { key: 'ui-login', title: 'Login page', depends_on: ['api-auth'] },
      ],
    });
    expect(res.text).toMatch(/Added 2 tasks: api-auth, ui-login\..*\[op:\w+\] \[op:\w+\]/);
    const plan = (await call('plan_get', {})).text;
    expect(plan).toContain('[todo] Auth API `api-auth` (unassigned) — POST /api/login + signup');
    expect(plan).toContain('[todo] Login page `ui-login` (unassigned) (after: api-auth)');
  });

  it('task_claim picks up a planned task by key and keeps its title', async () => {
    const res = await call('task_claim', { key: 'ui-login' });
    expect(res.isError).toBe(false);
    expect((await call('plan_get', { kind: 'task' })).text).toMatch(/\[doing\] Login page `ui-login` @lead-\w{6}/);
  });

  it('task_claim without a title on an unknown task explains what to do', async () => {
    const res = await call('task_claim', { key: 'nope' });
    expect(res.isError).toBe(true);
    expect(res.text).toContain('pass a title');
  });
});
