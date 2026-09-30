import { chmodSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { z } from 'zod';
import { permissions, type SavedGrants } from '../execution/grants.js';
import { replaceFileSync } from '../replace.js';

const saved = z.object({ root: z.string(), granted: z.array(z.enum(permissions as [SavedGrants['granted'][number], ...SavedGrants['granted']])) });

/**
 * Each Discord conversation's access, by history key, so what was granted lasts as long as the conversation does
 * instead of until teapilot restarts. Only teapilot writes these files; each is checked against the policy when loaded.
 */
export class GrantStore {
  constructor(readonly directory: string) {}

  static at(stateDir: string): GrantStore { return new GrantStore(join(stateDir, 'discord-grants')); }

  private file(key: string): string { return join(this.directory, `${key.replace(/[^\w-]/g, '_')}.json`); }

  load(key: string): SavedGrants | undefined {
    try { return saved.parse(JSON.parse(readFileSync(this.file(key), 'utf8'))); }
    catch { return undefined; }
  }

  /** Saves `grants` under `key`, or forgets them when undefined. */
  save(key: string, grants: SavedGrants | undefined): void {
    const file = this.file(key);
    if (!grants) { rmSync(file, { force: true }); return; }
    mkdirSync(this.directory, { recursive: true });
    const temporary = `${file}.${randomUUID()}.tmp`;
    writeFileSync(temporary, JSON.stringify(grants), { mode: 0o600 });
    try { chmodSync(temporary, 0o600); } catch { /* not meaningful on every platform */ }
    replaceFileSync(temporary, file);
  }
}
