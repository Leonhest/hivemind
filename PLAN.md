# Hivemind — Build Plan

## Goal
A shared, always-current plan for multiple coding agents on different machines.
Install once; agents read and update the plan automatically. Nobody thinks about it again.

**Success test:** 3 agent sessions on 3 laptops build one app. One agent changes an API shape;
the other two see it at their next tool call, with zero manual steps.

## Principles
1. **One install, zero thought.** No room codes, no config, no commands to remember.
2. **Never block an agent.** Hooks read a local cache, finish in <100ms, always exit 0.
3. **Inject only what matters.** Small relevant diffs, never the whole plan repeatedly.
4. **No server.** The team's git remote is the backend. Repo access = team membership.

## Distribution
- npm package: `hivemind-agents` (`hivemind` is taken). CLI binary: `hivemind`.
- Install: `npx hivemind-agents install` (user-level, once, works in every repo).

## Architecture
```
┌──────────────── Each developer's machine ────────────────┐
│  Agent sessions (Claude Code / Cursor / Codex)           │
│    ├─ hooks ──► hivemind hook   (reads local cache)      │
│    └─ MCP   ──► hivemind mcp    (optional explicit tools)│
│                     │                                    │
│  hivemind daemon (auto-started, one per repo)            │
│    ├─ writes own entries → refs/hivemind/<member>        │
│    ├─ pushes own ref, fetches others every ~5s           │
│    ├─ merges all members' logs → local plan cache        │
│    └─ runs extractor (Haiku via `claude -p`) in bg       │
└───────────────────────┬──────────────────────────────────┘
                        │ git push / fetch
              ┌─────────▼─────────┐
              │  Team's git remote │  (GitHub, GitLab, …)
              │  refs/hivemind/*   │
              └────────────────────┘
```

### Git sync design
- Each member writes **only their own ref** (`refs/hivemind/<member-id>`) → no merge conflicts, ever.
- Each ref points to a commit whose tree holds an append-only `ops.jsonl` for that member.
- Custom refs are not branches: they don't show in the branch list, PRs, or `git log` of main.
- Daemon: `git push origin refs/hivemind/<me>` on change; `git fetch origin 'refs/hivemind/*:refs/hivemind-remote/*'` every ~5s.
- Merge: read all members' `ops.jsonl`, order by (lamport clock, member id), reduce to state.
- Offline: commits queue locally, push when back online.
- Fallback if a host rejects custom refs: orphan branch `hivemind` with one directory per member.

## Components

### 1. Room identity (automatic)
- Room = the git repo. Not in a git repo with a remote → hivemind silently disabled.
- Member id = sanitized `git config user.email` (or name) + machine short hash.
- Agent id = member id + session id.

### 2. Plan model (`core`)
Event log of ops reduced into state.

| Entry      | Fields                                                     |
|------------|------------------------------------------------------------|
| `goal`     | text                                                       |
| `task`     | title, owner, status, depends_on, areas (paths/tags)       |
| `contract` | name, spec, owner, areas, version, `breaking` flag         |
| `decision` | text, rationale, author                                    |
| `question` | text, status                                               |
| `presence` | who's active, on what (heartbeat, expires)                 |

- Ops: `upsert`, `close`. Last-write-wins per entry; conflict detector flags overlaps.
- Every entry has `source: explicit | inferred` (+ evidence quote when inferred).

### 3. Hooks (`hivemind hook <agent> <event>`)
One adapter per agent; v1 supports **Claude Code, Cursor, Codex**.

| Event (Claude Code)  | Action                                                                 |
|----------------------|------------------------------------------------------------------------|
| `SessionStart`       | Ensure daemon running; inject compact plan (≤800 tokens); presence     |
| `UserPromptSubmit`   | Inject diff since last-seen version; queue prompt for task auto-claim  |
| `PostToolUse`        | Inject diff (throttled ~10s); record touched files for relevance       |
| `Stop`               | Trigger background extraction on new transcript segment                |

Cursor/Codex adapters map their hook events onto the same core actions. Phase 0 verifies what
each supports (especially context injection); where injection isn't possible, fall back to
MCP + an `AGENTS.md` / rules instruction.

**Relevance filter:** always show breaking contracts and new decisions; otherwise only entries
touching the agent's task, files, or dependencies. ~300 tokens per injection max.

### 4. Extractor (passive updates)
- Background, detached, never inline in a hook.
- Reads new transcript segment, calls Haiku via `claude -p --model haiku` with a JSON schema
  (uses existing Claude auth — no extra key).
- Emits ops: task claimed/done, decisions, contract changes.
- Guardrails: confidence threshold, `inferred` tag + evidence, dedupe, max N ops per run.
- Runs on each member's own Claude login (subscription usage or API key). Members without Claude Code:
  fall back to their agent's headless mode (e.g. `codex exec`), else explicit MCP tools only.

### 5. MCP server (`hivemind mcp`)
`plan_get`, `task_claim`, `task_update`, `contract_publish`, `decision_log`, `question_ask`.

### 6. CLI
`install`, `uninstall`, `status`, `doctor`, `open` (local dashboard), `hook`, `mcp`, `daemon`.
`install` edits user-level agent configs idempotently, with backups.

### 7. Dashboard
`hivemind open` → local web page served by the daemon: tasks, contracts, decisions, presence, feed.

## Repo layout
```
hivemind/
  src/core/      plan model, reducer, formatting (no I/O)
  src/git.ts     repo detection, member refs
  src/store.ts   local cache (state.json), lock, sessions
  src/daemon.ts  push/fetch loop
  src/hook.ts    agent hook handler
  src/mcp.ts     MCP tools
  src/install.ts install/uninstall
  test/
```
One npm package, bundled by esbuild into a single file (`dist/hivemind.mjs`) so `install` can
copy it to `~/.hivemind/bin` (npx caches are temporary). TypeScript, vitest.

## Phases
**Phase 0 — Spikes (½–1 day)**
- [x] Git: push/fetch custom refs `refs/hivemind/*` to GitHub — ✅ accepted, hidden from branch list; push ~1.3s, fetch ~0.5–0.9s (GitLab still unchecked)
- [x] Git: polling — 2 members @3s for ~2 min: end-to-end latency 2–5s (avg ~3.2s), 0 errors. Long-duration rate limits still unproven
- [x] Claude Code: `UserPromptSubmit` + `PostToolUse` `additionalContext` both reach the model ✅; node hook ~33ms
- [x] Codex: hooks **stable** (v0.153, `[features] hooks = true`), `~/.codex/hooks.json`, same `hookSpecificOutput.additionalContext`
      shape as Claude Code on SessionStart / UserPromptSubmit / PostToolUse / Stop → near-identical adapter
- [x] Cursor: `~/.cursor/hooks.json`; injection only on `sessionStart` + `postToolUse` (`additional_context`, snake_case);
      `beforeSubmitPrompt` can't inject → updates arrive at session start and after each tool call (good enough)
- [x] Extractor: `claude -p --model haiku --json-schema` gives clean ops with evidence.
      Default system prompt: ~16s / $0.08 per run ❌. With `--system-prompt <minimal> --tools "" --setting-sources ""`:
      ~8s / **$0.005** ✅. `--bare` unusable (skips OAuth login). Recursion guard: `HIVEMIND_EXTRACTOR=1` env +
      `--settings '{"disableAllHooks":true}'`.

**Phase 1 — Core loop: DONE ✅** core model, git sync daemon, Claude Code hooks, `install`/`uninstall`,
MCP tools (plan_get, task_claim, task_update, contract_publish, decision_log, goal_set, question, plan_remove).
Verified: 13 unit/integration tests; real end-to-end via GitHub — agent B received agent A's breaking
contract change mid-task (A published at ~+7s, B saw it at its next tool call); install is idempotent and
preserves existing user hooks/permissions; uninstall restores them.

**Phase 2 — Passive extraction: DONE ✅** Stop hook → detached extractor reads only the new transcript
segment (Claude Code + Codex formats, generic fallback), skips non-substantive segments, calls Haiku with the
current plan for dedupe, filters by confidence, never steals a teammate's task, tags ops `inferred` + evidence.
Verified via GitHub: agent A wrote a login API without touching hivemind tools; ~10s after A stopped,
agent B received the inferred `POST /api/login` contract, the cookie decision and A's task mid-task.

**Phase 3 — Cursor + Codex adapters: DONE ✅** Per-agent hook adapters; installer detects Claude Code /
Codex / Cursor and configures each (hooks + MCP). Stable launcher `~/.hivemind/bin/hivemind` so configs
survive node/hivemind upgrades (and Codex hook trust, which is keyed on the hook's hash, stays valid).
Codex: verified live — plan injected at start, breaking change received mid-task, MCP tools work with
`default_tools_approval_mode = "approve"` (empirically: "approve" runs without prompting, "auto" does not),
`codex exec` works as extractor fallback. Codex requires a one-time `/hooks` approval by the user (by design;
not bypassed). Cursor: implemented from docs + unit tested; **not yet verified in a live Cursor session**.

**Phase 4 — Polish (1–2 days):** conflict detection, dashboard, `status`/`doctor`, token tuning.

**Phase 5 — Launch:** README + 3-terminal demo GIF, MCP registry, Claude Code plugin marketplace,
dogfood at next hackathon.

## Risks
| Risk                                   | Mitigation                                              |
|----------------------------------------|---------------------------------------------------------|
| Host rejects custom refs               | Orphan-branch fallback                                  |
| Frequent fetches throttled             | Adaptive interval; back off when idle                   |
| Hook latency                           | Local cache only, hard timeouts, exit 0                 |
| Context noise                          | Relevance filter, token caps, diffs only                |
| Extractor invents decisions            | Confidence threshold, `inferred` + evidence, dedupe     |
| Agent hook APIs change                 | Per-agent adapters, pinned tested versions              |
| Members without push access            | Read-only mode: receive updates, can't publish          |
