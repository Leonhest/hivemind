# hivemind

A shared, live plan for teams of coding agents. Install once; every agent working on the same
git repo sees teammates' plan changes (API contracts, decisions, task claims) at its next tool call.

```
npx hivemind-agents install
```

No server, no account, no room codes: the team is the repo. Plan entries sync through hidden
refs (`refs/hivemind/*`) on your existing git remote, never touching branches or your working tree.

- `hivemind status`: who's in the plan, sync state
- `hivemind plan`: print the shared plan
- `hivemind uninstall`: remove hooks and MCP server

See [PLAN.md](PLAN.md) for the design and roadmap.
