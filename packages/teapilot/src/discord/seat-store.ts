import { chmodSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { dirname, join } from 'node:path';
import { z } from 'zod';
import { tierPreferences } from '../config.js';
import { modes } from '../execution/grants.js';
import type { PromptSetup } from './commands.js';

/** Your own conversation in a channel, or the one everyone there shares. */
export type Seat = 'solo' | 'collab';

const fileSchema = z.object({
  /** By `channelId:userId`. */
  seats: z.record(z.string(), z.enum(['solo', 'collab'])),
  /** The mode and tier last chosen for each history, reused when a later /prompt or /collab leaves them out. */
  setups: z.record(z.string(), z.object({ mode: z.enum(modes).optional(), tier: z.enum(tierPreferences).optional() }).strict()),
});
type Data = z.infer<typeof fileSchema>;

/**
 * Where teapilot answers through interactions, which conversation each person is in, per channel: their own
 * or the channel's collab, never both. Kept on disk so a restart does not put anyone in both.
 */
export class SeatStore {
  private data?: Data;
  constructor(readonly file: string) {}

  static at(stateDir: string): SeatStore { return new SeatStore(join(stateDir, 'discord-seats.json')); }

  private load(): Data {
    if (this.data) return this.data;
    try { this.data = fileSchema.parse(JSON.parse(readFileSync(this.file, 'utf8'))); }
    catch { this.data = { seats: {}, setups: {} }; }
    return this.data;
  }

  private save(): void {
    mkdirSync(dirname(this.file), { recursive: true });
    const temporary = `${this.file}.${randomUUID()}.tmp`;
    writeFileSync(temporary, JSON.stringify(this.load()), { mode: 0o600 });
    try { chmodSync(temporary, 0o600); } catch { /* not meaningful on every platform */ }
    renameSync(temporary, this.file);
  }

  seat(channelId: string, userId: string): Seat | undefined { return this.load().seats[`${channelId}:${userId}`]; }

  sit(channelId: string, userId: string, seat: Seat | undefined): void {
    const seats = this.load().seats;
    if (seat) seats[`${channelId}:${userId}`] = seat; else delete seats[`${channelId}:${userId}`];
    this.save();
  }

  /** How many people are in the channel's collab. */
  collaborators(channelId: string): number {
    return Object.entries(this.load().seats).filter(([key, seat]) => seat === 'collab' && key.startsWith(`${channelId}:`)).length;
  }

  setup(historyKey: string): PromptSetup { return this.load().setups[historyKey] ?? {}; }

  /** Merges `setup` into what `historyKey` had, or forgets it when `setup` is undefined. */
  remember(historyKey: string, setup: PromptSetup | undefined): PromptSetup {
    const setups = this.load().setups;
    if (!setup) { delete setups[historyKey]; this.save(); return {}; }
    const merged = { ...setups[historyKey], ...setup };
    setups[historyKey] = merged;
    this.save();
    return merged;
  }
}
