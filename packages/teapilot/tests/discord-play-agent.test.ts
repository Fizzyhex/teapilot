import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import { latestCode } from '../src/agents/play.js';
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

it('reads "invoker" and mentions inside a participants list, and turns away bad ones before trying the code', async () => {
  const bodies: any[] = [];
  const block = '```js\n' + source + '\n```';
  const steps = [
    { text: block, tool: { name: 'play_start', arguments: { title: 'Counter', participants: ['invoker', 'the other one'] } } },
    { tool: { name: 'play_start', arguments: { title: 'Counter', participants: ['<@222222222222222222>'] } } },
    { text: 'Up for you both.' },
  ];
  const f = await setup((body, _req, res) => { bodies.push(body); completion(res, steps[bodies.length - 1]!); });
  const result = await runAttempt({ ...f, ...f.base, prompt: 'make a counter for me and <@222222222222222222>', activePermissions: ['inference', 'discord.play'],
    play: { runtime: f.runtime, channelId: 'c1', conversation: 'dm:1', owner: { id: '111111111111111111' } } });
  expect(result.success, JSON.stringify(result)).toBe(true);
  expect(JSON.stringify(bodies[1].messages)).toContain('Nothing was started: participants must be');
  expect(JSON.stringify(bodies[2].messages)).toContain('participants: [\\"111111111111111111\\",\\"222222222222222222\\"]');
});

it('gives apps the server emoji people pasted, and points out one an app swaps for a lookalike', async () => {
  const bodies: any[] = [];
  const lookalike = source.replace("'Count '", "'🐟 '");
  const pasted = source.replace("'Count '", "ctx.emoji('cod') + ' '").replace('view: n =>', 'view: (n, ctx) =>');
  const steps = [
    { tool: { name: 'play_start', arguments: { title: 'Cod', source: lookalike } } },
    { tool: { name: 'play_update', arguments: { edits: [{ find: "'🐟 '", replace: "ctx.emoji('cod') + ' '" }, { find: 'view: n =>', replace: 'view: (n, ctx) =>' }] } } },
    { text: 'Done.' },
  ];
  const f = await setup((body, _req, res) => { bodies.push(body); completion(res, steps[bodies.length - 1]!); });
  const result = await runAttempt({ ...f, ...f.base, prompt: 'make a counter that shows <:cod:881267273447407646>', activePermissions: ['inference', 'discord.play'],
    history: [{ user: 'hi <a:wave:726396997648515153>', assistant: 'hello' }],
    play: { runtime: f.runtime, channelId: 'c1', conversation: 'dm:1', owner: { id: '111111111111111111' } } });
  expect(result.success, JSON.stringify(result)).toBe(true);
  expect(JSON.stringify(bodies[1].messages)).toContain('the request pasted <:cod:881267273447407646>, which the app never uses');
  const updated = String(bodies[2].messages.at(-1).content);
  expect(updated).toContain('<:cod:881267273447407646> 0');
  expect(updated).not.toContain('never uses');
  const [app] = f.runtime.list('dm:1');
  expect(f.runtime.source(app!.id, 'dm:1')).toMatchObject({ code: pasted });
});

it('updates the newest app with small edits to its current source', async () => {
  const bodies: any[] = [];
  const steps = [
    { tool: { name: 'play_start', arguments: { title: 'Counter', source } } },
    { tool: { name: 'play_update', arguments: { edits: [{ find: "'Count '", replace: "'Total '" }] } } },
    { tool: { name: 'play_update', arguments: { edits: [{ find: "view: n => ({ content: 'Total ' + n })", replace: 'x' }] } } },
    { text: 'Renamed it.' },
    { tool: { name: 'play_inspect', arguments: {} } },
    { text: 'It counts.' },
  ];
  const f = await setup((body, _req, res) => { bodies.push(body); completion(res, steps[bodies.length - 1]!); });
  const result = await runAttempt({ ...f, ...f.base, prompt: 'make me a counter, then call it a total', activePermissions: ['inference', 'discord.play'],
    play: { runtime: f.runtime, channelId: 'c1', conversation: 'dm:1', owner: { id: '111111111111111111' } } });
  expect(result.success, JSON.stringify(result)).toBe(true);
  expect(JSON.stringify(bodies[2].messages)).toContain('Total 0');
  expect(JSON.stringify(bodies[3].messages)).toContain('occurs 0 times in the current source');
  // A near miss shows the line it was probably meant to copy.
  expect(JSON.stringify(bodies[3].messages)).toMatch(/Closest lines there:(\\)+n2: export default app\(/);
  const [app] = f.runtime.list('dm:1');
  expect(f.runtime.source(app!.id, 'dm:1')).toMatchObject({ code: expect.stringContaining("'Total '") });
  // A later turn without the earlier calls still learns the app from the prompt, and play_inspect shows its code.
  await runAttempt({ ...f, ...f.base, prompt: 'what does it do?', activePermissions: ['inference', 'discord.play'],
    play: { runtime: f.runtime, channelId: 'c1', conversation: 'dm:1', owner: { id: '111111111111111111' } } });
  expect(JSON.stringify(bodies[4].messages)).toContain(`Running here: ${app!.id} \\"Counter\\"`);
  expect(JSON.stringify(bodies[5].messages)).toMatch(/Current source:.*'Total '/);
});

it('takes app code from the code block in the reply, pausing tools until it is written, and leaves it out of the answer', async () => {
  const bodies: any[] = [];
  const block = '```js\n' + source + '\n```';
  const steps = [
    { tool: { name: 'play_start', arguments: { title: 'Counter' } } },
    { text: `Here it is:\n${block}` },
    { tool: { name: 'play_start', arguments: { title: 'Counter' } } },
    { text: `Done:\n${block}\nPress Add.` },
  ];
  const f = await setup((body, _req, res) => { bodies.push(body); completion(res, steps[bodies.length - 1]!); });
  const result = await runAttempt({ ...f, ...f.base, prompt: 'make me a counter', activePermissions: ['inference', 'discord.play'],
    play: { runtime: f.runtime, channelId: 'c1', conversation: 'dm:1', owner: { id: '111111111111111111' } } });
  expect(result.success, JSON.stringify(result)).toBe(true);
  expect(JSON.stringify(bodies[1].messages)).toContain('No app code found: your message had no');
  // Asked for the code with no tools to call instead, then given them back.
  expect(bodies[1].tools ?? []).toEqual([]);
  expect(JSON.stringify(bodies[2].messages)).toContain('Tools are back');
  expect(bodies[2].tools.length).toBeGreaterThan(0);
  expect(bodies[0].tools.find((tool: any) => tool.function.name === 'play_start').function.parameters.properties).not.toHaveProperty('source');
  expect(f.posts).toEqual(['Count 0']);
  expect(result.text).toBe('Done:\n\nPress Add.');
  // The steps keep the block and the call, for the next turn to replay.
  expect(JSON.stringify(result.steps)).toContain('```js');
  expect(result.steps!.filter(step => step.role === 'toolResult')).toHaveLength(2);
});

it('dry-runs the code edits made rather than an older block, and leaves out a source the reply already shows', async () => {
  const bodies: any[] = [];
  const steps = [
    { text: '```js\n' + source + '\n```', tool: { name: 'play_start', arguments: { title: 'Counter' } } },
    { tool: { name: 'play_inspect', arguments: {} } },
    { tool: { name: 'play_update', arguments: { edits: [{ find: "'Count '", replace: "'Total '" }] } } },
    { tool: { name: 'play_test', arguments: { actions: [{ kind: 'button', id: 'add' }] } } },
    { text: 'Done.' },
  ];
  const f = await setup((body, _req, res) => { bodies.push(body); completion(res, steps[bodies.length - 1]!); });
  const result = await runAttempt({ ...f, ...f.base, prompt: 'make me a counter', activePermissions: ['inference', 'discord.play'],
    play: { runtime: f.runtime, channelId: 'c1', conversation: 'dm:1', owner: { id: '111111111111111111' } } });
  expect(result.success, JSON.stringify(result)).toBe(true);
  expect(JSON.stringify(bodies[2].messages)).toContain('Current source: the same as your newest');
  expect(JSON.stringify(bodies[4].messages)).toContain('Total 1');
});

it('answers on the last turn of a play attempt instead of running into the turn limit', async () => {
  const bodies: any[] = [];
  const f = await setup((body, _req, res) => { bodies.push(body); completion(res, body.tools?.length ? { tool: { name: 'play_list', arguments: {} } } : { text: 'Nothing is running yet.' }); });
  f.config.policy.limits.maxTurns = 3;
  const result = await runAttempt({ ...f, ...f.base, prompt: 'what apps are there?', activePermissions: ['inference', 'discord.play'],
    play: { runtime: f.runtime, channelId: 'c1', conversation: 'dm:1', owner: { id: '111111111111111111' } } });
  expect(result.success, JSON.stringify(result)).toBe(true);
  expect(bodies).toHaveLength(3);
  expect(bodies[2].tools ?? []).toEqual([]);
  expect(JSON.stringify(bodies[2].messages)).toContain('This is the last turn, so tools are withdrawn');
});

it('takes app code from thinking only when the reply has none', () => {
  const said = (...content: unknown[]) => ({ role: 'assistant', content }) as never;
  const block = (code: string) => '```js\n' + code + '\n```';
  expect(latestCode([said({ type: 'thinking', thinking: block('thought()') })])).toBe('thought()');
  expect(latestCode([said({ type: 'thinking', thinking: block('thought()') }, { type: 'text', text: block('written()') })])).toBe('written()');
  expect(latestCode([said({ type: 'text', text: block('older()') }), said({ type: 'thinking', thinking: block('newer()') })])).toBe('newer()');
});

it('replays the tool calls of earlier turns, so a follow-up knows the app and its code', async () => {
  const bodies: any[] = [];
  const f = await setup((body, _req, res) => {
    bodies.push(body);
    completion(res, bodies.length === 1 ? { text: '```js\n' + source + '\n```', tool: { name: 'play_start', arguments: { title: 'Counter' } } } : { text: 'Your counter is up.' });
  });
  const play = { runtime: f.runtime, channelId: 'c1', conversation: 'dm:1', owner: { id: '111111111111111111' } };
  const first = await runAttempt({ ...f, ...f.base, prompt: 'make me a counter', activePermissions: ['inference', 'discord.play'], play });
  await runAttempt({ ...f, ...f.base, prompt: 'make it count down', activePermissions: ['inference', 'discord.play'], play,
    history: [{ user: 'make me a counter', assistant: first.text, steps: first.steps }] });
  const replayed = JSON.stringify(bodies[2].messages);
  expect(replayed).toContain('play_start');
  expect(replayed).toMatch(/Started app [a-z0-9]+/);
  expect(replayed).toContain("'Count '");
});

it('returns app mistakes as results to fix, not tool failures', async () => {
  const bodies: any[] = [];
  const f = await setup((body, _req, res) => {
    bodies.push(body);
    completion(res, bodies.length <= 3 ? { tool: { name: 'play_start', arguments: { title: 'Broken', source: 'export default {' } } } : { text: 'Fixed it later.' });
  });
  const result = await runAttempt({ ...f, ...f.base, prompt: 'make me a game', activePermissions: ['inference', 'discord.play'],
    play: { runtime: f.runtime, channelId: 'c1', conversation: 'dm:1' } });
  expect(result.success, JSON.stringify(result)).toBe(true);
  expect(JSON.stringify(bodies[1].messages)).toContain('App problem, nothing was changed');
  // The same code again is turned away without a run, with edits offered; a second time, tools pause until new code is written.
  expect(JSON.stringify(bodies[2].messages)).toContain('the code that was just rejected, unchanged');
  expect(bodies[2].tools.length).toBeGreaterThan(0);
  expect(bodies[3].tools ?? []).toEqual([]);
  expect(f.posts).toEqual([]);
});

it('fixes a rejected app with edits instead of a rewrite, and only after code was tried', async () => {
  const bodies: any[] = [];
  const broken = source.replace("button('add', 'Add')", "button('add', 'Add'), button('again', '')");
  const steps = [
    { tool: { name: 'play_start', arguments: { title: 'Counter', edits: [{ find: 'x', replace: 'y' }] } } },
    { text: '```js\n' + broken + '\n```', tool: { name: 'play_start', arguments: { title: 'Counter' } } },
    { tool: { name: 'play_start', arguments: { edits: [{ find: ", button('again', '')", replace: '' }] } } },
    { text: 'Your counter is up.' },
  ];
  const f = await setup((body, _req, res) => { bodies.push(body); completion(res, steps[bodies.length - 1]!); });
  const result = await runAttempt({ ...f, ...f.base, prompt: 'make me a counter', activePermissions: ['inference', 'discord.play'],
    play: { runtime: f.runtime, channelId: 'c1', conversation: 'dm:1', owner: { id: '111111111111111111' } } });
  expect(result.success, JSON.stringify(result)).toBe(true);
  expect(JSON.stringify(bodies[1].messages)).toContain('No earlier app code to edit yet');
  expect(JSON.stringify(bodies[2].messages)).toContain('A button needs a label or an emoji');
  expect(JSON.stringify(bodies[3].messages)).toMatch(/Started app [a-z0-9]+/);
  expect(f.posts).toEqual(['Count 0']);
});

it('resends the newest app shown in the channel, even one another conversation started', async () => {
  const bodies: any[] = [];
  const f = await setup((body, _req, res) => {
    bodies.push(body);
    completion(res, bodies.length === 1 ? { tool: { name: 'play_resend', arguments: {} } } : { text: 'Here it is again.' });
  });
  const { record } = await f.runtime.start({ title: 'Counter', channelId: 'c1', conversation: 'dm:1', owner: { id: '111111111111111111' }, source: { kind: 'sandbox', code: source } });
  const result = await runAttempt({ ...f, ...f.base, prompt: 'resend the game, it got buried', activePermissions: ['inference', 'discord.play'],
    play: { runtime: f.runtime, channelId: 'c1', conversation: 'dm:2', owner: { id: '222222222222222222' } } });
  expect(result.success, JSON.stringify(result)).toBe(true);
  expect(names(bodies[0])).toContain('play_resend');
  expect(JSON.stringify(bodies[0].messages)).toContain(`Running here: ${record.id}`);
  expect(JSON.stringify(bodies[1].messages)).toContain(`Resent app ${record.id}.`);
  expect(f.posts).toEqual(['Count 0', 'Count 0']);
});

it('refuses apps where teapilot has nowhere to post them', async () => {
  const bodies: any[] = [];
  const f = await setup((body, _req, res) => {
    bodies.push(body);
    completion(res, bodies.length === 1 ? { tool: { name: 'play_start', arguments: { title: 'Counter', source } } } : { text: 'Cannot here.' });
  });
  await runAttempt({ ...f, ...f.base, prompt: 'make me a counter', activePermissions: ['inference', 'discord.play'], play: { runtime: f.runtime, conversation: 'reply:1' } });
  expect(JSON.stringify(bodies[1].messages)).toContain('nowhere to post them');
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
