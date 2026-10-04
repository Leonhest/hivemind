import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const CLAUDE_EVENTS = ['SessionStart', 'UserPromptSubmit', 'PostToolUse', 'Stop'] as const;
const MARKER = 'hivemind.mjs';

const claudeDir = () => process.env.CLAUDE_CONFIG_DIR ?? path.join(os.homedir(), '.claude');
export const hivemindHome = () => process.env.HIVEMIND_HOME ?? path.join(os.homedir(), '.hivemind');

type HookGroup = { matcher?: string; hooks: { type: string; command: string; timeout?: number }[] };
type Settings = { hooks?: Record<string, HookGroup[]>; permissions?: { allow?: string[] }; [k: string]: unknown };

function readSettings(file: string): Settings {
  if (!fs.existsSync(file)) return {};
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}

function withoutOurHooks(settings: Settings): Settings {
  const hooks = { ...settings.hooks };
  for (const [event, groups] of Object.entries(hooks)) {
    const kept = groups
      .map((g) => ({ ...g, hooks: g.hooks.filter((h) => !h.command?.includes(MARKER)) }))
      .filter((g) => g.hooks.length > 0);
    if (kept.length) hooks[event] = kept;
    else delete hooks[event];
  }
  const allow = settings.permissions?.allow?.filter((p) => p !== 'mcp__hivemind');
  return {
    ...settings,
    hooks,
    ...(settings.permissions ? { permissions: { ...settings.permissions, allow } } : {}),
  };
}

function writeSettings(file: string, settings: Settings): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  if (fs.existsSync(file)) fs.copyFileSync(file, `${file}.hivemind-backup`);
  fs.writeFileSync(file, JSON.stringify(settings, null, 2) + '\n');
}

function claude(args: string[]): boolean {
  try {
    execFileSync('claude', args, { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}

export function install(): void {
  // Copy the single-file bundle somewhere stable: npx caches are temporary.
  const bin = path.join(hivemindHome(), 'bin', MARKER);
  fs.mkdirSync(path.dirname(bin), { recursive: true });
  if (path.resolve(process.argv[1]) !== bin) fs.copyFileSync(process.argv[1], bin);
  const cmd = `"${process.execPath}" "${bin}"`;

  const settingsFile = path.join(claudeDir(), 'settings.json');
  const settings = withoutOurHooks(readSettings(settingsFile));
  for (const event of CLAUDE_EVENTS) {
    settings.hooks![event] = [...(settings.hooks![event] ?? []), { hooks: [{ type: 'command', command: `${cmd} hook claude ${event}`, timeout: 5 }] }];
  }
  settings.permissions = { ...settings.permissions, allow: [...(settings.permissions?.allow ?? []), 'mcp__hivemind'] };
  writeSettings(settingsFile, settings);

  claude(['mcp', 'remove', '--scope', 'user', 'hivemind']);
  const mcpOk = claude(['mcp', 'add', '--scope', 'user', 'hivemind', '--', process.execPath, bin, 'mcp']);

  console.log(`hivemind installed.
  • Claude Code hooks → ${settingsFile}
  • MCP server        → ${mcpOk ? 'registered (user scope)' : `NOT registered: run  claude mcp add --scope user hivemind -- ${cmd} mcp`}

Nothing else to do. Every Claude Code session inside a git repo with an "origin" remote
now shares a live plan with everyone else on that repo who has hivemind installed.`);
}

export function uninstall(): void {
  const settingsFile = path.join(claudeDir(), 'settings.json');
  if (fs.existsSync(settingsFile)) writeSettings(settingsFile, withoutOurHooks(readSettings(settingsFile)));
  claude(['mcp', 'remove', '--scope', 'user', 'hivemind']);
  fs.rmSync(path.join(hivemindHome(), 'bin'), { recursive: true, force: true });
  console.log('hivemind uninstalled. Shared plan data in your repos (refs/hivemind/*) was left untouched.');
}
