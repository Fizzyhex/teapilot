import { randomUUID } from 'node:crypto';
import { mkdir, open, readFile, rmdir } from 'node:fs/promises';
import { join } from 'node:path';
import { z } from 'zod';
import type { ModelConfig } from '../config.js';

export class BudgetError extends Error {}
const entrySchema = z.object({
  id: z.string(), requestId: z.string(), day: z.string(), kind: z.enum(['reserve', 'settle']),
  usd: z.number().finite().nonnegative(), label: z.string(), basis: z.string(),
});
type Entry = z.infer<typeof entrySchema>;
export const callCeiling = (m: ModelConfig): number =>
  (m.contextTokens * m.inputUsdPerMillion + m.maxOutputTokens * m.outputUsdPerMillion) / 1e6;

// One host request at a time per state directory. No stale-lock expiry: an expired
// timer is not proof that another process has stopped spending money.
export async function lockState(directory: string): Promise<() => Promise<void>> {
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const path = join(directory, 'run.lock');
  try { await mkdir(path); } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'EEXIST') {
      throw new Error(`Another request holds ${path}. If its process crashed, remove this empty directory only after verifying it has stopped.`);
    }
    throw error;
  }
  return () => rmdir(path);
}

export class SpendGovernor {
  private entries: Entry[] = [];
  private breached = false;
  constructor(
    readonly path: string, readonly requestId: string,
    readonly limits: { requestUsd: number; dailyUsd: number },
    private readonly now = () => new Date(),
  ) {}
  async load(): Promise<void> {
    let content: string;
    try { content = await readFile(this.path, 'utf8'); }
    catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return; throw error; }
    // Corruption fails closed. Partial writes must never silently reset spend.
    this.entries = content.split('\n').filter(Boolean).map(line => entrySchema.parse(JSON.parse(line)));
    const seen = new Set<string>();
    for (const entry of this.entries) {
      const key = `${entry.kind}:${entry.id}`;
      if (seen.has(key)) throw new BudgetError('Duplicate budget ledger record');
      if (entry.kind === 'settle' && !seen.has(`reserve:${entry.id}`)) throw new BudgetError('Unmatched budget settlement');
      seen.add(key);
    }
  }
  private day(): string { return this.now().toISOString().slice(0, 10); }
  spent(): { request: number; daily: number } {
    const settled = new Map(this.entries.filter(e => e.kind === 'settle').map(e => [e.id, e]));
    let request = 0, daily = 0;
    for (const reserve of this.entries.filter(e => e.kind === 'reserve')) {
      const settlement = settled.get(reserve.id);
      const usd = settlement?.usd ?? reserve.usd;
      if (reserve.requestId === this.requestId) request += usd;
      if (!settlement || reserve.day === this.day() || settlement.day === this.day()) daily += usd;
    }
    return { request, daily };
  }
  permits(usd: number): boolean {
    if (!Number.isFinite(usd) || usd < 0 || this.breached) return false;
    const spent = this.spent();
    return usd <= this.limits.requestUsd - spent.request + 1e-10 && usd <= this.limits.dailyUsd - spent.daily + 1e-10;
  }
  private async append(entry: Entry): Promise<void> {
    const file = await open(this.path, 'a', 0o600);
    try { await file.writeFile(`${JSON.stringify(entry)}\n`); await file.sync(); }
    finally { await file.close(); }
    this.entries.push(entry);
  }
  async reserve(usd: number, label: string): Promise<string> {
    if (!this.permits(usd)) throw new BudgetError('Request or daily spend limit would be exceeded');
    const id = randomUUID();
    await this.append({ id, requestId: this.requestId, day: this.day(), kind: 'reserve', usd, label, basis: 'maximum' });
    return id;
  }
  async settle(id: string, actual: number | undefined, basis: string): Promise<number> {
    const reserve = this.entries.find(e => e.id === id && e.kind === 'reserve');
    if (!reserve || this.entries.some(e => e.id === id && e.kind === 'settle')) throw new BudgetError('Invalid settlement');
    const known = actual !== undefined && Number.isFinite(actual) && actual >= 0;
    const usd = known ? actual : reserve.usd;
    await this.append({ ...reserve, day: this.day(), kind: 'settle', usd, basis: known ? basis : 'unknown-reserved-maximum' });
    if (usd > reserve.usd + 1e-10) {
      this.breached = true;
      throw new BudgetError('Provider charge exceeded configured ceiling; update price limits before another request');
    }
    return usd;
  }
}
