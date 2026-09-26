import { afterEach, expect, it } from 'vitest';
import { mkdir, mkdtemp, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { SpendGovernor, StateBusyError, lockState } from '../src/inference/budget.js';

const roots: string[] = [];
afterEach(async () => { for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true }); });
async function directory(): Promise<string> { const root = await mkdtemp(join(tmpdir(), 'teapilot-budget-')); roots.push(root); return root; }

it('persists actual usage across requests and fails closed on missing usage', async () => {
  const path = join(await directory(), 'spend.jsonl');
  const first = new SpendGovernor(path, 'first', { requestUsd: 0.5, dailyUsd: 1 });
  await first.load();
  const id = await first.reserve(0.5, 'economy');
  expect(first.permits(0.01)).toBe(false);
  await first.settle(id, 0.25, 'provider-reported');
  expect(first.permits(0.25)).toBe(true);
  const missing = await first.reserve(0.25, 'economy');
  expect(await first.settle(missing, undefined, 'unknown')).toBe(0.25);
  const second = new SpendGovernor(path, 'second', { requestUsd: 1, dailyUsd: 1 });
  await second.load();
  expect(second.spent()).toEqual({ request: 0, daily: 0.5 });
  await expect(second.reserve(0.500001, 'strong')).rejects.toThrow('limit');
});

it('keeps crash reservations across UTC midnight and resets only settled days', async () => {
  const path = join(await directory(), 'spend.jsonl');
  let now = new Date('2026-09-22T23:59:59Z');
  const first = new SpendGovernor(path, 'first', { requestUsd: 1, dailyUsd: 1 }, () => now);
  await first.reserve(0.4, 'in-flight');
  const settled = await first.reserve(0.4, 'done');
  await first.settle(settled, 0.4, 'reported');
  now = new Date('2026-09-23T00:00:01Z');
  const second = new SpendGovernor(path, 'second', { requestUsd: 1, dailyUsd: 1 }, () => now);
  await second.load();
  expect(second.spent().daily).toBe(0.4);
  expect(second.permits(0.61)).toBe(false);
});

it('refuses concurrent processes and leaves recovery explicit', async () => {
  const root = await directory();
  const unlock = await lockState(root);
  await expect(lockState(root)).rejects.toThrow('Another request');
  await unlock();
  await (await lockState(root))();
});

it('fails closed on corrupted ledger and records excessive provider billing', async () => {
  const path = join(await directory(), 'spend.jsonl');
  const governor = new SpendGovernor(path, 'first', { requestUsd: 1, dailyUsd: 1 });
  const id = await governor.reserve(0.1, 'strong');
  await expect(governor.settle(id, 0.2, 'reported')).rejects.toThrow('ceiling');
  expect(governor.spent().request).toBe(0.2);
  expect(governor.permits(0)).toBe(false);
  await writeFile(path, '{broken');
  await expect(new SpendGovernor(path, 'second', { requestUsd: 1, dailyUsd: 1 }).load()).rejects.toThrow();
});

it('never lets gossip wait for or take a held lock', async () => {
  const root = await directory();
  const unlock = await lockState(root);
  await expect(lockState(root, { gossip: true })).rejects.toBeInstanceOf(StateBusyError);
  await unlock();
  const gossip = await lockState(root, { gossip: true });
  await expect(lockState(root, { gossip: true })).rejects.toBeInstanceOf(StateBusyError);
  await gossip();
  await expect(stat(join(root, 'run.lock'))).rejects.toMatchObject({ code: 'ENOENT' });
});

it('makes a request wait for gossip to release the lock', async () => {
  const root = await directory();
  const gossip = await lockState(root, { gossip: true });
  let acquired = false;
  const pending = lockState(root).then(unlock => { acquired = true; return unlock; });
  // Well past the grace a request gives an unmarked holder.
  await sleep(1000);
  expect(acquired).toBe(false);
  await gossip();
  await (await pending)();
  await expect(stat(join(root, 'run.lock'))).rejects.toMatchObject({ code: 'ENOENT' });
});

it('clears a lock left by gossip in a dead process', async () => {
  const root = await directory();
  await mkdir(join(root, 'run.lock'));
  await writeFile(join(root, 'run.lock', 'teachat.json'), JSON.stringify({ pid: 999999 }));
  const started = Date.now();
  await (await lockState(root, { waitMs: 5000 }))();
  expect(Date.now() - started).toBeLessThan(4000);
});

it('still refuses a second request after a short grace', async () => {
  const root = await directory();
  const unlock = await lockState(root);
  const started = Date.now();
  await expect(lockState(root)).rejects.toThrow('Another request');
  expect(Date.now() - started).toBeGreaterThanOrEqual(400);
  expect(Date.now() - started).toBeLessThan(10_000);
  await unlock();
});

it('totals the day\'s spend by request id prefix', async () => {
  const path = join(await directory(), 'spend.jsonl');
  const limits = { requestUsd: 1, dailyUsd: 1 };
  let now = new Date('2026-09-22T12:00:00Z');
  const governor = async (id: string) => { const value = new SpendGovernor(path, id, limits, () => now); await value.load(); return value; };
  const yesterday = await governor('teachat-old');
  await yesterday.settle(await yesterday.reserve(0.02, 'fast'), 0.02, 'reported');
  now = new Date('2026-09-23T12:00:00Z');
  const today = await governor('teachat-new');
  await today.settle(await today.reserve(0.03, 'fast'), 0.01, 'reported');
  await today.reserve(0.004, 'fast');
  await (await governor('user')).reserve(0.5, 'capable');
  const reader = await governor('reader');
  expect(reader.dailyFor('teachat-')).toBeCloseTo(0.014);
  expect(reader.dailyFor('user')).toBeCloseTo(0.5);
  expect(reader.dailyFor('nobody')).toBe(0);
});
