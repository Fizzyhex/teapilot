import { mkdir, readdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { expect, it, vi } from 'vitest';
import { markBusy, othersBusy, waitUntilQuiet } from '../src/activity.js';
import { deadPid, directory } from './helpers.js';

// Markers from this process count as someone else's when the caller claims another pid.
const otherPid = 1;

it('marks this process busy until released, and never counts its own markers', async () => {
  const dir = await directory();
  expect(await othersBusy(dir)).toBe(false);
  const release = await markBusy(dir);
  const [file] = await readdir(join(dir, 'activity'));
  expect(file).toMatch(new RegExp(`^${process.pid}-[0-9a-f]+\\.json$`));
  expect(JSON.parse(await readFile(join(dir, 'activity', file!), 'utf8'))).toMatchObject({ pid: process.pid });
  expect(await othersBusy(dir)).toBe(false);
  expect(await othersBusy(dir, otherPid)).toBe(true);
  await release();
  await release();
  expect(await othersBusy(dir, otherPid)).toBe(false);
  expect(await readdir(join(dir, 'activity'))).toEqual([]);
});

it('refreshes the heartbeat', async () => {
  const dir = await directory();
  const release = await markBusy(dir, { heartbeatMs: 20 });
  const [file] = await readdir(join(dir, 'activity'));
  const read = async () => JSON.parse(await readFile(join(dir, 'activity', file!), 'utf8')).heartbeat as string;
  const first = await read();
  await vi.waitFor(async () => expect(await read()).not.toBe(first), { timeout: 2000, interval: 10 });
  await release();
});

it('removes markers from dead processes or with a stale heartbeat', async () => {
  const dir = await directory();
  await mkdir(join(dir, 'activity'));
  const old = new Date(Date.now() - 16_000).toISOString();
  await writeFile(join(dir, 'activity', 'dead.json'), JSON.stringify({ pid: deadPid(), since: new Date().toISOString(), heartbeat: new Date().toISOString() }));
  await writeFile(join(dir, 'activity', 'old.json'), JSON.stringify({ pid: process.pid, since: old, heartbeat: old }));
  expect(await othersBusy(dir, otherPid)).toBe(false);
  expect(await readdir(join(dir, 'activity'))).toEqual([]);
});

it('waits for quiet only after seeing busyness, then for the whole grace period', async () => {
  const dir = await directory();
  const onPause = vi.fn();
  const started = Date.now();
  await waitUntilQuiet(dir, { graceMs: 5000, pollMs: 10, selfPid: otherPid, onPause });
  expect(Date.now() - started).toBeLessThan(1000);
  expect(onPause).not.toHaveBeenCalled();

  const release = await markBusy(dir);
  const waiting = waitUntilQuiet(dir, { graceMs: 200, pollMs: 10, selfPid: otherPid, onPause });
  await new Promise(resolve => setTimeout(resolve, 150));
  const freed = Date.now();
  await release();
  await waiting;
  expect(Date.now() - freed).toBeGreaterThanOrEqual(190);
  expect(onPause).toHaveBeenCalledTimes(1);
});

it('restarts the grace period when busyness returns, and rejects with AbortError', async () => {
  const dir = await directory();
  let release = await markBusy(dir);
  let settled = false;
  const waiting = waitUntilQuiet(dir, { graceMs: 250, pollMs: 10, selfPid: otherPid }).finally(() => { settled = true; });
  await new Promise(resolve => setTimeout(resolve, 50));
  await release();
  await new Promise(resolve => setTimeout(resolve, 120));
  release = await markBusy(dir);
  await new Promise(resolve => setTimeout(resolve, 200));
  expect(settled).toBe(false);
  await release();
  await waiting;

  const busy = await markBusy(dir);
  const controller = new AbortController();
  const aborted = waitUntilQuiet(dir, { pollMs: 10, selfPid: otherPid, signal: controller.signal });
  setTimeout(() => controller.abort(), 50);
  await expect(aborted).rejects.toMatchObject({ name: 'AbortError' });
  await busy();
});
