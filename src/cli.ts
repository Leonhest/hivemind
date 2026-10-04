import { formatSummary } from './core/format.js';
import { daemonPid, ensureDaemon, readSyncStatus, runDaemon } from './daemon.js';
import { findRepo, FETCH_REFSPEC, gitAsync, tryGit, LOCAL_PREFIX, readRefs, REMOTE_PREFIX } from './git.js';
import { runHook } from './hook.js';
import { KINDS, type Kind } from './core/types.js';
import { readState, rebuild, touchActivity, writeOps } from './store.js';

const USAGE = `hivemind — a shared, live plan for teams of coding agents

  hivemind install      set up hooks + MCP for Claude Code (once per machine)
  hivemind uninstall    remove them
  hivemind status       show sync state for the current repo
  hivemind open         live dashboard in your browser
  hivemind doctor       check that everything is wired up
  hivemind plan         print the shared plan for the current repo
  hivemind sync         push + fetch right now
  hivemind add <kind> <key> <text> [--breaking]
                        add to the plan yourself (goal, task, contract, decision, question)

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
      return (await import('./install.js')).install(args);
    case 'uninstall':
      return (await import('./install.js')).uninstall(args);
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
    case 'add': {
      // Humans can edit the plan too: hivemind add <kind> <key> <text> [--breaking]
      const breaking = args.includes('--breaking');
      const [kind, key, ...rest] = args.filter((a) => a !== '--breaking');
      const textArg = rest.join(' ');
      if (!KINDS.includes(kind as Kind) || !key || !textArg) {
        console.error(`usage: hivemind add <${KINDS.join('|')}> <key> <text> [--breaking]`);
        process.exit(1);
      }
      const field = { goal: 'text', decision: 'text', question: 'text', contract: 'spec', task: 'title' }[kind as Kind];
      const data: Record<string, unknown> = { [field]: textArg };
      if (kind === 'contract') data.breaking = breaking;
      if (kind === 'task') data.status = 'todo';
      const repo = requireRepo();
      writeOps(repo, [{ kind: kind as Kind, key, data }]);
      ensureDaemon(repo);
      touchActivity(repo);
      console.log(`added ${kind} "${key}"; syncing to teammates`);
      return;
    }
    case 'open':
      return (await import('./dashboard.js')).runDashboard(requireRepo(), args);
    case 'doctor':
      return (await import('./doctor.js')).runDoctor();
    case 'status': {
      const repo = requireRepo();
      const state = readState(repo);
      const members = new Set(Object.keys(readRefs(repo)).map((r) => r.replace(REMOTE_PREFIX, '').replace(LOCAL_PREFIX, '')));
      const pid = daemonPid(repo);
      const sync = readSyncStatus(repo);
      const ago = (ts?: number) => (ts ? `${Math.round((Date.now() - ts) / 1000)}s ago` : 'never');
      const err = sync.lastErrorAt && sync.lastErrorAt > (sync.lastFetch ?? 0) ? `\nerror:   ${sync.lastError}` : '';
      console.log(`repo:    ${repo.root}
you:     ${repo.memberId}
members: ${[...members].join(', ') || '(none yet)'}
ops:     ${state.ops.length}
daemon:  ${pid ? `running (pid ${pid})` : 'stopped (starts automatically with your agent)'}
synced:  fetched ${ago(sync.lastFetch)}, pushed ${ago(sync.lastPush)}${err}`);
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
