import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import { runAttempt } from '../src/agents/run.js';
import { SessionGrants } from '../src/execution/grants.js';
import { runHost } from '../src/host.js';
import { PlayRuntime, type PlaySurface } from '../src/discord/play/runtime.js';
import { PlayStore } from '../src/discord/play/store.js';
import { SpendGovernor } from '../src/inference/budget.js';
import { Telemetry } from '../src/telemetry/outcome.js';
import { completion, fixture, jev, mockServer } from './helpers.js';

const cleanups: Array<() => unknown> = [];
afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup(); });

const source = `import { app, button, row } from '@teapilot/discord-play';
export default app({ init: () => 0, update: n => n + 1, view: n => ({ content: 'Count ' + n, rows: [row(button('add', 'Add'))] }) });`;

async function setup(handler: Parameters<typeof mockServer>[0]) {
  const f = await fixture(); cleanups.push(f.cleanup);
  const server = await mockServer(handler); cleanups.push(server.close);
  Object.assign(f.config.models.capable, { provider: 'ollama', baseUrl: server.url });
  const telemetry = new Telemetry(f.config.stateDir, 'play-test');
  await telemetry.event('start', {});
  const budget = new SpendGovernor(join(f.config.stateDir, 'spend.jsonl'), 'play-test', f.config.policy.budget);
  const directory = await mkdtemp(join(tmpdir(), 'teapilot-play-agent-'));
  cleanups.push(() => rm(directory, { recursive: true, force: true }));
  const posts: string[] = [];
  const surface: PlaySurface = { post: vi.fn(async (_channel, payload) => { posts.push(payload.content); return 'm1'; }), edit: vi.fn(async () => undefined), request: vi.fn() };
  const runtime = new PlayRuntime({ store: new PlayStore(directory), surface, log: vi.fn() });
  cleanups.push(() => runtime.close());
  return { ...f, budget, telemetry, runtime, posts, base: { tier: 'normal' as const, workload: 'ask' as const, web: false, approve: async () => true } };
}
const names = (body: any): string[] => (body.tools ?? []).map((tool: any) => tool.function.name);

it('gives the play tools to a Discord conversation holding discord.play, and starts apps with them', async () => {
  const bodies: any[] = [];
  const f = await setup((body, _req, res) => {
    bodies.push(body);
    completion(res, bodies.length === 1 ? { tool: { name: 'play_start', arguments: { title: 'Counter', source } } } : { text: 'Your counter is up.' });
  });
  const result = await runAttempt({ ...f, ...f.base, prompt: 'make me a counter', activePermissions: ['inference', 'discord.play'],
    play: { runtime: f.runtime, channelId: 'c1', conversation: 'dm:1', owner: { id: '111111111111111111' } } });
  expect(result.success, JSON.stringify(result)).toBe(true);
  expect(names(bodies[0])).toEqual(expect.arrayContaining(['play_start', 'play_update', 'play_test', 'play_inspect', 'play_list', 'play_stop']));
  expect(JSON.stringify(bodies[0].messages)).toContain('`discord.play` is active');
  expect(f.posts).toEqual(['Count 0']);
  expect(JSON.stringify(bodies[1].messages)).toMatch(/Started app [a-z0-9]+ \(anyone can play\)/);
  expect(f.runtime.list('dm:1')).toHaveLength(1);
});

it('returns app mistakes as results to fix, not tool failures', async () => {
  const bodies: any[] = [];
  const f = await setup((body, _req, res) => {
    bodies.push(body);
    completion(res, bodies.length <= 2 ? { tool: { name: 'play_start', arguments: { title: 'Broken', source: 'export default {' } } } : { text: 'Fixed it later.' });
  });
  const result = await runAttempt({ ...f, ...f.base, prompt: 'make me a game', activePermissions: ['inference', 'discord.play'],
    play: { runtime: f.runtime, channelId: 'c1', conversation: 'dm:1' } });
  expect(result.success, JSON.stringify(result)).toBe(true);
  expect(JSON.stringify(bodies[1].messages)).toContain('App problem, nothing was changed');
  expect(f.posts).toEqual([]);
});

it('refuses apps where teapilot cannot keep a message alive', async () => {
  const bodies: any[] = [];
  const f = await setup((body, _req, res) => {
    bodies.push(body);
    completion(res, bodies.length === 1 ? { tool: { name: 'play_start', arguments: { title: 'Counter', source } } } : { text: 'Cannot here.' });
  });
  await runAttempt({ ...f, ...f.base, prompt: 'make me a counter', activePermissions: ['inference', 'discord.play'], play: { runtime: f.runtime, conversation: 'reply:1' } });
  expect(JSON.stringify(bodies[1].messages)).toContain('short-lived interaction');
  expect(f.posts).toEqual([]);
});

it('lets only Discord conversations request discord.play, and hides the tools until it is active', async () => {
  const bodies: any[] = [];
  const f = await setup((body, _req, res) => { bodies.push(body); completion(res, { text: 'hi' }); });
  const requestCapabilities = vi.fn(async () => false);
  await runAttempt({ ...f, ...f.base, prompt: 'hello', activePermissions: ['inference'], requestCapabilities, play: { runtime: f.runtime, channelId: 'c1', conversation: 'dm:1' } });
  await runAttempt({ ...f, ...f.base, prompt: 'hello', activePermissions: ['inference'], requestCapabilities });
  const [discord, terminal] = bodies.map(body => body.tools.find((tool: any) => tool.function.name === 'request_capabilities'));
  expect(names(bodies[0]).some(name => name.startsWith('play_'))).toBe(false);
  expect(JSON.stringify(discord)).toContain('discord.play');
  expect(JSON.stringify(bodies[0].messages)).toContain('request `discord.play`');
  expect(JSON.stringify(terminal)).not.toContain('discord.play');
  expect(JSON.stringify(bodies[1].messages)).not.toContain('discord.play');
});

it('asks the router about discord.play only in Discord, activates it without a prompt, and keeps it for later turns', async () => {
  const questions: any[] = [];
  const tools: string[][] = [];
  const f = await setup((body, req, res) => {
    if (req.url === '/jev') {
      questions.push(body.questions);
      // Only the first routing call says the request wants an app.
      const end = res.end.bind(res);
      res.end = ((chunk: string) => { const raw = JSON.parse(chunk); if (body.questions['discord.play'] && questions.length === 1) raw.answers['discord.play'] = { type: 'choice', choice: 'yes', probabilities: { yes: 1 }, confidence: 0.99 }; return end(JSON.stringify(raw)); }) as typeof res.end;
      jev(res, 'ask.normal');
    } else if (req.url?.endsWith('/models')) res.end('{}');
    else { tools.push(names(body)); completion(res, { text: 'ok' }); }
  });
  f.config.router.endpoint = `${new URL(f.config.models.capable.baseUrl!).origin}/jev`;
  f.config.models.fast.baseUrl = f.config.models.capable.baseUrl;
  const grants = await SessionGrants.create(f.cwd, f.config, 'chat');
  grants.setCaller(() => ({ permissions: ['inference', 'web.search', 'discord.play'], preapproved: ['web.search', 'discord.play'] }));
  const approve = vi.fn(async () => false);
  const play = { runtime: f.runtime, channelId: 'c1', conversation: 'dm:1' };
  const request = { cwd: f.cwd, mode: 'chat' as const, authorization: grants };
  expect((await runHost(f.config, { ...request, prompt: 'lets play tic tac toe', play }, { approve, localProbe: async () => true })).success).toBe(true);
  expect(questions[0]['discord.play']).toMatchObject({ type: 'choice' });
  expect(tools[0]).toContain('play_start');
  expect((await runHost(f.config, { ...request, prompt: 'make it 4x4', play }, { approve, localProbe: async () => true })).success).toBe(true);
  expect(tools[1]).toContain('play_start');
  expect((await runHost(f.config, { ...request, prompt: 'hello' }, { approve, localProbe: async () => true })).success).toBe(true);
  expect(questions[2]['discord.play']).toBeUndefined();
  expect(tools[2]).not.toContain('play_start');
  expect(approve).not.toHaveBeenCalled();
});
