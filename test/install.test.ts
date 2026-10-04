import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

// Runs the built CLI against throwaway config dirs (Cursor only: pure file edits, no external CLIs).
const cli = path.resolve('dist/hivemind.mjs');
let dir: string;
let env: NodeJS.ProcessEnv;
const run = (...args: string[]) => execFileSync(process.execPath, [cli, ...args], { env, encoding: 'utf8' });
const read = (f: string) => JSON.parse(fs.readFileSync(path.join(dir, 'cursor', f), 'utf8'));

beforeAll(() => {
  execFileSync(process.execPath, ['build.mjs']);
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hivemind-install-'));
  fs.mkdirSync(path.join(dir, 'cursor'));
  fs.writeFileSync(path.join(dir, 'cursor', 'hooks.json'), JSON.stringify({ version: 1, hooks: { afterFileEdit: [{ command: './fmt.sh' }] } }));
  fs.writeFileSync(path.join(dir, 'cursor', 'mcp.json'), JSON.stringify({ mcpServers: { github: { command: 'gh-mcp' } } }));
  fs.mkdirSync(path.join(dir, 'linkbin'));
  // Hermetic: only a temp dir is eligible for the PATH symlink, and no shell profile is touched.
  env = {
    ...process.env,
    CURSOR_CONFIG_DIR: path.join(dir, 'cursor'),
    HIVEMIND_HOME: path.join(dir, 'hm'),
    HIVEMIND_LINK_DIRS: path.join(dir, 'linkbin'),
    PATH: `${path.join(dir, 'linkbin')}${path.delimiter}${process.env.PATH}`,
    SHELL: '/bin/sh',
  };
});
afterAll(() => fs.rmSync(dir, { recursive: true, force: true }));

describe('install --only=cursor', () => {
  it('adds hooks and MCP idempotently, keeping existing entries', () => {
    run('install', '--only=cursor');
    run('install', '--only=cursor');
    const hooks = read('hooks.json').hooks;
    expect(hooks.afterFileEdit).toEqual([{ command: './fmt.sh' }]);
    for (const e of ['sessionStart', 'postToolUse', 'stop']) {
      expect(hooks[e]).toHaveLength(1);
      expect(hooks[e][0].command).toBe(`"${path.join(dir, 'hm', 'bin', 'hivemind')}" hook cursor ${e}`);
    }
    const servers = read('mcp.json').mcpServers;
    expect(Object.keys(servers)).toEqual(['github', 'hivemind']);
    expect(servers.hivemind.env).toEqual({ HIVEMIND_CWD: '${workspaceFolder}' });
  });

  it('installs a working launcher and puts `hivemind` on PATH', () => {
    const out = execFileSync(path.join(dir, 'hm', 'bin', 'hivemind'), ['help'], { encoding: 'utf8' });
    expect(out).toContain('shared, live plan');
    const link = path.join(dir, 'linkbin', 'hivemind');
    expect(fs.readlinkSync(link)).toBe(path.join(dir, 'hm', 'bin', 'hivemind'));
    expect(execFileSync('hivemind', ['help'], { env, encoding: 'utf8' })).toContain('shared, live plan');
  });

  it('uninstall restores the original entries', () => {
    run('uninstall', '--only=cursor');
    expect(read('hooks.json').hooks).toEqual({ afterFileEdit: [{ command: './fmt.sh' }] });
    expect(Object.keys(read('mcp.json').mcpServers)).toEqual(['github']);
  });

  it('full uninstall removes the PATH symlink', () => {
    run('uninstall');
    expect(fs.existsSync(path.join(dir, 'linkbin', 'hivemind'))).toBe(false);
  });
});

describe('PATH fallback', () => {
  it('adds one marked line to the shell profile when no PATH dir is writable, and removes it on uninstall', () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'hivemind-home-'));
    fs.writeFileSync(path.join(home, '.zshrc'), 'alias ll="ls -l"\n');
    const e = { ...env, HOME: home, SHELL: '/bin/zsh', HIVEMIND_LINK_DIRS: path.join(home, 'not-on-path'), CURSOR_CONFIG_DIR: path.join(home, 'cursor') };
    fs.mkdirSync(e.CURSOR_CONFIG_DIR);
    execFileSync(process.execPath, [cli, 'install', '--only=cursor'], { env: e });
    execFileSync(process.execPath, [cli, 'install', '--only=cursor'], { env: e });
    const rc = fs.readFileSync(path.join(home, '.zshrc'), 'utf8');
    expect(rc.match(/added by hivemind/g)).toHaveLength(1);
    expect(rc).toContain(`export PATH="${path.join(dir, 'hm', 'bin')}:$PATH"`);
    execFileSync(process.execPath, [cli, 'uninstall'], { env: e });
    expect(fs.readFileSync(path.join(home, '.zshrc'), 'utf8')).toBe('alias ll="ls -l"\n');
    fs.rmSync(home, { recursive: true, force: true });
  });
});
