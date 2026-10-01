import { chmodSync, copyFileSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { z } from 'zod';
import type { View } from '@teapilot/discord-play';
import { replaceFileSync } from '../../replace.js';

const user = z.object({ id: z.string(), name: z.string().optional() });
const recordSchema = z.object({
  id: z.string().regex(/^[a-z0-9]{1,16}$/), title: z.string(),
  owner: user, channelId: z.string(), messageId: z.string().optional(), conversation: z.string(),
  /** Posted as the reply to an interaction, where teapilot cannot post in the channel; edited through interactions only. */
  viaInteraction: z.boolean().optional(),
  participants: z.union([z.literal('everyone'), z.literal('invoker'), z.array(z.string())]),
  source: z.discriminatedUnion('kind', [
    z.object({ kind: z.literal('sandbox'), code: z.string(), assets: z.record(z.string(), z.string()).optional() }),
    z.object({ kind: z.literal('trusted'), path: z.string(), sha256: z.string() }),
  ]),
  state: z.unknown(), seed: z.number(), view: z.custom<View>(value => typeof value === 'object' && value !== null),
  emojis: z.record(z.string(), z.string()),
  /** `ms` is how much longer the timer must wait; `dueAt` is set only while the app is awake, so a hibernating one costs nothing. */
  timers: z.array(z.object({ id: z.string(), ms: z.number().optional(), dueAt: z.number().optional() })),
  /** When each recent consult started, for the hourly cap. */
  consults: z.array(z.number()),
  status: z.enum(['running', 'finished', 'paused']),
  /** The workspace file the app runs from, which play_update reloads. */
  file: z.string().optional(),
  /** Logical asset names to workspace files or repository paths, used only when explicitly reloading. */
  assetFiles: z.record(z.string(), z.string()).optional(),
  note: z.string().optional(),
  log: z.array(z.object({ at: z.number(), action: z.string(), error: z.string().optional() })),
  createdAt: z.number(), updatedAt: z.number(),
});
export type PlayRecord = z.infer<typeof recordSchema>;

/**
 * One JSON file per app under the state directory, written through a temporary file so a crash never
 * leaves half a record. The bot is the only writer. An unreadable file is set aside, not deleted.
 */
export class PlayStore {
  constructor(readonly directory: string) {}

  static at(stateDir: string): PlayStore { return new PlayStore(join(stateDir, 'discord-play')); }

  save(record: PlayRecord): void {
    mkdirSync(this.directory, { recursive: true });
    const file = join(this.directory, `${record.id}.json`);
    const temporary = `${file}.${randomUUID()}.tmp`;
    writeFileSync(temporary, JSON.stringify(record), { mode: 0o600 });
    try { chmodSync(temporary, 0o600); } catch { /* not meaningful on every platform */ }
    replaceFileSync(temporary, file);
  }

  all(): PlayRecord[] {
    let names: string[];
    try { names = readdirSync(this.directory).filter(name => /^[a-z0-9]{1,16}\.json$/.test(name)); }
    catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return []; throw error; }
    const records: PlayRecord[] = [];
    for (const name of names) {
      const file = join(this.directory, name);
      try { records.push(recordSchema.parse(JSON.parse(readFileSync(file, 'utf8')))); }
      catch { try { copyFileSync(file, `${file}.corrupt`); rmSync(file); } catch { /* best effort */ } }
    }
    return records;
  }

  remove(id: string): void { rmSync(join(this.directory, `${id}.json`), { force: true }); }
}
