#!/bin/sh
# Two agents, two clones, one shared plan. Uses your Claude Code login (Haiku; costs a few cents).
# Agent B works on the frontend while agent A changes the login API without telling anyone.
# Watch B find out mid-task.
set -e
ROOT=$(cd "$(dirname "$0")/.." && pwd)
PLUGIN="$ROOT/plugin"
[ -f "$PLUGIN/dist/hivemind.mjs" ] || (cd "$ROOT" && npm run -s build)
DIR=$(mktemp -d)
trap 'pkill -f "$DIR" 2>/dev/null; rm -rf "$DIR"' EXIT

git init -q --bare "$DIR/origin.git"
for who in alice bob; do
  git clone -q "$DIR/origin.git" "$DIR/$who" 2>/dev/null
  git -C "$DIR/$who" config user.email "$who@example.com"
done
export HIVEMIND_FETCH_MS=1000

say() { printf '\n\033[1;33m▸ %s\033[0m\n' "$*"; }

say "bob's agent starts building the frontend (a long task)…"
(cd "$DIR/bob" && claude -p --model haiku --plugin-dir "$PLUGIN" --allowedTools "Bash(sleep:*)" -- \
  "You're building the login page. Simulate work by running 'sleep 8' five times, one at a time, in the foreground. Then quote verbatim any [hivemind] 'Teammates updated' message you received and say what you would change in the login page because of it." \
  < /dev/null > "$DIR/bob.out" 2>&1) &
BOB=$!

sleep 6
say "meanwhile, alice's agent rewrites the login API (it never mentions hivemind)…"
(cd "$DIR/alice" && claude -p --model haiku --plugin-dir "$PLUGIN" --allowedTools Write Edit -- \
  "Create src/api/login.ts: an Express handler for POST /api/login taking { email, password }. It used to return { token }, but change it to set the session token in an httpOnly cookie and return only { user: { id: string /* uuid */, email: string } }. Keep it short." \
  < /dev/null > /dev/null 2>&1)
say "alice's agent is done; hivemind extracts the change in the background and syncs it"

wait $BOB
say "bob's agent reports:"
cat "$DIR/bob.out"
say "the shared plan now:"
(cd "$DIR/bob" && node "$PLUGIN/dist/hivemind.mjs" plan)
