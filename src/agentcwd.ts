import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

/**
 * Hooks receive the agent's current directory on every event; the MCP server only knows the
 * directory its session started in. Hooks record the current directory per agent process here,
 * and the MCP server (a child of the same agent process) reads it, so tools follow the agent
 * when it moves into a repo.
 */
const dir = () => path.join(process.env.HIVEMIND_HOME ?? path.join(os.homedir(), '.hivemind'), 'agents');
const SHELLS = new Set(['sh', 'bash', 'zsh', 'dash', 'fish', 'hivemind']);
const MAX_AGE_MS = 12 * 60 * 60_000;

/** The nearest ancestor that isn't a shell: the agent process (claude, codex, Cursor) that ran us. */
export function agentPid(): number | null {
  let pid = process.ppid;
  for (let i = 0; i < 4 && pid > 1; i++) {
    let line: string;
    try {
      line = execFileSync('ps', ['-o', 'ppid=,comm=', '-p', String(pid)], { encoding: 'utf8', timeout: 1_000 }).trim();
    } catch {
      return null;
    }
    const [ppid, ...comm] = line.split(/\s+/);
    if (!SHELLS.has(path.basename(comm.join(' ')))) return pid;
    pid = Number(ppid);
  }
  return null;
}

export function recordAgentCwd(cwd: string): void {
  const pid = agentPid();
  if (!pid) return;
  try {
    fs.mkdirSync(dir(), { recursive: true });
    const file = path.join(dir(), `${pid}.json`);
    try {
      if (JSON.parse(fs.readFileSync(file, 'utf8')).cwd === cwd) return fs.utimesSync(file, new Date(), new Date());
    } catch {}
    fs.writeFileSync(file, JSON.stringify({ cwd, ts: Date.now() }));
    // Forget agents that are long gone.
    for (const f of fs.readdirSync(dir())) {
      const p = path.join(dir(), f);
      if (Date.now() - fs.statSync(p).mtimeMs > MAX_AGE_MS) fs.rmSync(p, { force: true });
    }
  } catch {}
}

/** The directory the agent that started this process was last seen in, per its hooks. */
export function lastAgentCwd(): string | null {
  const pid = agentPid();
  if (!pid) return null;
  try {
    const file = path.join(dir(), `${pid}.json`);
    if (Date.now() - fs.statSync(file).mtimeMs > MAX_AGE_MS) return null;
    return JSON.parse(fs.readFileSync(file, 'utf8')).cwd ?? null;
  } catch {
    return null;
  }
}
