/**
 * Plan entries are pushed to the team's git remote (public, for public repos).
 * Scrub anything that looks like a credential before it's written. Defense in depth:
 * agents and the extractor are also told never to include secrets.
 */
const PATTERNS: [RegExp, string | ((m: string, ...g: string[]) => string)][] = [
  [/-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?(?:-----END [A-Z ]*PRIVATE KEY-----|$)/g, '[redacted private key]'],
  [/\b(?:sk|pk|rk)[-_](?:ant[-_]|proj[-_]|live[-_]|test[-_])?[A-Za-z0-9_-]{16,}/g, '[redacted]'],
  [/\bgh[pousr]_[A-Za-z0-9]{30,}/g, '[redacted]'],
  [/\bgithub_pat_[A-Za-z0-9_]{30,}/g, '[redacted]'],
  [/\bnpm_[A-Za-z0-9]{30,}/g, '[redacted]'],
  [/\bAKIA[0-9A-Z]{16}\b/g, '[redacted]'],
  [/\bxox[abprs]-[A-Za-z0-9-]{10,}/g, '[redacted]'],
  [/\bAIza[0-9A-Za-z_-]{35}\b/g, '[redacted]'],
  [/\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/g, '[redacted jwt]'],
  // user:password@host in connection strings: keep the shape, drop the password
  [/\b([a-z][a-z0-9+.-]*:\/\/[^\s:@/]+):[^\s@/]+@/gi, (_m, prefix) => `${prefix}:[redacted]@`],
  // password = "…", api_key: …, secret=…
  [/\b((?:password|passwd|pwd|secret|api[_-]?key|access[_-]?token|auth[_-]?token|client[_-]?secret)\s*[:=]\s*)["']?[^\s"',;}]{6,}["']?/gi, (_m, key) => `${key}[redacted]`],
];

export function redact(text: string): string {
  let out = text;
  for (const [re, rep] of PATTERNS) out = out.replace(re, rep as any);
  return out;
}

export function redactDeep<T>(value: T): T {
  if (typeof value === 'string') return redact(value) as T;
  if (Array.isArray(value)) return value.map(redactDeep) as T;
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, redactDeep(v)])) as T;
  return value;
}
