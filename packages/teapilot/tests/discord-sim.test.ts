import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, expect, it, vi } from 'vitest';
import { serveDiscord } from '../src/discord/index.js';
import { PlayRuntime } from '../src/discord/play/runtime.js';
import { PlayStore } from '../src/discord/play/store.js';
import { SkippableClock } from '../scripts/discord-sim/clock.js';
import { checkMessage, checkModal, DiscordRejected } from '../scripts/discord-sim/validate.js';
import { channelId, people, SimError, World } from '../scripts/discord-sim/world.js';
import { completion, fixture, jev, mockServer } from './helpers.js';

const cleanups: Array<() => unknown> = [];
afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup(); });
const root = fileURLToPath(new URL('..', import.meta.url));

/** A counter with a form, a timer and a select, the parts of discord.play the simulator has to route. */
const counter = `
import { app, after, button, field, modal, row, select, step } from '@teapilot/discord-play';
export default app({
  participants: 'invoker',
  init: () => ({ count: 0, word: '', pick: '' }),
  update(state, action) {
    if (action.kind === 'button' && action.id === 'add') return { ...state, count: state.count + 1 };
    if (action.kind === 'button' && action.id === 'later') return step(state, after(60000, 'tick'));
    if (action.kind === 'timer') return { ...state, count: state.count + 100 };
    if (action.kind === 'modal') return { ...state, word: action.fields.word };
    if (action.kind === 'select') return { ...state, pick: action.values.join('+') };
    return state;
  },
  view: state => ({ content: 'Count ' + state.count + ' ' + state.word + ' ' + state.pick, rows: [
    row(button('add', 'Add', { style: 'primary' }), button('later', 'Later'), button('say', 'Say', { opens: modal('words', 'Say', [field('word', 'Word', { max: 5 })]) })),
    row(select('pick', ['a', 'b', 'c'], { max: 2 })),
  ] }),
});`;

it('holds messages to what discord.js and Discord accept, and names the field that fails', () => {
  expect(() => checkMessage({ content: 'hi', components: [{ type: 1, components: [{ type: 2, style: 1, label: 'Go', emoji: { name: '🍵' }, custom_id: 'play:a:go' }] }] })).not.toThrow();
  const rejected = (payload: Parameters<typeof checkMessage>[0]) => { try { checkMessage(payload); } catch (error) { expect(error).toBeInstanceOf(DiscordRejected); return (error as Error).message; } return 'accepted'; };
  expect(rejected({ content: '' })).toBe('Cannot send an empty message.');
  expect(rejected({ content: 'x', embeds: [{ title: 'x'.repeat(300) }] })).toBe('embeds[0].title: Invalid string length (expected.length <= 256; got 300 characters)');
  expect(rejected({ content: 'x', components: [{ type: 1, components: [{ type: 2, style: 1, label: 'x'.repeat(81), custom_id: 'a' }] }] })).toMatch(/components\[0\]\.components\[0\]\.label: .*<= 80/);
  expect(rejected({ content: 'x', components: [{ type: 1, components: [{ type: 2, style: 1, custom_id: 'a' }] }] })).toMatch(/label and\/or an emoji/);
  expect(rejected({ content: 'x', components: [{ type: 1, components: [{ type: 2, style: 1, emoji: { name: 'tea' }, custom_id: 'a' }] }] })).toMatch(/not a Unicode emoji/);
  expect(rejected({ content: 'x', components: [{ type: 1, components: [{ type: 2, style: 1, label: 'A', custom_id: 'a' }, { type: 2, style: 1, label: 'B', custom_id: 'a' }] }] })).toMatch(/used twice/);
  expect(rejected({ content: 'x', components: [{ type: 1, components: [{ type: 3, custom_id: 's', options: [{ label: 'a', value: 'a' }], max_values: 2 }] }] })).toMatch(/max_values 2 is above its 1 option/);
  expect(() => checkModal({ custom_id: 'm', title: 'x'.repeat(46), components: [{ type: 1, components: [{ type: 4, custom_id: 'f', label: 'F', style: 1 }] }] })).toThrow(/modal\.title/);
});

it('jumps timers forward in order and still lets them fire on their own', async () => {
  const clock = new SkippableClock();
  const fired: string[] = [];
  clock.after(60_000, () => fired.push('minute'));
  clock.after(30_000, () => fired.push('half'));
  const cancel = clock.after(45_000, () => fired.push('cancelled'));
  clock.after(10, () => fired.push('soon'));
  cancel();
  await vi.waitFor(() => expect(fired).toEqual(['soon']));
  expect(clock.advance(60_000)).toBe(2);
  await vi.waitFor(() => expect(fired).toEqual(['soon', 'half', 'minute']));
  expect(clock.now() - Date.now()).toBeGreaterThanOrEqual(59_000);
});

async function playWorld() {
  const world = new World();
  const clock = new SkippableClock();
  const directory = await mkdtemp(join(tmpdir(), 'teapilot-sim-'));
  cleanups.push(() => rm(directory, { recursive: true, force: true }));
  let runtime!: PlayRuntime;
  const gateway = await world.connect({ token: 't', allowedUserIds: [people.op.id], channelId, root: directory, startMode: 'ask' },
    { message: vi.fn(), command: vi.fn(), reply: vi.fn(), component: interaction => void runtime.interact(interaction) }, vi.fn());
  runtime = new PlayRuntime({ store: new PlayStore(directory), surface: gateway.play, log: world.log, clock });
  cleanups.push(() => runtime.close());
  const { record } = await runtime.start({ title: 'Counter', channelId, conversation: 'dm:x', owner: { id: people.op.id, name: 'op' }, source: { kind: 'sandbox', code: counter } });
  return { world, clock, runtime, gateway, record, message: record.messageId! };
}

it('routes clicks, selects and forms from simulated people through the real runtime', async () => {
  const { world, message } = await playWorld();
  expect(world.screen()).toContain('[Add](add, primary) [Later](later) [Say](say)');

  expect(await world.click('op', message, 'add')).toContain('Count 1');
  expect(await world.click('stranger', message, 'add')).toContain('teapilot (only stranger sees this) in #channel:\n  Only @op can use this app.');

  const form = await world.click('op', message, 'say');
  expect(form).toContain('op sees a form:\n  "Say"\n  word: Word (short, required, max 5)');
  await expect(world.submit('op', { word: 'toolong' })).rejects.toThrow(/at most 5/);
  expect(await world.submit('op', { word: 'hey' })).toContain('Count 1 hey');
  await expect(world.submit('op', { word: 'again' })).rejects.toThrow(/no form open/);

  expect(await world.select('op', message, 'pick', ['a', 'c'])).toContain('Count 1 hey a+c');
  await expect(world.select('op', message, 'pick', ['z'])).rejects.toThrow(SimError);
  await expect(world.click('op', message, 'pick')).rejects.toThrow(/use select/);
  await expect(world.click('op', message, 'missing')).rejects.toThrow(/Controls: add, later, say, pick/);
});

it('fires app timers when the clock jumps', async () => {
  const { world, clock, message } = await playWorld();
  await world.click('op', message, 'later');
  expect(clock.advance(60_000)).toBe(1);
  await vi.waitFor(() => expect(world.render(world.find(message))).toContain('Count 100'));
});

it('flags what Discord would reject instead of accepting it', async () => {
  const { world, gateway } = await playWorld();
  await expect(gateway.play.post(channelId, { content: '', embeds: [], components: [], allowedMentions: { parse: [] } })).rejects.toThrow(DiscordRejected);
  expect(world.logs.at(-1)).toBe('⚠ Discord would reject a message in #channel: Cannot send an empty message.');
  await expect(gateway.play.request('GET', '/users/@me')).rejects.toThrow(/does not emulate/);
});

/** Models that build the counter on the first turn and answer plainly after that. */
async function models() {
  const f = await fixture(); cleanups.push(f.cleanup);
  let completions = 0;
  const server = await mockServer((_body, request, response) => {
    if (request.url === '/jev') {
      // The router says the request wants an app, which activates discord.play for the turn.
      const end = response.end.bind(response);
      response.end = ((chunk: string) => {
        const raw = JSON.parse(chunk);
        raw.answers['discord.play'] = { type: 'choice', choice: 'yes', probabilities: { yes: 1 }, confidence: 0.99 };
        return end(JSON.stringify(raw));
      }) as typeof response.end;
      jev(response, 'ask.normal');
    }
    else if (request.url?.endsWith('/models')) response.end(JSON.stringify({ data: [{ id: 'fast-test' }, { id: 'capable-test' }] }));
    else completion(response, ++completions === 1 ? { tool: { name: 'play_start', arguments: { title: 'Counter', source: counter } } } : { text: 'Your counter is up.' });
  });
  cleanups.push(server.close);
  f.config.router.endpoint = `${server.url}/jev`;
  for (const model of [f.config.models.fast, f.config.models.capable]) model.baseUrl = `${server.url}/v1`;
  f.config.policy.permissions = [...f.config.policy.permissions.filter(value => value !== 'discord.play'), 'discord.play'];
  return { ...f, server };
}

it('runs teapilot discord start against the simulator: a model builds an app, people use it, and it survives a restart', async () => {
  const f = await models();
  const world = new World();
  const settings = { token: 'simulated-discord-token', allowedUserIds: [people.op.id], channelId, root: f.cwd, startMode: 'ask' as const };
  const serve = () => {
    const controller = new AbortController();
    const done = serveDiscord({ config: f.config, settings, log: world.log, signal: controller.signal, connect: world.connect, stateDir: join(f.cwd, 'discord'), teachat: false });
    return { stop: async () => { controller.abort(); await done; } };
  };
  let server = serve();
  cleanups.push(() => server.stop());
  await vi.waitFor(() => expect(world.connected).toBe(true));

  world.say('stranger', 'make me a counter');
  world.say('op', 'make me a counter');
  await vi.waitFor(() => expect(world.screen('dm-op')).toContain('Result: completed'), { timeout: 20_000 });
  expect(world.screen('dm-op')).toContain('Your counter is up.');
  expect(world.screen('dm-stranger')).not.toContain('teapilot');
  const app = world.messages.find(message => message.content.startsWith('Count 0'))!;
  expect(app.channel.name).toBe('dm-op');
  expect(await world.click('op', app.id, 'add')).toContain('Count 1');

  await server.stop();
  server = serve();
  await vi.waitFor(() => expect(world.logs).toContain('Resumed 1 discord.play app(s).'));
  expect(await world.click('op', app.id, 'add')).toContain('Count 2');
}, 60_000);

function discord(args: string[], env: NodeJS.ProcessEnv = {}) {
  return new Promise<{ code: number | null; stdout: string; stderr: string }>((done, reject) => {
    const child = spawn(process.execPath, [resolve(root, 'scripts/agent-discord.mjs'), ...args], { cwd: root, windowsHide: true, env: { ...process.env, ...env }, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '', stderr = '';
    child.stdout.on('data', data => stdout += data);
    child.stderr.on('data', data => stderr += data);
    child.on('error', reject);
    child.on('close', code => done({ code, stdout, stderr }));
  });
}

it('drives the simulator from the command line, one call at a time', async () => {
  const f = await models();
  await writeFile(join(f.cwd, 'models.json'), JSON.stringify(f.config.models));
  await writeFile(join(f.cwd, 'policy.json'), JSON.stringify(f.config.policy));
  const env = {
    TEAPILOT_MODELS_FILE: join(f.cwd, 'models.json'), TEAPILOT_POLICY_FILE: join(f.cwd, 'policy.json'), TEAPILOT_STATE_DIR: f.config.stateDir,
    JEV_PROVIDER: 'typesafe', TYPESAFE_API_KEY: 'never-log-this-secret', JEV_API_URL: `${f.server.url}/jev`,
  };
  const name = `vitest-${process.pid}`;
  cleanups.push(() => discord(['stop', name]));

  const started = await discord(['start', '--name', name, '--config-dir', f.cwd, '--mode', 'chat'], env);
  expect(started.code, started.stderr).toBe(0);
  expect(started.stdout).toContain('Simulated Discord is running.');
  expect((await discord(['say', name, 'make me a counter'])).stdout).toBe('m1 sent by op in #dm-op.\n');
  const turn = await discord(['wait', name, '--for', 'Result: ', '--timeout', '30']);
  expect(turn.code, turn.stdout).toBe(0);
  expect(turn.stdout).toContain('Your counter is up.');
  const id = /^m\d+ teapilot in #dm-op:\n {2}Count 0/m.exec(turn.stdout)?.[0].split(' ')[0];
  expect(id, turn.stdout).toBeDefined();

  expect((await discord(['click', name, id!, 'add'])).stdout).toContain('Count 1');
  const refused = await discord(['click', name, id!, 'nope']);
  expect(refused.code).toBe(1);
  expect(refused.stderr).toContain('has no control nope');
  expect((await discord(['click', name, id!, 'say'])).stdout).toContain('op sees a form');
  expect((await discord(['submit', name, '--field', 'word=hi'])).stdout).toContain('Count 1 hi');
  const [app] = (await discord(['apps', name])).stdout.split(/\s+/);
  const details = await discord(['app', name, app!]);
  expect(details.stdout).toContain('## source');
  expect(details.stdout).toContain("participants: 'invoker'");
  expect((await discord(['wait', name, '--for', 'no such output', '--timeout', '1'])).code).toBe(124);

  expect((await discord(['stop', name])).code).toBe(0);
  expect(existsSync(join(tmpdir(), 'teapilot-discord', name))).toBe(false);
}, 120_000);
