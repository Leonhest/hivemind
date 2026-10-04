import { execFile } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { githubSlug, tryGit, type Repo } from './git.js';

/** Whether the repo is publicly readable. null = unknown (non-GitHub host, or offline). */
export interface Visibility {
  public: boolean | null;
  checkedAt: number;
}

const DAY = 24 * 60 * 60_000;
const file = (repo: Repo) => path.join(repo.stateDir, 'visibility.json');

export function readVisibility(repo: Repo): Visibility | null {
  try {
    return JSON.parse(fs.readFileSync(file(repo), 'utf8'));
  } catch {
    return null;
  }
}

const viaGh = (slug: string) =>
  new Promise<boolean | null>((resolve) =>
    execFile('gh', ['api', `repos/${slug}`, '-q', '.private'], { timeout: 10_000 }, (err, out) =>
      resolve(err ? null : out.trim() === 'true' ? false : out.trim() === 'false' ? true : null),
    ),
  );

async function viaApi(slug: string): Promise<boolean | null> {
  try {
    const res = await fetch(`https://api.github.com/repos/${slug}`, { signal: AbortSignal.timeout(10_000), headers: { accept: 'application/vnd.github+json' } });
    // Anonymous requests can only see public repos; 404 means private (or gone).
    if (res.status === 404) return false;
    if (!res.ok) return null;
    return (await res.json()).private === false;
  } catch {
    return null;
  }
}

/** Refresh the cached visibility at most once a day. Runs in the daemon, never in a hook. */
export async function refreshVisibility(repo: Repo): Promise<void> {
  const cached = readVisibility(repo);
  if (cached && Date.now() - cached.checkedAt < DAY && cached.public !== null) return;
  const slug = githubSlug(tryGit(repo.root, ['remote', 'get-url', 'origin']) ?? '');
  const isPublic = slug ? ((await viaGh(slug)) ?? (await viaApi(slug))) : null;
  fs.writeFileSync(file(repo), JSON.stringify({ public: isPublic, checkedAt: Date.now() } satisfies Visibility));
}

export const PUBLIC_NOTICE =
  'This repository is PUBLIC, so the shared plan is publicly readable. Never put credentials, personal details, customer names or unfixed security issues in it. (Turn hivemind off for this clone with: hivemind disable)';
