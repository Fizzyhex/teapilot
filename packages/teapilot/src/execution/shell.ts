import { getShellConfig } from '@earendil-works/pi-coding-agent';

/** Where Git for Windows comes from, for messages that say it is missing. */
export const gitForWindows = 'https://git-scm.com/download/win';

// getShellConfig() looks in Program Files, then shells out to `where.exe`; cache the answer for the process lifetime
// so the prompt and every session cost one bounded scan.
let resolved: { path?: string } | undefined;

/**
 * The bash every shell tool runs: Git Bash on Windows, as pi's bash tool finds it, and the system's elsewhere.
 * Undefined on Windows without it; WSL's System32 bash.exe does not count, since it runs in another file system.
 */
export function gitBash(): string | undefined {
  if (!resolved) {
    try {
      const { shell } = getShellConfig();
      resolved = { path: process.platform === 'win32' && /[\\/]windows[\\/](?:system32|sysnative)[\\/]bash\.exe$/i.test(shell) ? undefined : shell };
    } catch { resolved = {}; }
  }
  return resolved.path;
}

/** Tests only: forget the cached bash. */
export function resetGitBash(): void { resolved = undefined; }

/** A value as one POSIX shell word. */
export const shellQuote = (value: string) => `'${value.replace(/'/g, `'\\''`)}'`;

/** A Windows path as MSYS spells it (C:\a\b → /c/a/b), for PATH inside Git Bash; other paths are returned as they are. */
export function msysPath(path: string): string {
  const drive = /^([A-Za-z]):[\\/]?(.*)$/.exec(path);
  return drive ? `/${drive[1]!.toLowerCase()}/${drive[2]!.replace(/\\/g, '/')}`.replace(/\/$/, '') || '/' : path.replace(/\\/g, '/');
}
