import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { Repo } from './git.js';

/** Hivemind must never write to an agent's stdout/stderr unexpectedly, so diagnostics go to a file. */
export function log(repo: Repo | null, msg: string): void {
  try {
    const dir = repo?.stateDir ?? path.join(os.homedir(), '.hivemind');
    fs.mkdirSync(dir, { recursive: true });
    fs.appendFileSync(path.join(dir, 'hivemind.log'), `${new Date().toISOString()} [${process.pid}] ${msg}\n`);
  } catch {}
}
