import fs from 'node:fs';
import { daemonPid, readSyncStatus } from './daemon.js';
import { pickBackend } from './extract.js';
import { findRepo, gitAsync, tryGit } from './git.js';
import { INTEGRATIONS, launcherPath } from './install.js';
import { readState } from './store.js';

const ago = (ts?: number) => (ts ? `${Math.round((Date.now() - ts) / 1000)}s ago` : 'never');

export async function runDoctor(): Promise<void> {
  let failed = 0;
  const ok = (msg: string) => console.log(`  ✓ ${msg}`);
  const bad = (msg: string, fix?: string) => {
    failed++;
    console.log(`  ✗ ${msg}${fix ? `\n      → ${fix}` : ''}`);
  };
  const note = (msg: string) => console.log(`  · ${msg}`);

  console.log('Setup');
  const major = Number(process.versions.node.split('.')[0]);
  major >= 20 ? ok(`node ${process.versions.node}`) : bad(`node ${process.versions.node} is too old`, 'install Node 20 or newer');
  tryGit(process.cwd(), ['--version']) ? ok('git available') : bad('git not found', 'install git');
  fs.existsSync(launcherPath()) ? ok(`launcher at ${launcherPath()}`) : bad('hivemind is not installed', 'run: npx hivemind-agents install');

  console.log('\nAgents');
  for (const [key, integration] of Object.entries(INTEGRATIONS)) {
    if (!integration.detected()) {
      note(`${integration.name}: not found on this machine`);
      continue;
    }
    const problems = integration.check();
    problems.length ? bad(`${integration.name}: ${problems.join('; ')}`, `run: hivemind install --only=${key}`) : ok(`${integration.name}: hooks + MCP configured`);
  }
  if (INTEGRATIONS.codex.detected()) note("Codex only runs new hooks after you approve them once with /hooks inside Codex");
  const backend = pickBackend('claude');
  backend ? ok(`automatic plan extraction via ${backend}`) : bad('no extractor available (needs claude or codex CLI)', 'plan updates will rely on agents calling the MCP tools');

  console.log('\nThis repo');
  const repo = findRepo(process.cwd());
  if (!repo) {
    note('not inside a git repo with an "origin" remote, so hivemind is inactive here');
  } else {
    ok(`${repo.root} (you are ${repo.memberId})`);
    try {
      await gitAsync(repo.root, ['ls-remote', '--exit-code', 'origin', 'HEAD'], 15_000).catch(async () => gitAsync(repo.root, ['ls-remote', 'origin'], 15_000));
      ok('can reach origin');
    } catch (err) {
      bad(`cannot reach origin: ${(err as Error).message.split('\n')[0]}`, 'check your network and git credentials (hivemind never prompts for them)');
    }
    if (tryGit(repo.root, ['rev-parse', '-q', '--verify', repo.ownRef])) {
      try {
        await gitAsync(repo.root, ['push', '--dry-run', '-q', 'origin', `${repo.ownRef}:${repo.ownRef}`], 15_000);
        ok('can push plan updates');
      } catch (err) {
        bad(`cannot push: ${(err as Error).message.split('\n')[0]}`, 'you will still receive updates; ask for push access to share yours');
      }
    } else note('push access will be checked on your first plan update');
    const pid = daemonPid(repo);
    pid ? ok(`sync daemon running (pid ${pid})`) : note('sync daemon idle (starts automatically with your agent)');
    const sync = readSyncStatus(repo);
    note(`last fetch ${ago(sync.lastFetch)}, last push ${ago(sync.lastPush)}, ${readState(repo).ops.length} plan ops`);
    if (sync.lastErrorAt && sync.lastErrorAt > (sync.lastFetch ?? 0)) bad(`last sync failed ${ago(sync.lastErrorAt)}: ${sync.lastError}`);
  }

  console.log(failed ? `\n${failed} problem(s) found.` : '\nAll good.');
  if (failed) process.exitCode = 1;
}
