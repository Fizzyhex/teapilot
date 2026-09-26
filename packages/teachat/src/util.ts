import { randomUUID } from 'node:crypto';
import { chmod, open, readFile, rename, rm } from 'node:fs/promises';
import type { z } from 'zod';

export class AbortError extends Error {
  override name = 'AbortError';
  constructor(message = 'The operation was aborted.', options?: ErrorOptions) { super(message, options); }
}

export const isAbortError = (error: unknown): boolean => error instanceof Error && error.name === 'AbortError';

export function throwIfAborted(signal?: AbortSignal): void {
  if (signal?.aborted) throw new AbortError(undefined, { cause: signal.reason });
}

/** A timer that fake timers can drive; rejects with AbortError when the signal fires. */
export function delay(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(new AbortError(undefined, { cause: signal.reason }));
    const onAbort = () => { clearTimeout(timer); reject(new AbortError(undefined, { cause: signal?.reason })); };
    const timer = setTimeout(() => { signal?.removeEventListener('abort', onAbort); resolve(); }, ms);
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}

export const errorCode = (error: unknown): string | undefined => (error as NodeJS.ErrnoException | undefined)?.code;

/** `kill(pid, 0)` probes without signalling; EPERM means it exists but belongs to someone else. */
export function pidAlive(pid: number): boolean {
  try { process.kill(pid, 0); return true; } catch (error) { return errorCode(error) === 'EPERM'; }
}

// Windows reports a transient EPERM/EACCES/EBUSY while another process (or a scanner) has the target open.
const transient = new Set(['EPERM', 'EACCES', 'EBUSY']);
export async function renameRetry(from: string, to: string): Promise<void> {
  for (let attempt = 0; ; attempt++) {
    try { return await rename(from, to); } catch (error) {
      if (attempt >= 10 || !transient.has(errorCode(error) ?? '')) throw error;
      await delay(10 + attempt * 10);
    }
  }
}

/** Temp file, fsync, then rename, so readers only ever see a whole file. */
export async function writeAtomic(file: string, content: string): Promise<void> {
  const temporary = `${file}.${randomUUID()}.tmp`;
  try {
    const handle = await open(temporary, 'w', 0o600);
    try { await handle.writeFile(content); await handle.sync(); } finally { await handle.close(); }
    try { await chmod(temporary, 0o600); } catch { /* not meaningful on every platform */ }
    await renameRetry(temporary, file);
  } catch (error) { await rm(temporary, { force: true }).catch(() => {}); throw error; }
}

export const writeJson = (file: string, data: unknown): Promise<void> => writeAtomic(file, `${JSON.stringify(data, null, 2)}\n`);

export async function appendLines(file: string, lines: string[]): Promise<void> {
  if (!lines.length) return;
  const handle = await open(file, 'a', 0o600);
  try { await handle.writeFile(lines.map(line => `${line}\n`).join('')); await handle.sync(); } finally { await handle.close(); }
}

/** Undefined when the file does not exist. Windows refuses to open a file that is being deleted or replaced, so that is retried. */
export async function readText(file: string): Promise<string | undefined> {
  for (let attempt = 0; ; attempt++) {
    try { return await readFile(file, 'utf8'); } catch (error) {
      if (errorCode(error) === 'ENOENT') return undefined;
      if (attempt >= 5 || !transient.has(errorCode(error) ?? '')) throw error;
      await delay(10 + attempt * 10);
    }
  }
}

export type Loaded<T> = { ok: true; value: T } | { ok: false; missing: boolean };
/** Fails closed: anything unreadable or off-schema is reported, never half-used. */
export async function readJson<T>(file: string, schema: z.ZodType<T>): Promise<Loaded<T>> {
  const text = await readText(file);
  if (text === undefined) return { ok: false, missing: true };
  try { return { ok: true, value: schema.parse(JSON.parse(text)) }; } catch { return { ok: false, missing: false }; }
}

/** Parses a JSONL file, skipping lines that are torn or off-schema. */
export async function readJsonl<T>(file: string, schema: z.ZodType<T>): Promise<T[]> {
  const text = await readText(file);
  if (text === undefined) return [];
  const out: T[] = [];
  for (const line of text.split('\n')) {
    if (!line.trim()) continue;
    try { const parsed = schema.safeParse(JSON.parse(line)); if (parsed.success) out.push(parsed.data); } catch { /* torn line */ }
  }
  return out;
}

/** Keeps a damaged file for inspection before it is reseeded. */
export async function moveAside(file: string, now = Date.now()): Promise<void> {
  try { await renameRetry(file, `${file}.corrupt-${now}`); } catch { /* best effort */ }
}

/** Flattens whitespace and trims to `limit` characters, at a word boundary when one is near. */
export function clip(text: string, limit: number): string {
  const flat = text.trim().replace(/\s+/g, ' ');
  if (flat.length <= limit) return flat;
  const cut = flat.slice(0, limit - 1);
  const space = cut.lastIndexOf(' ');
  return `${(space > limit / 2 ? cut.slice(0, space) : cut).replace(/[\s.,;:!?-]+$/, '')}…`;
}

export const toMs =(value: number | Date | string): number => typeof value === 'number' ? value : typeof value === 'string' ? Date.parse(value) : value.getTime();
