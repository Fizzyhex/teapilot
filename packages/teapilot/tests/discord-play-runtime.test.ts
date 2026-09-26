import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import type { MessagePayload } from '../src/discord/play/render.js';
import { hashFile, PlayRuntime, type Consultant, type PlayInteraction, type PlaySurface } from '../src/discord/play/runtime.js';
import { PlayStore } from '../src/discord/play/store.js';

const cleanups: Array<() => unknown> = [];
afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup(); });

const owner = { id: '111111111111111111', name: 'owner' };
const friend = '222222222222222222';
const stranger = '333333333333333333';

/** A counter with every feature the runtime has to route: buttons, a modal, timers, consults, private notes and finishing. */
const counter = `
import { app, button, row, step, after, cancel, consult, ephemeral, finish, modal, field } from '@teapilot/discord-play';
export default app({
  participants: 'everyone',
  init: () => ({ count: 0, said: '' }),
  update(state, action) {
    if (action.kind === 'button' && action.id === 'add') return { ...state, count: state.count + 1 };
    if (action.kind === 'button' && action.id === 'boom') throw new Error('kaboom');
    if (action.kind === 'button' && action.id === 'hint') return step(state, ephemeral('psst'));
    if (action.kind === 'button' && action.id === 'soon') return step(state, after(1000, 'tick'));
    if (action.kind === 'button' && action.id === 'never') return step(state, after(1000, 'tick'), cancel('tick'));
    if (action.kind === 'button' && action.id === 'ask') return step(state, consult('judge', 'is ' + state.count + ' big?'));
    if (action.kind === 'button' && action.id === 'end') return step(state, finish('Final: ' + state.count));
    if (action.kind === 'timer') return { ...state, count: state.count + 100 };
    if (action.kind === 'consult') return { ...state, said: action.text ?? 'error: ' + action.error };
    if (action.kind === 'modal') return { ...state, said: action.fields.word };
    return state;
  },
  view: state => ({ content: state.count + ' ' + state.said, rows: [
    row(button('add', 'Add'), button('boom', 'Boom'), button('hint', 'Hint'), button('soon', 'Soon'), button('never', 'Never')),
    row(button('ask', 'Ask'), button('end', 'End'), button('say', 'Say', { opens: modal('words', 'Say', [field('word', 'Word')]) })),
  ] }),
});`;

async function setup(options: { consult?: Consultant; now?: () => number; directory?: string } = {}) {
  const directory = options.directory ?? await mkdtemp(join(tmpdir(), 'teapilot-play-'));
  if (!options.directory) cleanups.push(() => rm(directory, { recursive: true, force: true }));
  const posts: MessagePayload[] = [];
  const edits: MessagePayload[] = [];
  const surface: PlaySurface = {
    post: vi.fn(async (_channel: string, payload: MessagePayload) => { posts.push(payload); return 'message-1'; }),
    edit: vi.fn(async (_channel: string, _message: string, payload: MessagePayload) => { edits.push(payload); }),
    request: vi.fn(async (method: string, route: string) => ({ echoed: `${method} ${route}` })),
  };
  const log = vi.fn();
  const store = new PlayStore(directory);
  const runtime = new PlayRuntime({ store, surface, log, consult: options.consult, now: options.now });
  cleanups.push(() => runtime.close());
  return { directory, store, runtime, surface, posts, edits, log };
}

function act(playId: string, controlId: string, user = owner.id, extra: Partial<PlayInteraction> = {}) {
  const seen = { replies: [] as string[], followUps: [] as string[], updates: [] as MessagePayload[], modals: [] as unknown[], deferred: false };
  const interaction: PlayInteraction = {
    playId, controlId, kind: 'button', user: { id: user },
    openModal: async payload => { seen.modals.push(payload); },
    reply: async content => { seen.replies.push(content); },
    defer: async () => { seen.deferred = true; },
    update: async payload => { seen.updates.push(payload); },
    followUp: async content => { seen.followUps.push(content); },
    ...extra,
  };
  return { interaction, seen };
}
const start = (runtime: PlayRuntime, extra: { participants?: 'everyone' | 'invoker' | string[]; code?: string } = {}) =>
  runtime.start({ title: 'Counter', channelId: 'channel-1', conversation: 'dm:1', owner, source: { kind: 'sandbox', code: extra.code ?? counter }, participants: extra.participants });

it('posts the first view and edits it in place on each click', async () => {
  const { runtime, posts, store } = await setup();
  const { record, preview } = await start(runtime);
  expect(posts[0]!.content).toBe('0 ');
  expect(preview).toContain('[Add](add)');
  const { interaction, seen } = act(record.id, 'add', friend);
  await runtime.interact(interaction);
  expect(seen.deferred).toBe(true);
  expect(seen.updates[0]!.content).toBe('1 ');
  expect(store.all()[0]).toMatchObject({ state: { count: 1 }, messageId: 'message-1', status: 'running' });
});

it('keeps the controls to the chosen participants', async () => {
  const { runtime } = await setup();
  const { record } = await start(runtime, { participants: [owner.id, friend] });
  const outsider = act(record.id, 'add', stranger);
  await runtime.interact(outsider.interaction);
  expect(outsider.seen.replies[0]).toBe(`This app is for <@${owner.id}>, <@${friend}>.`);
  expect(outsider.seen.deferred).toBe(false);
  const mine = await start(runtime, { participants: 'invoker' });
  const other = act(mine.record.id, 'add', friend);
  await runtime.interact(other.interaction);
  expect(other.seen.replies[0]).toBe(`Only <@${owner.id}> can use this app.`);
});

it('runs simultaneous clicks one at a time', async () => {
  const { runtime, store } = await setup();
  const { record } = await start(runtime);
  const clicks = Array.from({ length: 5 }, () => act(record.id, 'add'));
  await Promise.all(clicks.map(click => runtime.interact(click.interaction)));
  expect(clicks.map(click => click.seen.updates[0]!.content).sort()).toEqual(['1 ', '2 ', '3 ', '4 ', '5 ']);
  expect(store.all()[0]!.state).toEqual({ count: 5, said: '' });
});

it('changes nothing when the app throws, and tells only the person who clicked', async () => {
  const { runtime, store } = await setup();
  const { record } = await start(runtime);
  await runtime.interact(act(record.id, 'add').interaction);
  const boom = act(record.id, 'boom');
  await runtime.interact(boom.interaction);
  expect(boom.seen.updates).toEqual([]);
  expect(boom.seen.followUps[0]).toMatch(/nothing changed.*kaboom/s);
  const saved = store.all()[0]!;
  expect(saved.state).toEqual({ count: 1, said: '' });
  expect(saved.log.at(-1)).toMatchObject({ action: expect.stringContaining('boom'), error: expect.stringContaining('kaboom') });
});

it('refuses controls that are not in the current view', async () => {
  const { runtime } = await setup();
  const { record } = await start(runtime);
  const ghost = act(record.id, 'missing');
  await runtime.interact(ghost.interaction);
  expect(ghost.seen.replies).toEqual(['That control is no longer available.']);
  const unknown = act('nope', 'add');
  await runtime.interact(unknown.interaction);
  expect(unknown.seen.replies).toEqual(['This app has ended.']);
});

it('sends private notes to the person who acted', async () => {
  const { runtime } = await setup();
  const { record } = await start(runtime);
  const hint = act(record.id, 'hint', friend);
  await runtime.interact(hint.interaction);
  expect(hint.seen.followUps).toEqual(['psst']);
});

it('opens a form without running the app, then applies its submission', async () => {
  const { runtime } = await setup();
  const { record } = await start(runtime);
  const open = act(record.id, 'say');
  await runtime.interact(open.interaction);
  expect(open.seen.deferred).toBe(false);
  expect(open.seen.modals[0]).toMatchObject({ custom_id: `play:${record.id}:words`, title: 'Say' });
  const submit = act(record.id, 'words', owner.id, { kind: 'modal', fields: { word: 'hello' } });
  await runtime.interact(submit.interaction);
  expect(submit.seen.updates[0]!.content).toBe('0 hello');
  const stale = act(record.id, 'other-form', owner.id, { kind: 'modal', fields: {} });
  await runtime.interact(stale.interaction);
  expect(stale.seen.replies).toEqual(['That control is no longer available.']);
});

it('finishes with every control disabled and ignores later clicks', async () => {
  const { runtime, store } = await setup();
  const { record } = await start(runtime);
  const end = act(record.id, 'end');
  await runtime.interact(end.interaction);
  const final = end.seen.updates[0]!;
  expect(final.content).toBe('0 \n-# Final: 0');
  expect(final.components.flatMap(row => row.components).every(control => control.disabled === true)).toBe(true);
  expect(store.all()[0]).toMatchObject({ status: 'finished', note: 'Final: 0' });
  const late = act(record.id, 'add');
  await runtime.interact(late.interaction);
  expect(late.seen.replies).toEqual(['This app has ended.']);
});

it('fires timers, cancels them, and keeps them across a restart', async () => {
  let clock = Date.now();
  const first = await setup({ now: () => clock });
  const { record } = await start(first.runtime);
  await first.runtime.interact(act(record.id, 'never').interaction);
  expect(first.store.all()[0]!.timers).toEqual([]);
  await first.runtime.interact(act(record.id, 'soon').interaction);
  expect(first.store.all()[0]!.timers).toEqual([{ id: 'tick', dueAt: clock + 1000 }]);
  first.runtime.close();
  // A new process a minute later: the overdue timer fires as soon as the app is recovered.
  clock += 60_000;
  const second = await setup({ now: () => clock, directory: first.directory });
  expect(await second.runtime.recover()).toBe(1);
  await vi.waitFor(() => expect(second.edits.at(-1)?.content).toBe('100 '));
  expect(second.store.all()[0]!.timers).toEqual([]);
  // Clicks keep working after the restart.
  const click = act(record.id, 'add');
  await second.runtime.interact(click.interaction);
  expect(click.seen.updates[0]!.content).toBe('101 ');
});

it('asks the model through consult and caps it', async () => {
  const consult = vi.fn<Consultant>(async (_play, prompt) => `answer to ${prompt}`);
  const { runtime, edits } = await setup({ consult });
  const { record } = await start(runtime);
  await runtime.interact(act(record.id, 'ask').interaction);
  await vi.waitFor(() => expect(edits.at(-1)?.content).toBe('0 answer to is 0 big?'));
  expect(consult).toHaveBeenCalledWith({ title: 'Counter', owner, channelId: 'channel-1' }, 'is 0 big?');
  for (let index = 0; index < 20; index++) {
    await runtime.interact(act(record.id, 'ask').interaction);
    await vi.waitFor(() => expect(edits.at(-1)?.content).toMatch(/big\?|error/));
  }
  await vi.waitFor(() => expect(edits.at(-1)?.content).toContain('used its 20 consults'));
  expect(consult).toHaveBeenCalledTimes(20);
});

it('scopes management to the conversation that started the app', async () => {
  const { runtime, edits } = await setup();
  const { record } = await start(runtime);
  expect(runtime.list('dm:1')).toEqual([{ id: record.id, title: 'Counter', status: 'running' }]);
  expect(runtime.list('dm:2')).toEqual([]);
  expect(() => runtime.inspect(record.id, 'dm:2')).toThrow(/No app/);
  expect(JSON.parse(runtime.inspect(record.id, 'dm:1'))).toMatchObject({ status: 'running', state: { count: 0 } });
  await runtime.stop(record.id, 'dm:1', 'Closed by the host.');
  expect(edits.at(-1)!.content).toBe('0 \n-# Closed by the host.');
});

it('swaps code in place and keeps state unless told to reset', async () => {
  const { runtime, edits } = await setup();
  const { record } = await start(runtime);
  await runtime.interact(act(record.id, 'add').interaction);
  const doubled = counter.replace("content: state.count + ' ' + state.said", "content: 'x' + state.count * 2");
  await runtime.update(record.id, 'dm:1', { kind: 'sandbox', code: doubled }, false);
  expect(edits.at(-1)!.content).toBe('x2');
  await runtime.update(record.id, 'dm:1', undefined, true);
  expect(edits.at(-1)!.content).toBe('x0');
});

it('refuses a broken app before posting anything', async () => {
  const { runtime, posts } = await setup();
  await expect(start(runtime, { code: counter.replace("content: state.count + ' ' + state.said", "content: 5") })).rejects.toThrow(/Message content must be a string/);
  await expect(start(runtime, { code: 'export default {' })).rejects.toThrow();
  expect(posts).toEqual([]);
});

it('dry-runs an app with scripted actions', async () => {
  const { runtime, posts } = await setup();
  const transcript = await runtime.test({ kind: 'sandbox', code: counter }, [{ kind: 'button', id: 'add' }, { kind: 'button', id: 'soon' }, { kind: 'button', id: 'boom' }, { kind: 'button', id: 'add' }], owner);
  expect(transcript).toContain('## 1. button add\nstate: {"count":1,"said":""}');
  expect(transcript).toContain('effects: [{"type":"after","id":"tick","ms":1000}]');
  expect(transcript).toMatch(/## 3\. button boom\nerror: .*kaboom/);
  expect(transcript).not.toContain('## 4.');
  expect(posts).toEqual([]);
});

it('runs a trusted app as Node with Discord calls through the host, and pauses it when the file changes', async () => {
  const { runtime, surface, directory } = await setup();
  const file = join(directory, 'trusted-app.ts');
  await writeFile(file, `import { app, button, row } from '@teapilot/discord-play';
import { platform } from 'node:os';
export default app({
  init: () => ({ os: platform(), echo: '' }),
  async update(state: { os: string; echo: string }, _action, ctx) { return { ...state, echo: JSON.stringify(await ctx.discord!.request('GET', '/users/@me')) }; },
  view: (state: { os: string; echo: string }) => ({ content: state.os + ' ' + state.echo, rows: [row(button('go', 'Go'))] }),
});`);
  const { record } = await runtime.start({ title: 'Trusted', channelId: 'channel-1', conversation: 'dm:1', owner, source: { kind: 'trusted', path: file, sha256: await hashFile(file) } });
  const click = act(record.id, 'go');
  await runtime.interact(click.interaction);
  expect(click.seen.updates[0]!.content).toBe(`${process.platform} {"echoed":"GET /users/@me"}`);
  expect(surface.request).toHaveBeenCalledWith('GET', '/users/@me', undefined);
  runtime.close();

  await writeFile(file, 'export default {};');
  const restarted = await setup({ directory });
  expect(await restarted.runtime.recover()).toBe(0);
  expect(restarted.store.all()[0]).toMatchObject({ status: 'paused', note: expect.stringContaining('file changed') });
  expect(restarted.edits.at(-1)!.components.flatMap(row => row.components).every(control => control.disabled)).toBe(true);
  const blocked = act(record.id, 'go');
  await restarted.runtime.interact(blocked.interaction);
  expect(blocked.seen.replies[0]).toMatch(/paused/);
}, 30_000);
