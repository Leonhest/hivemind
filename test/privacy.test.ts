import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { redact } from '../src/core/redact.js';
import { findRepo, githubSlug, setEnabled, type Repo } from '../src/git.js';
import { handleEvent } from '../src/hook.js';
import { readState, writeOps } from '../src/store.js';

describe('redact', () => {
  it.each([
    ['key sk-ant-api03-abcdefghijklmnop1234', 'key [redacted]'],
    ['token ghp_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa', 'token [redacted]'],
    ['AWS AKIAABCDEFGHIJKLMNOP here', 'AWS [redacted] here'],
    ['DATABASE_URL=postgres://app:hunter22@db:5432/x', 'DATABASE_URL=postgres://app:[redacted]@db:5432/x'],
    ['set password = "correct-horse" then', 'set password = [redacted] then'],
    ['api_key: abc123xyz789', 'api_key: [redacted]'],
    ['-----BEGIN RSA PRIVATE KEY-----\nMIIabc\n-----END RSA PRIVATE KEY-----', '[redacted private key]'],
  ])('%s', (input, expected) => expect(redact(input)).toBe(expected));

  it('leaves ordinary plan text alone', () => {
    const text = 'POST /api/login returns { token: string, user: { id: uuid } }; password field is required';
    expect(redact(text)).toBe(text);
  });
});

describe('githubSlug', () => {
  it.each([
    ['https://github.com/Leonhest/hivemind.git', 'Leonhest/hivemind'],
    ['git@github.com:Leonhest/hivemind.git', 'Leonhest/hivemind'],
    ['https://github.com/a/b', 'a/b'],
    ['https://gitlab.com/a/b.git', null],
  ])('%s', (url, slug) => expect(githubSlug(url)).toBe(slug));
});

describe('per-clone switch and public notice', () => {
  let dir: string;
  let repo: Repo;
  beforeAll(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hivemind-privacy-'));
    execFileSync('git', ['init', '-q', '--bare', 'remote.git'], { cwd: dir });
    execFileSync('git', ['clone', '-q', 'remote.git', 'me'], { cwd: dir, stdio: 'pipe' });
    repo = findRepo(path.join(dir, 'me'))!;
    fs.mkdirSync(repo.stateDir, { recursive: true });
    fs.writeFileSync(path.join(repo.stateDir, 'daemon.pid'), String(process.pid));
  });
  afterAll(() => fs.rmSync(dir, { recursive: true, force: true }));

  it('scrubs secrets on every write', () => {
    writeOps(repo, [{ kind: 'decision', key: 'db', data: { text: 'Use postgres://app:s3cretpw@db/x' }, evidence: 'token ghp_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa' }]);
    const op = readState(repo).ops.at(-1)!;
    expect(op.data.text).toBe('Use postgres://app:[redacted]@db/x');
    expect(op.evidence).toBe('token [redacted]');
  });

  it('warns agents at session start when the repo is public', () => {
    fs.writeFileSync(path.join(repo.stateDir, 'visibility.json'), JSON.stringify({ public: true, checkedAt: Date.now() }));
    expect(handleEvent(repo, { event: 'SessionStart', sessionId: 'p1' })).toContain('This repository is PUBLIC');
    fs.writeFileSync(path.join(repo.stateDir, 'visibility.json'), JSON.stringify({ public: false, checkedAt: Date.now() }));
    expect(handleEvent(repo, { event: 'SessionStart', sessionId: 'p2' })).not.toContain('PUBLIC');
  });

  it('disable turns hivemind off for the clone; enable turns it back on', () => {
    setEnabled(repo, false);
    expect(findRepo(repo.root)).toBeNull();
    expect(findRepo(repo.root, { includeDisabled: true })?.root).toBe(repo.root);
    setEnabled(repo, true);
    expect(findRepo(repo.root)?.root).toBe(repo.root);
  });
});
