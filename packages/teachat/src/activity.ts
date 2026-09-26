import { randomBytes } from 'node:crypto';
import { mkdir, readdir, rm, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { z } from 'zod';
import { delay, pidAlive, readJson, throwIfAborted, writeJson } from './util.js';

const markerSchema = z.object({ pid: z.number().int().positive(), since: z.string(), heartbeat: z.string() });
export const ACTIVITY_STALE_MS = 15_000;

const activityDir = (dir: string) => join(dir, 'activity');

/**
 * Marks this process busy with user work until the returned release is called. Every teapilot process on the
 * machine sees the marker, so gossip anywhere pauses. The heartbeat timer never keeps the process alive.
 */
export async function markBusy(dir: string, { heartbeatMs = 5000 }: { heartbeatMs?: number } = {}): Promise<() => Promise<void>> {
  await mkdir(activityDir(dir), { recursive: true, mode: 0o700 });
  const file = join(activityDir(dir), `${process.pid}-${randomBytes(6).toString('hex')}.json`);
  const since = new Date().toISOString();
  const beat = () => writeJson(file, { pid: process.pid, since, heartbeat: new Date().toISOString() });
  await beat();
  let released = false;
  let pending: Promise<void> = Promise.resolve();
  // Also recreates the marker if another process removed it while this one was stalled.
  const timer = setInterval(() => { if (!released) pending = beat().catch(() => {}); }, heartbeatMs);
  timer.unref();
  return async () => {
    if (released) return;
    released = true;
    clearInterval(timer);
    await pending;
    await rm(file, { force: true, maxRetries: 5, retryDelay: 20 });
  };
}

/** True while a live marker from another process exists. Markers from dead pids or with a stale heartbeat are removed. */
export async function othersBusy(dir: string, selfPid = process.pid, { staleMs = ACTIVITY_STALE_MS }: { staleMs?: number } = {}): Promise<boolean> {
  let files: string[];
  try { files = (await readdir(activityDir(dir))).filter(file => file.endsWith('.json')); } catch { return false; }
  let busy = false;
  for (const name of files) {
    const file = join(activityDir(dir), name);
    const loaded = await readJson(file, markerSchema).catch(() => undefined);
    if (!loaded) continue;
    if (!loaded.ok) {
      // Markers are written atomically, so an unreadable one is damage, not a write in progress.
      if (!loaded.missing) try { if (Date.now() - (await stat(file)).mtimeMs > staleMs) await rm(file, { force: true }); } catch { /* gone already */ }
      continue;
    }
    const marker = loaded.value;
    if (marker.pid === selfPid) continue;
    const beat = Date.parse(marker.heartbeat);
    if (!pidAlive(marker.pid) || !(Date.now() - beat <= staleMs)) { await rm(file, { force: true }).catch(() => {}); continue; }
    busy = true;
  }
  return busy;
}

/**
 * Resolves once no other process has been busy for `graceMs` straight. If nothing was busy at the first check it
 * resolves at once: the grace only applies after busyness has been seen. `onPause` fires when that first happens.
 */
export async function waitUntilQuiet(dir: string, { graceMs = 30_000, pollMs = 1000, signal, selfPid = process.pid, onPause, staleMs }: {
  graceMs?: number; pollMs?: number; signal?: AbortSignal; selfPid?: number; onPause?: () => void; staleMs?: number;
} = {}): Promise<void> {
  let seen = false;
  let quietSince: number | undefined;
  for (;;) {
    throwIfAborted(signal);
    if (await othersBusy(dir, selfPid, { staleMs })) {
      if (!seen) { seen = true; onPause?.(); }
      quietSince = undefined;
    } else {
      if (!seen) return;
      quietSince ??= Date.now();
      if (Date.now() - quietSince >= graceMs) return;
    }
    await delay(pollMs, signal);
  }
}
