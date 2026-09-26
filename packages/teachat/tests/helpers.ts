import { spawnSync } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach } from 'vitest';

const roots: string[] = [];
afterEach(async () => { for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 }); });

export async function directory(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'teachat-'));
  roots.push(root);
  return root;
}

/** A pid that belonged to a process that has since exited. */
export const deadPid = (): number => spawnSync(process.execPath, ['-e', '']).pid!;

/** mulberry32: a seeded rng so sampling tests are repeatable. */
export function seeded(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export const clock = (start = Date.parse('2026-09-26T12:00:00Z')) => {
  const state = { now: start };
  return Object.assign(() => state.now, { advance: (ms: number) => { state.now += ms; }, state });
};
