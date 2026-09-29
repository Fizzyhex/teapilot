import { chmodSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { z } from 'zod';
import { replaceFileSync } from '../replace.js';

/** A side answer (/btw): who asked, what, and each message of the answer with the files it carried. */
export interface SideAnswer { userId: string; question: string; parts: Array<{ text: string; files: Array<{ name: string; data: Buffer }> }> }

const saved = z.object({
  userId: z.string(),
  question: z.string(),
  parts: z.array(z.object({ text: z.string(), files: z.array(z.object({ name: z.string(), data: z.string() })) })),
});
/** How many compact answers are kept; the oldest go first. */
const keepLimit = 300;

/**
 * Side answers posted compactly: the channel shows a button, and each click shows the answer to whoever pressed it,
 * so they are kept on disk and outlive a restart. One JSON file per answer, files included.
 */
export class AsideStore {
  constructor(readonly directory: string, private readonly limit = keepLimit) {}

  static at(stateDir: string): AsideStore { return new AsideStore(join(stateDir, 'discord-asides')); }

  private file(id: string): string { return join(this.directory, `${id}.json`); }

  keep(answer: SideAnswer): string {
    const id = randomUUID();
    mkdirSync(this.directory, { recursive: true });
    const file = this.file(id);
    const temporary = `${file}.${randomUUID()}.tmp`;
    const parts = answer.parts.map(part => ({ text: part.text, files: part.files.map(entry => ({ name: entry.name, data: entry.data.toString('base64') })) }));
    writeFileSync(temporary, JSON.stringify({ userId: answer.userId, question: answer.question, parts }), { mode: 0o600 });
    try { chmodSync(temporary, 0o600); } catch { /* not meaningful on every platform */ }
    replaceFileSync(temporary, file);
    this.prune();
    return id;
  }

  find(id: string): SideAnswer | undefined {
    if (!/^[\w-]+$/.test(id)) return undefined;
    try {
      const answer = saved.parse(JSON.parse(readFileSync(this.file(id), 'utf8')));
      return { ...answer, parts: answer.parts.map(part => ({ text: part.text, files: part.files.map(entry => ({ name: entry.name, data: Buffer.from(entry.data, 'base64') })) })) };
    } catch { return undefined; }
  }

  private prune(): void {
    const files = readdirSync(this.directory).filter(name => name.endsWith('.json'))
      .map(name => ({ name, time: statSync(join(this.directory, name)).mtimeMs }))
      .sort((a, b) => b.time - a.time);
    for (const { name } of files.slice(this.limit)) rmSync(join(this.directory, name), { force: true });
  }
}
