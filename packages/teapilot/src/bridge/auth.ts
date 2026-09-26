import { randomBytes, timingSafeEqual } from 'node:crypto';
import { chmod, mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';

export const tokenPath = (stateDir: string) => join(stateDir, 'bridge-token');

/**
 * The bridge token is equivalent to operator access: whoever holds it can approve actions on the host.
 * It lives in the state directory, is created on first use, and is only ever shown when created.
 */
export async function loadToken(stateDir: string, rotate = false): Promise<{ token: string; created: boolean }> {
  const path = tokenPath(stateDir);
  if (!rotate) {
    const existing = (await readFile(path, 'utf8').catch(() => '')).trim();
    if (/^[A-Za-z0-9_-]{43}$/.test(existing)) return { token: existing, created: false };
  }
  const token = randomBytes(32).toString('base64url');
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, token + '\n', { mode: 0o600 });
  await chmod(path, 0o600).catch(() => undefined);
  return { token, created: true };
}

export function tokenMatches(expected: string, offered: string | undefined): boolean {
  const a = Buffer.from(expected), b = Buffer.from(offered ?? '');
  // Tokens have a fixed length, so the length check reveals nothing.
  return a.length === b.length && timingSafeEqual(a, b);
}

/** Refuses further attempts for a while once too many wrong tokens arrive. */
export class FailureLimiter {
  private failures: number[] = [];
  constructor(private readonly limit = 5, private readonly windowMs = 60_000, private readonly now = Date.now) {}
  blocked(): boolean { this.prune(); return this.failures.length >= this.limit; }
  fail(): void { this.prune(); this.failures.push(this.now()); }
  private prune() { const cutoff = this.now() - this.windowMs; this.failures = this.failures.filter(time => time > cutoff); }
}

export const bearer = (header: string | string[] | undefined): string | undefined => {
  const value = Array.isArray(header) ? header[0] : header;
  return value?.match(/^Bearer (\S+)$/)?.[1];
};
