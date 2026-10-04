import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export const hivemindHome = () => process.env.HIVEMIND_HOME ?? path.join(os.homedir(), '.hivemind');
const binDir = () => path.join(hivemindHome(), 'bin');
/** Stable launcher every agent config points at; its contents may change, its path never does. */
export const launcherPath = () => path.join(binDir(), 'hivemind');

/** Prefer the PATH entry (e.g. /opt/homebrew/bin/node) over process.execPath, which is version-specific. */
function stableNode(): string {
  try {
    const found = execFileSync('sh', ['-c', 'command -v node'], { encoding: 'utf8' }).trim();
    if (found) return found;
  } catch {}
  return process.execPath;
}

function writeLauncher(): void {
  fs.mkdirSync(binDir(), { recursive: true });
  const bundle = path.join(binDir(), 'hivemind.mjs');
  if (path.resolve(process.argv[1]) !== bundle) fs.copyFileSync(process.argv[1], bundle);
  // Absolute bundle path: the launcher is also reached through a symlink on PATH.
  fs.writeFileSync(
    launcherPath(),
    `#!/bin/sh
# hivemind launcher: keeps agent configs stable across node and hivemind upgrades.
NODE="${stableNode()}"
[ -x "$NODE" ] || NODE="$(command -v node)"
exec "$NODE" "${bundle}" "$@"
`,
    { mode: 0o755 },
  );
}

// --- putting `hivemind` on the user's PATH ---

const RC_MARKER = '# added by hivemind';

/** Directories we're willing to drop a symlink into, if they're already on PATH. */
function linkCandidates(): string[] {
  if (process.env.HIVEMIND_LINK_DIRS) return process.env.HIVEMIND_LINK_DIRS.split(':');
  const home = os.homedir();
  return [path.join(home, '.local', 'bin'), path.join(home, 'bin'), '/opt/homebrew/bin', '/usr/local/bin'];
}

const isOurLink = (file: string) => {
  try {
    return fs.lstatSync(file).isSymbolicLink() && fs.readlinkSync(file) === launcherPath();
  } catch {
    return false;
  }
};

function shellRcFiles(): string[] {
  const home = os.homedir();
  const shell = path.basename(process.env.SHELL ?? '');
  if (shell === 'zsh') return [path.join(home, '.zshrc')];
  if (shell === 'bash') return [path.join(home, '.bashrc'), path.join(home, '.bash_profile')].filter((f, i) => i === 0 || fs.existsSync(f));
  return [];
}

/** Returns how `hivemind` was made reachable, or null if it couldn't be. */
function linkOntoPath(): string | null {
  const onPath = new Set((process.env.PATH ?? '').split(path.delimiter).map((d) => path.resolve(d)));
  if (onPath.has(path.resolve(binDir()))) return 'already on PATH';
  for (const dir of linkCandidates()) {
    if (!onPath.has(path.resolve(dir))) continue;
    const link = path.join(dir, 'hivemind');
    if (isOurLink(link)) return link;
    if (fs.existsSync(link)) continue; // someone else's `hivemind`; leave it alone
    try {
      fs.accessSync(dir, fs.constants.W_OK);
      fs.symlinkSync(launcherPath(), link);
      return link;
    } catch {}
  }
  // No writable PATH dir: add ours to the shell profile, once, with a marker for uninstall.
  const rcs = shellRcFiles();
  if (!rcs.length) return null;
  const line = `export PATH="${binDir()}:$PATH" ${RC_MARKER}`;
  for (const rc of rcs) {
    const text = fs.existsSync(rc) ? fs.readFileSync(rc, 'utf8') : '';
    if (!text.includes(RC_MARKER)) fs.appendFileSync(rc, `${text && !text.endsWith('\n') ? '\n' : ''}${line}\n`);
  }
  return `${rcs.map((r) => r.replace(os.homedir(), '~')).join(', ')} (open a new terminal)`;
}

function unlinkFromPath(): void {
  for (const dir of linkCandidates()) {
    const link = path.join(dir, 'hivemind');
    if (isOurLink(link)) fs.rmSync(link, { force: true });
  }
  for (const rc of shellRcFiles()) {
    if (!fs.existsSync(rc)) continue;
    const text = fs.readFileSync(rc, 'utf8');
    if (text.includes(RC_MARKER)) fs.writeFileSync(rc, text.split('\n').filter((l) => !l.includes(RC_MARKER)).join('\n'));
  }
}
const claudeDir = () => process.env.CLAUDE_CONFIG_DIR ?? path.join(os.homedir(), '.claude');
const codexDir = () => process.env.CODEX_HOME ?? path.join(os.homedir(), '.codex');
const cursorDir = () => process.env.CURSOR_CONFIG_DIR ?? path.join(os.homedir(), '.cursor');

type Json = Record<string, any>;

function readJson(file: string): Json {
  if (!fs.existsSync(file)) return {};
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}

function writeJson(file: string, value: Json): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  if (fs.existsSync(file)) fs.copyFileSync(file, `${file}.hivemind-backup`);
  fs.writeFileSync(file, JSON.stringify(value, null, 2) + '\n');
}

const ours = (h: { command?: string }) => typeof h?.command === 'string' && /hivemind(\.mjs)?"? hook (claude|codex|cursor) /.test(h.command);

/** Remove our entries from a Claude/Codex-style hooks map ({ Event: [{ matcher?, hooks: [...] }] }). */
function withoutNestedHooks(hooks: Json = {}): Json {
  const out: Json = {};
  for (const [event, groups] of Object.entries(hooks)) {
    const kept = (groups as Json[])
      .map((g) => ({ ...g, hooks: (g.hooks ?? []).filter((h: Json) => !ours(h)) }))
      .filter((g) => g.hooks.length > 0);
    if (kept.length) out[event] = kept;
  }
  return out;
}

/** Remove our entries from a Cursor-style hooks map ({ event: [{ command }] }). */
function withoutFlatHooks(hooks: Json = {}): Json {
  const out: Json = {};
  for (const [event, list] of Object.entries(hooks)) {
    const kept = (list as Json[]).filter((h) => !ours(h));
    if (kept.length) out[event] = kept;
  }
  return out;
}

const has = (bin: string) => {
  try {
    execFileSync('which', [bin], { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
};

function runQuiet(bin: string, args: string[]): boolean {
  try {
    execFileSync(bin, args, { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}

// The hook command must stay byte-identical across upgrades: Codex asks users to re-approve changed hooks.
const command = () => `"${launcherPath()}"`;

interface Integration {
  name: string;
  detected(): boolean;
  install(): string;
  uninstall(): void;
  /** Is hivemind wired in? Returns problems; empty means healthy. */
  check(): string[];
}

const hasNestedHooks = (file: string, events: string[]) => {
  const hooks = fs.existsSync(file) ? readJson(file).hooks ?? {} : {};
  return events.filter((e) => !(hooks[e] ?? []).some((g: Json) => (g.hooks ?? []).some(ours)));
};

const claude: Integration = {
  name: 'Claude Code',
  detected: () => fs.existsSync(claudeDir()) || has('claude'),
  install() {
    const file = path.join(claudeDir(), 'settings.json');
    const settings = readJson(file);
    settings.hooks = withoutNestedHooks(settings.hooks);
    for (const event of ['SessionStart', 'UserPromptSubmit', 'PostToolUse', 'Stop']) {
      settings.hooks[event] = [...(settings.hooks[event] ?? []), { hooks: [{ type: 'command', command: `${command()} hook claude ${event}`, timeout: 5 }] }];
    }
    const allow: string[] = (settings.permissions?.allow ?? []).filter((p: string) => p !== 'mcp__hivemind');
    settings.permissions = { ...settings.permissions, allow: [...allow, 'mcp__hivemind'] };
    writeJson(file, settings);
    runQuiet('claude', ['mcp', 'remove', '--scope', 'user', 'hivemind']);
    const mcp = runQuiet('claude', ['mcp', 'add', '--scope', 'user', 'hivemind', '--', launcherPath(), 'mcp']);
    return mcp ? 'hooks + MCP server' : `hooks (MCP not registered: run  claude mcp add --scope user hivemind -- ${command()} mcp)`;
  },
  uninstall() {
    const file = path.join(claudeDir(), 'settings.json');
    if (fs.existsSync(file)) {
      const settings = readJson(file);
      settings.hooks = withoutNestedHooks(settings.hooks);
      if (settings.permissions?.allow) settings.permissions.allow = settings.permissions.allow.filter((p: string) => p !== 'mcp__hivemind');
      writeJson(file, settings);
    }
    runQuiet('claude', ['mcp', 'remove', '--scope', 'user', 'hivemind']);
  },
  check() {
    const missing = hasNestedHooks(path.join(claudeDir(), 'settings.json'), ['SessionStart', 'UserPromptSubmit', 'PostToolUse', 'Stop']);
    const problems = missing.length ? [`hooks missing: ${missing.join(', ')}`] : [];
    if (has('claude') && !runQuiet('claude', ['mcp', 'get', 'hivemind'])) problems.push('MCP server not registered');
    return problems;
  },
};

/**
 * Let Codex call hivemind's MCP tools without a prompt each time. Verified against codex-cli 0.153:
 * "approve" runs tools without asking; "auto" still requires approval.
 */
function preapproveCodexTools(): boolean {
  const file = path.join(codexDir(), 'config.toml');
  if (!fs.existsSync(file)) return false;
  const header = '[mcp_servers.hivemind]';
  const lines = fs.readFileSync(file, 'utf8').split('\n');
  const start = lines.indexOf(header);
  if (start < 0) return false;
  let end = start + 1;
  while (end < lines.length && !lines[end].startsWith('[')) end++;
  const section = lines.slice(start + 1, end).filter((l) => !l.startsWith('default_tools_approval_mode'));
  lines.splice(start, end - start, header, 'default_tools_approval_mode = "approve"', ...section);
  fs.copyFileSync(file, `${file}.hivemind-backup`);
  fs.writeFileSync(file, lines.join('\n'));
  return true;
}

const codex: Integration = {
  name: 'Codex',
  detected: () => fs.existsSync(codexDir()) || has('codex'),
  install() {
    const file = path.join(codexDir(), 'hooks.json');
    const config = readJson(file);
    config.hooks = withoutNestedHooks(config.hooks);
    for (const event of ['SessionStart', 'UserPromptSubmit', 'PostToolUse', 'Stop']) {
      config.hooks[event] = [...(config.hooks[event] ?? []), { hooks: [{ type: 'command', command: `${command()} hook codex ${event}`, timeout: 5 }] }];
    }
    writeJson(file, config);
    runQuiet('codex', ['mcp', 'remove', 'hivemind']);
    const mcp = runQuiet('codex', ['mcp', 'add', 'hivemind', '--', launcherPath(), 'mcp']) && preapproveCodexTools();
    return `hooks${mcp ? ' + MCP server' : ''}. One-time step: open Codex and run /hooks to approve hivemind's hooks (Codex requires this for any new hook)`;
  },
  uninstall() {
    const file = path.join(codexDir(), 'hooks.json');
    if (fs.existsSync(file)) {
      const config = readJson(file);
      config.hooks = withoutNestedHooks(config.hooks);
      writeJson(file, config);
    }
    runQuiet('codex', ['mcp', 'remove', 'hivemind']);
  },
  check() {
    const missing = hasNestedHooks(path.join(codexDir(), 'hooks.json'), ['SessionStart', 'UserPromptSubmit', 'PostToolUse', 'Stop']);
    const problems = missing.length ? [`hooks missing: ${missing.join(', ')}`] : [];
    const toml = path.join(codexDir(), 'config.toml');
    const config = fs.existsSync(toml) ? fs.readFileSync(toml, 'utf8') : '';
    if (!config.includes('[mcp_servers.hivemind]')) problems.push('MCP server not registered');
    else if (!/\[mcp_servers\.hivemind\]\ndefault_tools_approval_mode = "approve"/.test(config)) problems.push('MCP tools not pre-approved (Codex will prompt)');
    if (/^\s*hooks\s*=\s*false/m.test(config)) problems.push('hooks are disabled in config.toml ([features] hooks = false)');
    return problems;
  },
};

const cursor: Integration = {
  name: 'Cursor',
  detected: () => fs.existsSync(cursorDir()),
  install() {
    const hooksFile = path.join(cursorDir(), 'hooks.json');
    const config = readJson(hooksFile);
    config.version = config.version ?? 1;
    config.hooks = withoutFlatHooks(config.hooks);
    for (const event of ['sessionStart', 'postToolUse', 'stop']) {
      config.hooks[event] = [...(config.hooks[event] ?? []), { command: `${command()} hook cursor ${event}`, timeout: 5 }];
    }
    writeJson(hooksFile, config);

    const mcpFile = path.join(cursorDir(), 'mcp.json');
    const mcp = readJson(mcpFile);
    mcp.mcpServers = {
      ...mcp.mcpServers,
      hivemind: { type: 'stdio', command: launcherPath(), args: ['mcp'], env: { HIVEMIND_CWD: '${workspaceFolder}' } },
    };
    writeJson(mcpFile, mcp);
    return 'hooks + MCP server (restart Cursor to load them)';
  },
  uninstall() {
    const hooksFile = path.join(cursorDir(), 'hooks.json');
    if (fs.existsSync(hooksFile)) {
      const config = readJson(hooksFile);
      config.hooks = withoutFlatHooks(config.hooks);
      writeJson(hooksFile, config);
    }
    const mcpFile = path.join(cursorDir(), 'mcp.json');
    if (fs.existsSync(mcpFile)) {
      const mcp = readJson(mcpFile);
      if (mcp.mcpServers?.hivemind) {
        delete mcp.mcpServers.hivemind;
        writeJson(mcpFile, mcp);
      }
    }
  },
  check() {
    const hooks = fs.existsSync(path.join(cursorDir(), 'hooks.json')) ? readJson(path.join(cursorDir(), 'hooks.json')).hooks ?? {} : {};
    const missing = ['sessionStart', 'postToolUse', 'stop'].filter((e) => !(hooks[e] ?? []).some(ours));
    const problems = missing.length ? [`hooks missing: ${missing.join(', ')}`] : [];
    const mcp = fs.existsSync(path.join(cursorDir(), 'mcp.json')) ? readJson(path.join(cursorDir(), 'mcp.json')) : {};
    if (!mcp.mcpServers?.hivemind) problems.push('MCP server not registered');
    return problems;
  },
};

export const INTEGRATIONS: Record<string, Integration> = { claude, codex, cursor };

function selected(args: string[]): Integration[] {
  const only = args.find((a) => a.startsWith('--only='))?.slice('--only='.length).split(',');
  if (only) return only.map((n) => INTEGRATIONS[n]).filter(Boolean);
  return Object.values(INTEGRATIONS).filter((i) => i.detected());
}

/** A test run must never reach the real ~/.claude, ~/.codex or ~/.cursor. */
function guardTestRun(): void {
  if (!process.env.VITEST) return;
  const real = os.userInfo().homedir;
  const dirs = [claudeDir(), codexDir(), cursorDir(), hivemindHome()];
  if (dirs.some((d) => path.resolve(d).startsWith(path.join(real, '.')))) {
    throw new Error(`refusing to modify real agent configs during tests (${dirs.join(', ')})`);
  }
}

export function install(args: string[] = []): void {
  guardTestRun();
  // Copy the single-file bundle somewhere stable: npx caches are temporary.
  writeLauncher();
  const reachable = linkOntoPath();

  const targets = selected(args);
  if (!targets.length) {
    console.log('No supported agents found (Claude Code, Codex, Cursor). Install one, then run this again.');
    process.exitCode = 1;
    return;
  }
  const lines = targets.map((t) => {
    try {
      return `  ✓ ${t.name}: ${t.install()}`;
    } catch (err) {
      return `  ✗ ${t.name}: ${(err as Error).message}`;
    }
  });
  lines.push(reachable ? `  ✓ \`hivemind\` command: ${reachable}` : `  · \`hivemind\` command: add ${binDir()} to your PATH (or use npx hivemind-agents …)`);
  console.log(`hivemind installed.\n${lines.join('\n')}

That's it. Every agent session inside a git repo with an "origin" remote now shares a live plan
with everyone else on that repo who has hivemind installed. Check it any time with: hivemind status`);
}

export function uninstall(args: string[] = []): void {
  guardTestRun();
  const targets = args.some((a) => a.startsWith('--only=')) ? selected(args) : Object.values(INTEGRATIONS);
  for (const t of targets) {
    try {
      t.uninstall();
    } catch {}
  }
  if (!args.some((a) => a.startsWith('--only='))) {
    unlinkFromPath();
    fs.rmSync(binDir(), { recursive: true, force: true });
  }
  console.log('hivemind uninstalled. Shared plan data in your repos (refs/hivemind/*) was left untouched.');
}
