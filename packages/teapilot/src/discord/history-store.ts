import { chmodSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { z } from 'zod';
import type { ConversationTurn } from '../integration/events.js';
import { replaceFileSync } from '../replace.js';

// Steps are pi messages written by teapilot itself; only their outline is checked here.
const turns = z.array(z.object({ user: z.string(), assistant: z.string(), taskId: z.string().max(100).optional(), steps: z.array(z.object({ role: z.enum(['assistant', 'toolResult']) }).passthrough()).optional(),
  stopped: z.object({ status: z.string(), failedCalls: z.array(z.object({ call: z.string(), error: z.string() })).optional() }).optional() }));

/**
 * Each Discord conversation's turns, tool steps included, so a restart continues the conversation where it
 * was instead of starting it over. One JSON file per conversation, removed when the conversation is cleared.
 */
export class HistoryStore {
  constructor(readonly directory: string) {}

  static at(stateDir: string): HistoryStore { return new HistoryStore(join(stateDir, 'discord-history')); }

  private file(key: string): string { return join(this.directory, `${key.replace(/[^\w-]/g, '_')}.json`); }

  load(key: string): ConversationTurn[] {
    try { return turns.parse(JSON.parse(readFileSync(this.file(key), 'utf8'))) as ConversationTurn[]; }
    catch { return []; }
  }

  save(key: string, history: ConversationTurn[]): void {
    const file = this.file(key);
    if (!history.length) { rmSync(file, { force: true }); return; }
    mkdirSync(this.directory, { recursive: true });
    const temporary = `${file}.${randomUUID()}.tmp`;
    writeFileSync(temporary, JSON.stringify(history), { mode: 0o600 });
    try { chmodSync(temporary, 0o600); } catch { /* not meaningful on every platform */ }
    replaceFileSync(temporary, file);
  }
}
