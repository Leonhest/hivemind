# hivemind

**A shared, live plan for teams of coding agents.**

You split the work, everyone's agents go off and build, and an hour later the plan in each agent's
head is stale: someone changed the `User` schema, someone else switched auth libraries, two agents are
building the same endpoint. hivemind keeps one plan in sync across every agent on the team and puts
teammates' changes into each agent's context at its next tool call.

```
npx hivemind-agents install
```

Run it once per machine. No server, no account, no room codes: **the team is the git repo.**

## What your agent sees

Teammate's agent changes an API while yours is mid-task. A few seconds later, after its next command, your agent sees:

```
[hivemind] Teammates updated the shared plan since you last checked:
⚠️ BREAKING alice-3f2a1c updated contract: `User.id`: uuid (breaking) (was: int)
🎯 (overlaps files you touched) bob-91d0e4 added task: [doing] Signup form @bob-91d0e4
- alice-3f2a1c added decision: JWT in an httpOnly cookie, not localStorage [inferred]
Check whether your current work depends on the breaking changes above and adapt it.
```

At session start it gets the whole plan: goals, contracts (API shapes, schemas, shared types),
decisions, who's doing what, and open questions.

## How it works

```
 your agent ── hooks ──► hivemind ──► .git/hivemind/state.json (local cache, read in ~30 ms)
                            │
                  background daemon: push your ref, fetch everyone's (every 3 s while active)
                            │
                  origin: refs/hivemind/<member>   (hidden refs, never branches)
```

- **Sync through git.** Each person's plan entries live on their own hidden ref
  (`refs/hivemind/<member>`) on your existing remote. Nobody ever writes to someone else's ref, so
  there are no merge conflicts. Branches, PRs and your working tree are never touched.
- **Updates arrive by themselves.** Hooks add the full plan at session start, then only what
  changed since the agent last looked, with the most important items first.
- **The plan updates itself.** When an agent finishes a turn, a background extractor reads only the
  new part of its transcript and pulls out the things teammates need: contracts, decisions and task
  progress, each with a quote as evidence. Agents can also publish explicitly through MCP tools
  (`contract_publish`, `decision_log`, `task_claim`, …), and they're told to for anything urgent.
- **Updates arrive in seconds.** Typically 2–5 s from one agent's change to the other machine,
  then shown at that agent's next tool call.

## Supported agents

| Agent | Plan at start | Updates mid-task | Auto-extraction | Notes |
|---|---|---|---|---|
| Claude Code | ✅ | ✅ every prompt and tool call | ✅ | |
| Codex CLI | ✅ | ✅ every prompt and tool call | ✅ | Approve the hooks once with `/hooks` in Codex (Codex requires this for any new hook) |
| Cursor | ✅ | ✅ after each tool call | ✅ | Built from Cursor's hook docs; not yet tested in a live Cursor session |

`install` detects which of these you have and configures each one (`--only=claude,codex` to choose).

### Claude Code plugin (alternative)

```
/plugin marketplace add Leonhest/hivemind
/plugin install hivemind@hivemind
```

Same hooks and MCP tools, no npm needed. Use either the plugin or `npx … install`, not both.

## Commands

```
hivemind status       who's in the plan, last sync
hivemind plan         print the shared plan
hivemind open         live dashboard in your browser (and a form to add to the plan)
hivemind add <goal|task|contract|decision|question> <key> <text> [--breaking]
hivemind doctor       check that everything is wired up
hivemind uninstall    remove hooks and MCP config (your repos' plan data is left alone)
```

## Privacy and cost

- **Your plan data never leaves your git host.** There's no hivemind server. Anyone with read
  access to the repo can read its plan refs, the same people who can read the code.
- **Extraction runs on your machine with your own agent login.** It calls `claude -p` with Haiku
  (or `codex exec` if you only have Codex) using your existing subscription or API key: about
  $0.005 per extraction on API pricing, or a small slice of your subscription usage. Set
  `HIVEMIND_EXTRACTOR_BACKEND=none` to turn it off and rely on the MCP tools only.
- Only new parts of transcripts with real work in them (a request or a code change) get
  extracted. Read-only exploration is skipped.

## Requirements and limits

- macOS or Linux, Node 20+, git, and a repo with an `origin` remote you can push to (without push
  access you still receive updates, but can't share yours).
- Tested with GitHub. Other hosts that accept custom refs should work; GitLab hasn't been tested yet.
- Not inside a git repo, or no `origin`? hivemind stays out of the way.

## Troubleshooting

Run `hivemind doctor`. Logs are in `.git/hivemind/` in each repo (`hivemind.log`, `daemon.log`, `extract.log`).

## License

MIT
