import { mkdtemp, rm, mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import { WebSocket } from 'ws';
import { PlayRuntime } from '../src/discord/play/runtime.js';
import { PlayStore } from '../src/discord/play/store.js';
import type { MessagePayload } from '../src/discord/play/render.js';
import { openPlayWeb } from '../src/discord/play/web.js';
import * as funnel from '../src/discord/play/funnel.js';

const cleanups: Array<() => unknown> = [];
afterEach(async () => { vi.restoreAllMocks(); for (const cleanup of cleanups.splice(0).reverse()) await cleanup(); });
const owner = { id: '111111111111111111', name: 'op' };
const code = `import { app, button, row, embed, picture, step, ephemeral, modal, field } from '@teapilot/discord-play';
export default app({ init: () => 0, update: (s,a) => a.id === 'hint' ? step(s, ephemeral('only you')) : s + 1,
view: s => ({content: 'count ' + s, embeds: [embed({image: picture('board.png')})], rows: [row(button('add','add'), button('hint','hint'), button('disabled','disabled',{disabled:true}), button('form','form',{opens:modal('form','form',[field('word','word')])}))]}) });`;
async function setup(publish = false) {
  const dir = await mkdtemp(join(tmpdir(), 'play-web-'));
  cleanups.push(() => rm(dir, { recursive: true, force: true }));
  const edit = vi.fn(async (_channel: string, _message: string, _payload: MessagePayload) => {});
  const runtime = new PlayRuntime({ store: new PlayStore(dir), log: vi.fn(), probe: false, discordEditMs: 0,
    surface: { post: async () => 'message', edit, request: async () => ({}) },
    pictures: { check() {}, async render(_conversation, spec) { return { name: spec.name, data: Buffer.from('image') }; } },
  });
  cleanups.push(() => runtime.close());
  const { record } = await runtime.start({ title: 'counter', channelId: 'channel', conversation: 'conversation', owner, participants: 'invoker', source: { kind: 'sandbox', code } });
  const assets = join(dir, 'web'); await mkdir(assets);
  await writeFile(join(assets, 'index.html'), '<script src="/app.js"></script>');
  await writeFile(join(assets, 'app.js'), 'console.log("test")');
  const web = await openPlayWeb(runtime, { funnel: publish, port: 0, log: vi.fn(), assets });
  cleanups.push(() => web.close());
  const launch = () => new URL(web.launch('channel', 'message', owner)!);
  const redeem = async (url = launch(), id = record.id) => fetch(`${web.origin}/launch`, { method: 'POST', headers: { Origin: web.origin }, body: JSON.stringify({ ticket: url.hash.slice(1), id }) });
  return { runtime, record, web, edit, launch, redeem };
}
function socket(origin: string, id: string, cookie: string) {
  const ws = new WebSocket(`${origin.replace('http:', 'ws:')}/live/${id}`, { origin, headers: { Cookie: cookie } });
  const messages: any[] = [];
  ws.on('message', data => messages.push(JSON.parse(data.toString())));
  cleanups.push(() => ws.terminate());
  const next = async (type: string) => {
    await vi.waitFor(() => expect(messages.some(message => message.type === type)).toBe(true));
    return messages.splice(messages.findIndex(message => message.type === type), 1)[0];
  };
  return { ws, messages, next };
}

it('uses the published HTTPS origin for launch links and falls back locally if Funnel stops', async () => {
  let changed!: (origin?: string) => void;
  vi.spyOn(funnel, 'publishPlay').mockImplementation(async options => {
    changed = options.changed;
    changed('https://tea.example.ts.net:10000');
    return async () => { changed(); };
  });
  const { web, record, launch } = await setup(true);
  expect(web.origin).toBe('https://tea.example.ts.net:10000');
  expect(launch().href).toMatch(new RegExp(`^https://tea\\.example\\.ts\\.net:10000/play/${record.id}#.+$`));
  changed();
  expect(web.origin).toMatch(/^http:\/\/localhost:\d+$/);
  expect(launch().origin).toBe(web.origin);
});

it('still provides local launch links when Funnel cannot be published', async () => {
  vi.spyOn(funnel, 'publishPlay').mockRejectedValue(new Error('tailscale port 10000 is already in use'));
  const { web, launch } = await setup(true);
  expect(web.origin).toMatch(/^http:\/\/localhost:\d+$/);
  expect(launch().origin).toBe(web.origin);
});

it('launches only the current message for an allowed player; tickets are game-bound and single-use', async () => {
  const { web, record, launch, redeem } = await setup();
  expect(web.launch('other', 'message', owner)).toBeUndefined();
  expect(web.launch('channel', 'old-message', owner)).toBeUndefined();
  expect(web.launch('channel', 'message', { id: '222222222222222222' })).toBeUndefined();
  const url = launch();
  expect((await redeem(url, 'another')).status).toBe(401);
  const response = await redeem(url);
  expect(response.status).toBe(200);
  const cookie = response.headers.get('set-cookie')!.split(';')[0]!;
  expect(response.headers.get('set-cookie')).toContain('HttpOnly');
  expect((await redeem(url)).status).toBe(401);
  expect((await fetch(`${web.origin}/session/${record.id}`)).status).toBe(401);
  expect(await (await fetch(`${web.origin}/session/${record.id}`, { headers: { Cookie: cookie } })).json()).toEqual({ user: owner.id });
  expect((await fetch(`${web.origin}/session/another`, { headers: { Cookie: cookie.replace(record.id, 'another') } })).status).toBe(401);
  expect((await fetch(`${web.origin}/launch`, { method: 'POST', headers: { Origin: 'https://elsewhere.example' }, body: '{}' })).status).toBe(403);
});

it('shares committed state across browsers and Discord while private notes remain on the initiating connection', async () => {
  const { runtime, record, web, redeem, edit } = await setup();
  const cookie = (await redeem()).headers.get('set-cookie')!.split(';')[0]!;
  const first = socket(web.origin, record.id, cookie), second = socket(web.origin, record.id, cookie);
  const view = await first.next('view'); await second.next('view');
  expect(view.payload.content).toBe('count 0');
  expect(view.payload.files).toBeUndefined();
  expect(view).not.toHaveProperty('state'); expect(view).not.toHaveProperty('source');
  first.ws.send(JSON.stringify({ type: 'press', id: 'add', user: { id: 'spoof' } }));
  expect((await first.next('view')).payload.content).toBe('count 1');
  expect((await second.next('view')).payload.content).toBe('count 1');
  await first.next('ack'); expect(edit).toHaveBeenCalled();
  await new Promise(resolve => setTimeout(resolve, 110));
  first.ws.send(JSON.stringify({ type: 'press', id: 'hint' }));
  expect((await first.next('ack')).notes).toEqual([{ content: 'only you' }]);
  await second.next('view');
  expect(second.messages.some(message => message.type === 'ack')).toBe(false);
  await runtime.interact({ playId: record.id, controlId: 'add', kind: 'button', user: owner,
    reply: async () => {}, defer: async () => {}, update: async () => {}, followUp: async () => {}, openModal: async () => {} });
  expect((await second.next('view')).payload.content).toBe('count 2');
  await expect(runtime.browserPress(record.id, 'disabled', owner)).rejects.toThrow();
  await expect(runtime.browserPress(record.id, 'form', owner)).rejects.toThrow();
  await expect(runtime.browserPress(record.id, 'missing', owner)).rejects.toThrow();
  await expect(runtime.browserPress(record.id, 'add', { id: '222222222222222222' })).rejects.toThrow();
  expect(runtime.state(record.id, 'conversation')).toBe(2);
  await runtime.stop(record.id, 'conversation');
  expect((await second.next('view')).status).toBe('finished');
  await expect(runtime.browserPress(record.id, 'add', owner)).rejects.toThrow();
});

it('serves browser assets and only the authorized game’s rendered images', async () => {
  const { web, record, redeem, runtime } = await setup();
  const cookie = (await redeem()).headers.get('set-cookie')!.split(';')[0]!;
  const { payload } = await runtime.browserView(record.id, owner);
  const url = `${web.origin}/media/${record.id}/${payload.files![0]!.name}`;
  expect((await fetch(url)).status).toBe(401);
  expect(await (await fetch(url, { headers: { Cookie: cookie } })).text()).toBe('image');
  expect((await fetch(`${web.origin}/media/${record.id}/secrets`, { headers: { Cookie: cookie } })).status).toBe(404);
  const html = await (await fetch(`${web.origin}/play/${record.id}`)).text();
  const script = /src="([^"]+\.js)"/.exec(html)![1]!;
  expect((await fetch(`${web.origin}${script}`)).status).toBe(200);
});

it('acknowledges successive browser inputs while Discord is blocked, then mirrors only the latest view', async () => {
  const { runtime, record, web, redeem, edit } = await setup();
  const cookie = (await redeem()).headers.get('set-cookie')!.split(';')[0]!;
  const browser = socket(web.origin, record.id, cookie);
  await browser.next('view');
  let release!: () => void;
  const blocked = new Promise<void>(resolve => { release = resolve; });
  edit.mockImplementationOnce(async () => { await blocked; });
  try {
    browser.ws.send(JSON.stringify({ type: 'press', id: 'add' }));
    expect((await browser.next('ack')).text).toBe('');
    expect((await browser.next('view')).payload.content).toBe('count 1');
    await new Promise(resolve => setTimeout(resolve, 110));
    browser.ws.send(JSON.stringify({ type: 'press', id: 'add' }));
    expect((await browser.next('ack')).text).toBe('');
    expect((await browser.next('view')).payload.content).toBe('count 2');
    await runtime.browserPress(record.id, 'add', owner);
    expect(runtime.state(record.id, 'conversation')).toBe(3);
    expect(edit).toHaveBeenCalledTimes(1);
  } finally { release(); }
  await vi.waitFor(() => expect(edit).toHaveBeenCalledTimes(2));
  expect(edit.mock.calls.at(-1)?.[2]).toMatchObject({ content: 'count 3' });
});

it('expires unused launch tickets and established browser sessions', async () => {
  const { web, record, launch, redeem } = await setup();
  const cookie = (await redeem()).headers.get('set-cookie')!.split(';')[0]!;
  const ticket = launch(), now = Date.now();
  const clock = vi.spyOn(Date, 'now').mockReturnValue(now + 6 * 60_000);
  expect((await redeem(ticket)).status).toBe(401);
  clock.mockReturnValue(now + 25 * 60 * 60_000);
  expect((await fetch(`${web.origin}/session/${record.id}`, { headers: { Cookie: cookie } })).status).toBe(401);
});
