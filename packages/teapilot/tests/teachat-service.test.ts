import { afterEach, expect, it, vi } from 'vitest';
import type { ServerResponse } from 'node:http';
import { mkdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { SEED_IDENTITIES } from 'teachat';
import { TeachatService, type GossipView } from '../src/teachat/service.js';
import { completion, fixture, mockServer } from './helpers.js';

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => { vi.restoreAllMocks(); for (const cleanup of cleanups.splice(0).reverse()) await cleanup(); });

type Kind = 'announce' | 'conclusion' | 'act' | 'summary';
const kindOf = (body: any): Kind | undefined => {
  const text = JSON.stringify(body.messages ?? []);
  return text.includes('what kind of request is this') ? 'announce' : text.includes('Look back on it privately') ? 'conclusion'
    : text.includes('Post with teachat_msg') ? 'act' : text.includes('Summarize what #') ? 'summary' : undefined;
};
const POST = 'tests passed first try, suspicious';
const turn = { user: 'why does my test fail?', assistant: 'A race in the setup.' };

async function setup(options: { dailyUsd?: number; usdPerMillion?: number; intercept?: (kind: Kind, n: number, response: ServerResponse) => boolean } = {}) {
  const f = await fixture(); cleanups.push(f.cleanup);
  const counts: Partial<Record<Kind, number>> = {};
  const server = await mockServer((body, _request, response) => {
    const kind = kindOf(body);
    if (!kind) throw new Error('unexpected request');
    const n = counts[kind] = (counts[kind] ?? 0) + 1;
    if (options.intercept?.(kind, n, response)) return;
    if (kind === 'announce') completion(response, { text: 'a quick question about testing' });
    else if (kind === 'conclusion') completion(response, { text: 'that went fine, honestly.\nSUMMARY: a testing question' });
    else if (kind === 'act') completion(response, body.messages.some((message: any) => message.role === 'tool') ? { text: 'done' } : { tool: { name: 'teachat_msg', arguments: { channel: 'offtopic', text: POST } } });
    else completion(response, { text: 'general chatter' });
  });
  cleanups.push(server.close);
  f.config.routingMode = 'direct';
  const usd = options.usdPerMillion ?? 0;
  for (const model of [f.config.models.fast, f.config.models.capable]) Object.assign(model, { baseUrl: `${server.url}/v1`, inputUsdPerMillion: usd, outputUsdPerMillion: usd });
  const dir = join(f.cwd, 'teachat');
  f.config.teachat = { enabled: true, idleMs: 60_000, dailyUsd: options.dailyUsd ?? 0.05, dir };
  const service = (await TeachatService.open(f.config, { graceMs: 50, pollMs: 20 }))!;
  cleanups.push(() => service.close());
  const lines: Array<[string, string | undefined]> = [];
  const view: GossipView = { line: (text, kind) => { lines.push([text, kind]); }, activity: vi.fn() };
  return { ...f, dir, service, view, lines, counts };
}
const held = () => { let start!: () => void; const started = new Promise<void>(resolve => { start = resolve; }); return { start, started }; };

it('gossips only about finished turns, as the session identity', async () => {
  const { service, view, lines, counts } = await setup();
  expect(service.pending()).toBe(false);
  expect(await service.run(view)).toBe(false);
  expect(counts).toEqual({});
  await service.observe(turn);
  const identity = service.identity()!;
  expect(SEED_IDENTITIES.map(seed => seed.username)).toContain(identity);
  expect(service.pending()).toBe(true);
  expect(await service.run(view)).toBe(true);
  expect(service.pending()).toBe(false);
  const offtopic = await service.room.read('offtopic');
  expect(offtopic.filter(message => message.kind === 'event').map(message => message.text)).toEqual([
    expect.stringMatching(new RegExp(`^teapilot:${identity} is handling a request about "a quick question about testing" @ `)),
    expect.stringMatching(new RegExp(`^teapilot:${identity} completed request "a testing question" @ `)),
  ]);
  expect(offtopic.filter(message => message.kind === 'message').map(message => [message.author, message.text])).toEqual([[identity, POST]]);
  expect(counts).toEqual({ announce: 1, conclusion: 1, act: 2 });
  expect(lines).toEqual(expect.arrayContaining([['that went fine, honestly.', 'thought'], [`teapilot:${identity} → #offtopic: ${POST}`, 'post']]));
  expect(await service.run(view)).toBe(false);
});

it('yields to local work at once, releasing the state lock and keeping the turn for later', async () => {
  const hold = held();
  const { service, view, config, counts } = await setup({ intercept: (kind, n) => { if (kind !== 'announce' || n > 1) return false; hold.start(); return true; } });
  const lock = join(config.stateDir, 'run.lock');
  await service.observe(turn);
  const run = service.run(view);
  await hold.started;
  expect((await stat(lock)).isDirectory()).toBe(true);
  const started = Date.now();
  await service.yield();
  expect(await run).toBe(false);
  expect(Date.now() - started).toBeLessThan(2000);
  await expect(stat(lock)).rejects.toMatchObject({ code: 'ENOENT' });
  expect(service.pending()).toBe(true);
  expect(await service.run(view)).toBe(true);
  expect(counts).toMatchObject({ announce: 2, conclusion: 1 });
});

it('pauses while teapilot works elsewhere and resumes without redoing finished steps', async () => {
  const hold = held();
  const { service, view, lines, counts, dir } = await setup({ intercept: (kind, n) => { if (kind !== 'act' || n > 1) return false; hold.start(); return true; } });
  await service.observe(turn);
  const run = service.run(view);
  await hold.started;
  // Another live process marks itself busy.
  await mkdir(join(dir, 'activity'), { recursive: true });
  const marker = join(dir, 'activity', `${process.ppid}-elsewhere.json`), now = new Date().toISOString();
  await writeFile(marker, JSON.stringify({ pid: process.ppid, since: now, heartbeat: now }));
  await vi.waitFor(() => expect(lines).toContainEqual(['gossip paused - teapilot is busy elsewhere', 'status']), { timeout: 5000, interval: 20 });
  await sleep(200);
  expect(counts.act).toBe(1);
  await rm(marker);
  expect(await run).toBe(true);
  expect(lines).toContainEqual(['gossip resumed', 'status']);
  expect(counts).toEqual({ announce: 1, conclusion: 1, act: 3 });
  const offtopic = await service.room.read('offtopic');
  expect(offtopic.filter(message => message.text.includes('completed request'))).toHaveLength(1);
  expect(offtopic.filter(message => message.kind === 'message')).toHaveLength(1);
});

it('spends only the teachat allowance', async () => {
  const free = await setup({ dailyUsd: 0 });
  await free.service.observe(turn);
  expect(await free.service.run(free.view)).toBe(true);
  const ledger = (await readFile(join(free.config.stateDir, 'spend.jsonl'), 'utf8')).trim().split('\n').map(line => JSON.parse(line));
  expect(ledger.length).toBeGreaterThan(0);
  expect(ledger.every(entry => entry.requestId.startsWith('teachat-') && entry.usd === 0)).toBe(true);
  const priced = await setup({ dailyUsd: 0, usdPerMillion: 1 });
  await priced.service.observe(turn);
  expect(await priced.service.run(priced.view)).toBe(false);
  expect(priced.counts).toEqual({});
  expect(priced.lines).toContainEqual([expect.stringMatching(/^gossip skipped: .*budget/), 'status']);
  expect(priced.service.pending()).toBe(false);
});

it('releases the identity lease on reset', async () => {
  const { service } = await setup();
  await service.observe(turn);
  const identity = service.identity()!;
  const lease = async () => (await service.room.identities()).find(candidate => candidate.username === identity)!.lease;
  expect(service.identities()).toBeUndefined();
  expect(await lease()).toBeDefined();
  await service.reset();
  expect(service.identity()).toBeUndefined();
  expect(await lease()).toBeUndefined();
  expect(service.identities()).toHaveProperty(identity);
  expect(service.pending()).toBe(false);
});

it('mostly plays the identity the routing answer favours', async () => {
  const { service } = await setup();
  const teachatIdentity = { choice: 'oona', probabilities: { oona: 0.9, pip: 0.1 }, confidence: 0.9 };
  const picks: string[] = [];
  // Evenly spread draws stand in for Math.random: epsilon (0.15) takes the lowest three to a uniform pick.
  const draws = 20;
  for (let i = 0; i < draws; i++) {
    const random = vi.spyOn(Math, 'random').mockReturnValue((i + 0.5) / draws);
    try { await service.observe({ ...turn, teachatIdentity }); } finally { random.mockRestore(); }
    picks.push(service.identity()!);
    await service.reset();
  }
  expect(picks.filter(pick => pick === 'oona').length).toBeGreaterThanOrEqual(draws * 0.7);
  expect(picks.every(pick => SEED_IDENTITIES.some(seed => seed.username === pick))).toBe(true);
});

it('gossips by itself once headless work has gone idle, never while work runs', async () => {
  const { service, view, config, counts } = await setup();
  config.teachat!.idleMs = 100;
  service.idle(view);
  let release!: () => void;
  const work = service.work(() => new Promise<void>(resolve => { release = resolve; }));
  // A conversation finishing while another still runs must wait for it.
  await service.observe(turn);
  await sleep(400);
  expect(counts).toEqual({});
  release(); await work;
  await vi.waitFor(() => expect(service.pending()).toBe(false), { timeout: 5000, interval: 50 });
  expect(counts.conclusion).toBe(1);
});
