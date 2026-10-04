import { formatSummary } from './core/format.js';
import { daemonPid, ensureDaemon, runDaemon } from './daemon.js';
import { findRepo, FETCH_REFSPEC, gitAsync, tryGit, LOCAL_PREFIX, readRefs, REMOTE_PREFIX } from './git.js';
import { runHook } from './hook.js';
import { readState, rebuild } from './store.js';

const USAGE = `hivemind — a shared, live plan for teams of coding agents

  hivemind install      set up hooks + MCP for Claude Code (once per machine)
  hivemind uninstall    remove them
  hivemind status       show sync state for the current repo
  hivemind plan         print the shared plan for the current repo
  hivemind sync         push + fetch right now

internal: hook <agent> <event> | mcp | daemon | extract <agent> <session> <transcript>`;

function requireRepo() {
  const repo = findRepo(process.cwd());
  if (!repo) {
    console.error('Not inside a git repository with an "origin" remote; hivemind is inactive here.');
    process.exit(1);
  }
  return repo;
}

async function main(): Promise<void> {
  const [cmd, ...args] = process.argv.slice(2);
  switch (cmd) {
    case 'hook':
      return runHook(args[0] ?? 'claude', args[1] ?? '');
    case 'mcp':
      return (await import('./mcp.js')).runMcp();
    case 'extract': {
      const [agent, session, transcript] = args;
      const repo = requireRepo();
      return (await import('./extract.js')).runExtract(repo, agent, session, transcript);
    }
    case 'daemon':
      return runDaemon(requireRepo());
    case 'install':
      return (await import('./install.js')).install();
    case 'uninstall':
      return (await import('./install.js')).uninstall();
    case 'plan': {
      const repo = requireRepo();
      console.log(formatSummary(rebuild(repo).ops));
      return;
    }
    case 'sync': {
      const repo = requireRepo();
      const own = tryGit(repo.root, ['rev-parse', '-q', '--verify', repo.ownRef]);
      if (own) await gitAsync(repo.root, ['push', '-q', 'origin', `${repo.ownRef}:${repo.ownRef}`]);
      await gitAsync(repo.root, ['fetch', '-q', '--no-tags', 'origin', FETCH_REFSPEC]);
      const state = rebuild(repo);
      console.log(`synced: ${state.ops.length} ops`);
      return;
    }
    case 'status': {
      const repo = requireRepo();
      const state = readState(repo);
      const members = new Set(Object.keys(readRefs(repo)).map((r) => r.replace(REMOTE_PREFIX, '').replace(LOCAL_PREFIX, '')));
      const pid = daemonPid(repo);
      console.log(`repo:    ${repo.root}
you:     ${repo.memberId}
members: ${[...members].join(', ') || '(none yet)'}
ops:     ${state.ops.length}
daemon:  ${pid ? `running (pid ${pid})` : 'stopped (starts automatically with your agent)'}
state:   ${repo.stateDir}`);
      return;
    }
    case 'start': // undocumented helper for tests
      ensureDaemon(requireRepo());
      return;
    default:
      console.log(USAGE);
      if (cmd && cmd !== 'help' && cmd !== '--help') process.exitCode = 1;
  }
}

main().catch((err) => {
  console.error(err?.message ?? err);
  process.exit(1);
});
