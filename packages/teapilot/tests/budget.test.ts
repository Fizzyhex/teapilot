import { afterEach, expect, it } from 'vitest';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SpendGovernor, lockState } from '../src/inference/budget.js';

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
