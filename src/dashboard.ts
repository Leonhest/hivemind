import { execFile } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import http from 'node:http';
import path from 'node:path';
import { describeChange } from './core/format.js';
import { applyOp, entryId, reduce } from './core/plan.js';
import { KINDS, type Kind } from './core/types.js';
import { daemonPid, ensureDaemon, readSyncStatus } from './daemon.js';
import type { Repo } from './git.js';
import { rebuild, touchActivity, writeOps } from './store.js';

const FEED_SIZE = 80;

function snapshot(repo: Repo) {
  const state = rebuild(repo);
  const ordered = [...state.ops].sort((a, b) => a.seq - b.seq);
  const members = new Map<string, { id: string; lastTs: number; ops: number }>();
  for (const op of ordered) {
    const m = members.get(op.member) ?? { id: op.member, lastTs: 0, ops: 0 };
    m.lastTs = Math.max(m.lastTs, op.ts);
    m.ops++;
    members.set(op.member, m);
  }
  // Describe each op against the state just before it, for the activity feed.
  const feed: { seq: number; ts: number; member: string; kind: Kind; text: string; source: string; breaking: boolean }[] = [];
  const recent = ordered.slice(-FEED_SIZE);
  const before = reduce(ordered.slice(0, ordered.length - recent.length));
  for (const op of recent) {
    feed.push({
      seq: op.seq,
      ts: op.ts,
      member: op.member,
      kind: op.kind,
      text: describeChange(op, before.get(entryId(op))).replace(`${op.member} `, ''),
      source: op.source,
      breaking: op.kind === 'contract' && op.data.breaking === true,
    });
    applyOp(before, op);
  }
  return {
    repo: path.basename(repo.root),
    you: repo.memberId,
    entries: [...reduce(state.ops).values()].filter((e) => e.status === 'open'),
    members: [...members.values()].sort((a, b) => b.lastTs - a.lastTs),
    feed: feed.reverse(),
    sync: readSyncStatus(repo),
    daemon: Boolean(daemonPid(repo)),
  };
}

function readBody(req: http.IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    let body = '';
    req.on('data', (d) => {
      body += d;
      if (body.length > 20_000) req.destroy();
    });
    req.on('end', () => resolve(body));
    req.on('error', reject);
  });
}

export async function runDashboard(repo: Repo, args: string[]): Promise<void> {
  // Bound to localhost; the token stops other websites from posting to it.
  const token = randomBytes(16).toString('hex');
  const server = http.createServer(async (req, res) => {
    try {
      touchActivity(repo);
      ensureDaemon(repo);
      if (req.method === 'GET' && req.url === '/') {
        res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
        return res.end(PAGE.replace('__TOKEN__', token));
      }
      if (req.method === 'GET' && req.url === '/api/state') {
        res.writeHead(200, { 'content-type': 'application/json' });
        return res.end(JSON.stringify(snapshot(repo)));
      }
      if (req.method === 'POST' && req.url === '/api/add') {
        if (req.headers['x-hivemind-token'] !== token) {
          res.writeHead(403);
          return res.end();
        }
        const { kind, key, text, breaking } = JSON.parse(await readBody(req));
        if (!KINDS.includes(kind) || typeof key !== 'string' || !key.trim() || typeof text !== 'string' || !text.trim()) {
          res.writeHead(400);
          return res.end('kind, key and text are required');
        }
        const field = { goal: 'text', decision: 'text', question: 'text', contract: 'spec', task: 'title' }[kind as Kind];
        const data: Record<string, unknown> = { [field]: text.trim() };
        if (kind === 'contract') data.breaking = Boolean(breaking);
        if (kind === 'task') data.status = 'todo';
        writeOps(repo, [{ kind, key: key.trim(), data }]);
        res.writeHead(204);
        return res.end();
      }
      res.writeHead(404);
      res.end();
    } catch (err) {
      res.writeHead(500);
      res.end(String((err as Error).message));
    }
  });
  const port = Number(args.find((a) => a.startsWith('--port='))?.slice(7) ?? 0);
  await new Promise<void>((resolve) => server.listen(port, '127.0.0.1', resolve));
  const url = `http://127.0.0.1:${(server.address() as { port: number }).port}/`;
  console.log(`hivemind dashboard for ${path.basename(repo.root)}: ${url}  (Ctrl+C to stop)`);
  if (!args.includes('--no-open')) {
    const opener = process.platform === 'darwin' ? 'open' : process.platform === 'win32' ? 'explorer' : 'xdg-open';
    execFile(opener, [url], () => {});
  }
}

const PAGE = String.raw`<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>hivemind</title>
<style>
:root {
  --bg: #f6f5f2; --panel: #ffffff; --text: #1d1c1a; --muted: #6b6862; --line: #e4e1db;
  --accent: #b4540f; --accent-soft: #fbecdf; --ok: #2f7d4f; --warn: #b42318; --warn-soft: #fde8e6;
  --chip: #f0eee9; --mono: ui-monospace, SFMono-Regular, Menlo, monospace;
}
@media (prefers-color-scheme: dark) {
  :root {
    --bg: #141412; --panel: #1d1c1a; --text: #ecebe7; --muted: #9b978f; --line: #2f2d2a;
    --accent: #f0a35e; --accent-soft: #3a2614; --ok: #6cc28f; --warn: #ff8a7a; --warn-soft: #3d1a16; --chip: #282623;
  }
}
* { box-sizing: border-box; }
body { margin: 0; background: var(--bg); color: var(--text); font: 14px/1.5 system-ui, -apple-system, Segoe UI, sans-serif; }
header { display: flex; align-items: center; gap: 12px; padding: 14px 24px; border-bottom: 1px solid var(--line); background: var(--panel); position: sticky; top: 0; z-index: 1; }
header h1 { font-size: 16px; margin: 0; letter-spacing: -0.01em; }
header .repo { font-family: var(--mono); color: var(--muted); }
.dot { width: 8px; height: 8px; border-radius: 50%; background: var(--muted); display: inline-block; margin-right: 6px; }
.dot.ok { background: var(--ok); } .dot.err { background: var(--warn); }
.sync { margin-left: auto; color: var(--muted); font-size: 13px; }
main { display: grid; grid-template-columns: minmax(0, 1fr) 340px; gap: 20px; padding: 20px 24px 40px; max-width: 1400px; margin: 0 auto; }
@media (max-width: 900px) { main { grid-template-columns: 1fr; padding: 16px; } header { padding: 12px 16px; flex-wrap: wrap; } .sync { margin-left: 0; width: 100%; } }
section { background: var(--panel); border: 1px solid var(--line); border-radius: 10px; padding: 14px 16px; margin-bottom: 16px; }
h2 { font-size: 12px; text-transform: uppercase; letter-spacing: 0.06em; color: var(--muted); margin: 0 0 10px; font-weight: 600; }
ul { list-style: none; margin: 0; padding: 0; }
li.item { padding: 8px 0; border-top: 1px solid var(--line); }
li.item:first-child { border-top: 0; padding-top: 0; }
.key { font-family: var(--mono); font-size: 12.5px; background: var(--chip); padding: 1px 6px; border-radius: 4px; }
.meta { color: var(--muted); font-size: 12px; margin-top: 2px; }
.spec { font-family: var(--mono); font-size: 12.5px; white-space: pre-wrap; word-break: break-word; margin-top: 4px; }
.badge { font-size: 11px; padding: 1px 6px; border-radius: 999px; background: var(--chip); color: var(--muted); margin-left: 6px; }
.badge.breaking { background: var(--warn-soft); color: var(--warn); }
.badge.inferred { background: var(--accent-soft); color: var(--accent); }
.board { display: grid; grid-template-columns: repeat(4, minmax(0, 1fr)); gap: 10px; }
@media (max-width: 700px) { .board { grid-template-columns: 1fr 1fr; } }
.col h3 { font-size: 12px; margin: 0 0 6px; color: var(--muted); font-weight: 600; }
.card { border: 1px solid var(--line); border-radius: 8px; padding: 8px 10px; margin-bottom: 8px; background: var(--bg); }
.card .owner { font-size: 12px; color: var(--accent); }
.empty { color: var(--muted); font-style: italic; }
.feed li { padding: 6px 0; border-top: 1px solid var(--line); font-size: 13px; }
.feed li:first-child { border-top: 0; }
.feed .who { font-weight: 600; }
.member { display: flex; justify-content: space-between; padding: 4px 0; font-size: 13px; }
.member .id { font-family: var(--mono); }
.you { color: var(--accent); }
form { display: grid; gap: 8px; }
form .row { display: flex; gap: 8px; }
input, select, textarea, button { font: inherit; color: var(--text); background: var(--bg); border: 1px solid var(--line); border-radius: 6px; padding: 6px 8px; }
textarea { resize: vertical; min-height: 60px; }
input, textarea { width: 100%; }
button { background: var(--accent); color: #fff; border: 0; cursor: pointer; font-weight: 600; }
button:focus-visible, input:focus-visible, select:focus-visible, textarea:focus-visible { outline: 2px solid var(--accent); outline-offset: 1px; }
label.check { display: flex; gap: 6px; align-items: center; color: var(--muted); font-size: 13px; }
label.check input { width: auto; }
.err { color: var(--warn); font-size: 12px; }
</style>
</head>
<body>
<header>
  <h1>hivemind</h1><span class="repo" id="repo"></span>
  <span class="sync" id="sync"><span class="dot"></span>connecting…</span>
</header>
<main>
  <div>
    <section><h2>Goals</h2><ul id="goal"></ul></section>
    <section><h2>Contracts</h2><ul id="contract"></ul></section>
    <section><h2>Tasks</h2><div class="board" id="tasks"></div></section>
    <section><h2>Decisions</h2><ul id="decision"></ul></section>
    <section><h2>Open questions</h2><ul id="question"></ul></section>
  </div>
  <aside>
    <section><h2>Team</h2><div id="members"></div></section>
    <section>
      <h2>Add to the plan</h2>
      <form id="add">
        <div class="row">
          <select name="kind" aria-label="Kind">
            <option value="goal">Goal</option><option value="task">Task</option><option value="contract">Contract</option>
            <option value="decision">Decision</option><option value="question">Question</option>
          </select>
          <input name="key" placeholder="key, e.g. auth-api" aria-label="Key" required>
        </div>
        <textarea name="text" placeholder="Description / spec" aria-label="Text" required></textarea>
        <label class="check"><input type="checkbox" name="breaking"> breaking contract change</label>
        <button type="submit">Add</button>
        <div class="err" id="adderr" role="status"></div>
      </form>
    </section>
    <section><h2>Activity</h2><ul class="feed" id="feed"></ul></section>
  </aside>
</main>
<script>
const TOKEN = '__TOKEN__';
const $ = (id) => document.getElementById(id);
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
const ago = (ts) => { if (!ts) return 'never'; const s = Math.round((Date.now() - ts) / 1000); return s < 60 ? s + 's ago' : s < 3600 ? Math.round(s / 60) + 'm ago' : Math.round(s / 3600) + 'h ago'; };
const by = (e) => '<div class="meta">' + esc(e.updatedBy) + ' · ' + ago(e.updatedAt) + (e.revisions > 1 ? ' · rev ' + e.revisions : '') + '</div>';

function list(id, items, render) {
  $(id).innerHTML = items.length ? items.map((e) => '<li class="item">' + render(e) + '</li>').join('') : '<li class="empty">Nothing yet</li>';
}

function render(s) {
  $('repo').textContent = s.repo;
  const err = s.sync.lastErrorAt && s.sync.lastErrorAt > (s.sync.lastFetch || 0);
  $('sync').innerHTML = '<span class="dot ' + (err ? 'err' : s.daemon ? 'ok' : '') + '"></span>' +
    (err ? 'sync error: ' + esc(s.sync.lastError) : 'synced ' + ago(s.sync.lastFetch));
  const of = (k) => s.entries.filter((e) => e.kind === k).sort((a, b) => b.updatedAt - a.updatedAt);
  list('goal', of('goal'), (e) => esc(e.data.text) + by(e));
  list('contract', of('contract'), (e) => '<span class="key">' + esc(e.key) + '</span>' +
    (e.data.breaking ? '<span class="badge breaking">breaking</span>' : '') + '<div class="spec">' + esc(e.data.spec) + '</div>' + by(e));
  list('decision', of('decision'), (e) => esc(e.data.text) + (e.data.rationale ? '<div class="meta">why: ' + esc(e.data.rationale) + '</div>' : '') + by(e));
  list('question', of('question'), (e) => esc(e.data.text) + (e.data.answer ? '<div class="meta">→ ' + esc(e.data.answer) + '</div>' : '') + by(e));
  const cols = ['todo', 'doing', 'blocked', 'done'];
  $('tasks').innerHTML = cols.map((c) => {
    const ts = of('task').filter((t) => (t.data.status || 'todo') === c);
    return '<div class="col"><h3>' + c + ' · ' + ts.length + '</h3>' + ts.map((t) => '<div class="card">' + esc(t.data.title || t.key) +
      (t.data.owner ? '<div class="owner">@' + esc(t.data.owner) + '</div>' : '') + (t.data.note ? '<div class="meta">' + esc(t.data.note) + '</div>' : '') + '</div>').join('') + '</div>';
  }).join('');
  $('members').innerHTML = s.members.length ? s.members.map((m) => '<div class="member"><span class="id' + (m.id === s.you ? ' you' : '') + '">' + esc(m.id) +
    (m.id === s.you ? ' (you)' : '') + '</span><span class="meta">' + ago(m.lastTs) + '</span></div>').join('') : '<div class="empty">No one yet</div>';
  $('feed').innerHTML = s.feed.length ? s.feed.map((f) => '<li><span class="who">' + esc(f.member) + '</span> ' + esc(f.text) +
    (f.breaking ? '<span class="badge breaking">breaking</span>' : '') + (f.source === 'inferred' ? '<span class="badge inferred">inferred</span>' : '') +
    '<div class="meta">' + ago(f.ts) + '</div></li>').join('') : '<li class="empty">No activity yet</li>';
}

async function refresh() {
  try { render(await (await fetch('/api/state')).json()); }
  catch { $('sync').innerHTML = '<span class="dot err"></span>dashboard server stopped'; }
}

$('add').addEventListener('submit', async (ev) => {
  ev.preventDefault();
  const f = new FormData(ev.target);
  const res = await fetch('/api/add', { method: 'POST', headers: { 'content-type': 'application/json', 'x-hivemind-token': TOKEN },
    body: JSON.stringify({ kind: f.get('kind'), key: f.get('key'), text: f.get('text'), breaking: f.get('breaking') === 'on' }) });
  $('adderr').textContent = res.ok ? '' : await res.text();
  if (res.ok) { ev.target.reset(); refresh(); }
});

refresh();
setInterval(refresh, 2000);
</script>
</body>
</html>`;
