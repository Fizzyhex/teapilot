import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import { runAttempt } from '../src/agents/run.js';
import { runImageScript, ScriptError } from '../src/discord/canvas-script.js';
import { FileStore, pictures, type ConversationFiles } from '../src/discord/files.js';
import { canvasLibrary, imageInfo } from '../src/discord/images.js';
import type { MessagePayload } from '../src/discord/play/render.js';
import { PlayRuntime, type PlayInteraction, type PlaySurface } from '../src/discord/play/runtime.js';
import { PlayStore } from '../src/discord/play/store.js';
import { SpendGovernor } from '../src/inference/budget.js';
import { Telemetry } from '../src/telemetry/outcome.js';
import { completion, fixture, mockServer } from './helpers.js';

const cleanups: Array<() => unknown> = [];
afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup(); });
const owner = { id: '111111111111111111', name: 'owner' };

async function directory(prefix: string) {
  const path = await mkdtemp(join(tmpdir(), prefix));
  cleanups.push(() => rm(path, { recursive: true, force: true }));
  return path;
}
/** A small PNG: red on the left half, blue on the right. */
async function png(width = 40, height = 20): Promise<Buffer> {
  const { createCanvas } = await canvasLibrary();
  const canvas = createCanvas(width, height);
  const context = canvas.getContext('2d');
  context.fillStyle = '#ff0000'; context.fillRect(0, 0, width / 2, height);
  context.fillStyle = '#0000ff'; context.fillRect(width / 2, 0, width / 2, height);
  return canvas.encode('png');
}
async function pixel(data: Buffer, x: number, y: number): Promise<number[]> {
  const { createCanvas, loadImage } = await canvasLibrary();
  const image = await loadImage(data);
  const canvas = createCanvas(image.width, image.height);
  canvas.getContext('2d').drawImage(image, 0, 0);
  return [...canvas.getContext('2d').getImageData(x, y, 1, 1).data];
}

it('keeps files per conversation by safe names, with image sizes, replacing a file saved under the same name', async () => {
  const store = FileStore.at(await directory('teapilot-files-'));
  const saved = await store.save('dm:1', '../evil/tree photo.png', await png(), 'op', 'image/png');
  expect(saved).toMatchObject({ name: 'tree_photo.png', type: 'image/png', width: 40, height: 20, from: 'op' });
  await store.save('dm:1', 'notes.txt', Buffer.from('hello'), 'op');
  expect(store.list('dm:2')).toEqual([]);
  expect(store.list('dm:1').map(file => file.name)).toEqual(['tree_photo.png', 'notes.txt']);
  await store.save('dm:1', 'notes.txt', Buffer.from('hello again'), 'teapilot');
  expect(store.read('dm:1', 'notes.txt')?.data.toString()).toBe('hello again');
  expect(store.list('dm:1')).toHaveLength(2);
  expect(await imageInfo(Buffer.from('not an image'))).toBeUndefined();
});

it('runs canvas scripts against the conversation\'s images and keeps only what they save', async () => {
  const image = await png();
  const files = { names: () => ['tree.png'], read: (name: string) => name === 'tree.png' ? image : undefined };
  const result = await runImageScript(`
import { createCanvas, loadImage } from "canvas";
const img = await loadImage("tree.png");
const canvas = createCanvas(img.height, img.width);
const ctx = canvas.getContext("2d");
ctx.translate(canvas.width / 2, canvas.height / 2); ctx.rotate(Math.PI / 2); ctx.drawImage(img, -img.width / 2, -img.height / 2);
ctx.setTransform(1, 0, 0, 1, 0, 0);
ctx.font = "bold 8px serif"; ctx.shadowColor = "black"; ctx.shadowBlur = 2; ctx.fillText("hi", 2, 10);
const data = ctx.getImageData(0, 0, 1, 1); console.log(data.data[0], data.data[2]);
save(canvas, "turned.webp", { quality: 0.85 });`, files);
  expect(result.saved).toHaveLength(1);
  expect(result.saved[0]).toMatchObject({ name: 'turned.webp', width: 20, height: 40 });
  expect((await imageInfo(result.saved[0]!.data))?.type).toBe('image/webp');
  expect(result.logs).toMatch(/^\d+ \d+$/);
  await expect(runImageScript('loadImage("missing.png")', files)).rejects.toThrow(/No file named "missing.png"\. Files here: tree\.png/);
  await expect(runImageScript('import fs from "fs";', files)).rejects.toThrow(ScriptError);
  await expect(runImageScript('createCanvas(5, 5).toBuffer()', files)).rejects.toThrow(/save\(canvas/);
  await expect(runImageScript('createCanvas(5, 5).getContext("2d").constructor.constructor("return process")()', files)).rejects.toThrow(/process/);
});

const rotator = `
import { app, button, row, embed, picture } from '@teapilot/discord-play';
export default app({
  init: () => ({ angle: 0, grey: false }),
  update: (state, action) => action.id === 'turn' ? { ...state, angle: (state.angle + 90) % 360 } : action.id === 'grey' ? { ...state, grey: !state.grey } : state,
  view: state => ({ embeds: [embed({ title: 'Tree', image: picture('tree.png', { rotate: state.angle, greyscale: state.grey }) })], rows: [row(button('turn', 'Turn'), button('grey', 'Grey'))] }),
});`;

async function playSetup(files: FileStore) {
  const posts: MessagePayload[] = [];
  const surface: PlaySurface = { post: vi.fn(async (_channel, payload) => { posts.push(payload); return 'm1'; }), edit: vi.fn(), request: vi.fn() };
  const runtime = new PlayRuntime({ store: new PlayStore(await directory('teapilot-play-')), surface, log: vi.fn(), pictures: pictures(files) });
  cleanups.push(() => runtime.close());
  return { runtime, posts };
}

it('shows picture() as an attachment the embed refers to, rendered again as the app changes', async () => {
  const files = FileStore.at(await directory('teapilot-files-'));
  await files.save('dm:1', 'tree.png', await png(), 'op');
  const { runtime, posts } = await playSetup(files);
  const { record, preview } = await runtime.start({ title: 'Tree', channelId: 'c1', conversation: 'dm:1', owner, source: { kind: 'sandbox', code: rotator } });
  expect(preview).toContain('image: tree.png {"rotate":0,"greyscale":false}');
  const first = posts[0]!;
  expect(first.pictures).toBeUndefined();
  expect(first.files).toHaveLength(1);
  expect((first.embeds[0] as { image: { url: string } }).image.url).toBe(`attachment://${first.files![0]!.name}`);
  expect(await pixel(first.files![0]!.data, 0, 0)).toEqual([255, 0, 0, 255]);

  const updates: MessagePayload[] = [];
  const click = (id: string): PlayInteraction => ({ playId: record.id, controlId: id, kind: 'button', user: owner, messageId: 'm1',
    openModal: vi.fn(), reply: vi.fn(), defer: vi.fn(async () => undefined), update: vi.fn(async payload => { updates.push(payload); }), followUp: vi.fn() });
  await runtime.interact(click('turn'));
  await runtime.interact(click('grey'));
  const turned = updates[0]!.files![0]!, grey = updates[1]!.files![0]!;
  expect(turned.name).not.toBe(first.files![0]!.name);
  const { loadImage } = await canvasLibrary();
  expect((await loadImage(turned.data)).width).toBe(20);
  const [r, g, b] = await pixel(grey.data, 5, 5);
  expect(r).toBe(g); expect(g).toBe(b);
});

it('rejects an app whose picture() names no image here, listing the images there are', async () => {
  const files = FileStore.at(await directory('teapilot-files-'));
  await files.save('dm:1', 'cat.png', await png(), 'op');
  const { runtime } = await playSetup(files);
  await expect(runtime.start({ title: 'Tree', channelId: 'c1', conversation: 'dm:1', owner, source: { kind: 'sandbox', code: rotator } }))
    .rejects.toThrow(/picture\("tree.png"\): no file by that name here\. Images here: cat\.png/);
  await expect(runtime.start({ title: 'Tree', channelId: 'c1', conversation: 'dm:1', owner, source: { kind: 'sandbox', code: rotator.replace("rotate: state.angle", "rotate: state.angle, filter: 'rm -rf'") } }))
    .rejects.toThrow(/CSS filter functions/);
});

async function agentSetup(handler: Parameters<typeof mockServer>[0]) {
  const f = await fixture(); cleanups.push(f.cleanup);
  const server = await mockServer(handler); cleanups.push(server.close);
  Object.assign(f.config.models.capable, { provider: 'ollama', baseUrl: server.url });
  const telemetry = new Telemetry(f.config.stateDir, 'files-test');
  await telemetry.event('start', {});
  const budget = new SpendGovernor(join(f.config.stateDir, 'spend.jsonl'), 'files-test', f.config.policy.budget);
  const store = FileStore.at(await directory('teapilot-files-'));
  const sent: Array<{ text: string; files: Array<{ name: string; data: Buffer }> }> = [];
  const files: ConversationFiles = { store, conversation: 'dm:1', send: async (text, uploads) => { sent.push({ text, files: uploads }); } };
  const { runtime, posts } = await playSetup(store);
  const play = { runtime, channelId: 'c1', conversation: 'dm:1', owner, files };
  return { ...f, budget, telemetry, store, sent, runtime, posts, play, base: { tier: 'normal' as const, workload: 'ask' as const, web: false, approve: async () => true } };
}

it('edits an image with a script from the reply, posts it, then sends it again as an 85% webp', async () => {
  const bodies: any[] = [];
  const script = '```js\nconst img = loadImage("leaves.png");\nconst c = createCanvas(img.width, img.height);\nconst ctx = c.getContext("2d");\nctx.drawImage(img, 0, 0);\nctx.font = "12px serif"; ctx.textAlign = "center"; ctx.fillStyle = "white"; ctx.fillText("autum", c.width / 2, c.height / 2);\nsave(c, "leaves-autum.png");\n```';
  const steps = [
    { text: script, tool: { name: 'image_edit', arguments: {} } },
    { tool: { name: 'file_send', arguments: { file: 'leaves-autum.png', name: 'leaves-autum.webp', quality: 85 } } },
    { text: 'Here you go.' },
  ];
  const f = await agentSetup((body, _req, res) => { bodies.push(body); completion(res, steps[bodies.length - 1]!); });
  await f.store.save('dm:1', 'leaves.png', await png(), 'op');
  const result = await runAttempt({ ...f, ...f.base, prompt: 'write autum on it', activePermissions: ['inference'], play: f.play });
  expect(result.success, JSON.stringify(result)).toBe(true);
  const names = (bodies[0].tools ?? []).map((tool: any) => tool.function.name);
  expect(names).toEqual(expect.arrayContaining(['image_edit', 'file_send']));
  expect(JSON.stringify(bodies[0].messages)).toContain('leaves.png (PNG image 40×20');
  expect(JSON.stringify(bodies[1].messages)).toContain('Saved and posted leaves-autum.png (PNG image 40×20');
  expect(f.sent.map(entry => entry.files.map(file => file.name))).toEqual([['leaves-autum.png'], ['leaves-autum.webp']]);
  expect((await imageInfo(f.sent[1]!.files[0]!.data))?.type).toBe('image/webp');
  expect(f.store.get('dm:1', 'leaves-autum.webp')).toBeDefined();
  // The script is shown by what it made, not by its source.
  expect(result.text).not.toContain('createCanvas');
});

it('runs an attached app file, replaces an emoji everywhere, and sends the source back under its name', async () => {
  const bodies: any[] = [];
  const game = `// chairs 🪑 block you
import { app, button, row } from '@teapilot/discord-play';
export default app({ init: () => 0, update: n => n + 1, view: n => ({ content: '🪑 ' + n, rows: [row(button('go', 'Go'))] }) });`;
  const steps = [
    { tool: { name: 'play_start', arguments: { file: 'game.js', title: 'Game' } } },
    { tool: { name: 'play_start', arguments: { file: 'game.js', title: 'Game' } } },
    { tool: { name: 'play_update', arguments: { edits: [{ find: '🪑', replace: '🐖' }] } } },
    { tool: { name: 'play_update', arguments: { edits: [{ find: '🪑', replace: '🐖', all: true }] } } },
    { tool: { name: 'file_send', arguments: { app: 'APP' } } },
    { text: 'Done.' },
  ];
  const f = await agentSetup((body, _req, res) => {
    bodies.push(body);
    const step = structuredClone(steps[bodies.length - 1]!) as any;
    if (step.tool?.arguments.app) step.tool.arguments.app = f.runtime.list('dm:1')[0]!.id;
    completion(res, step);
  });
  await f.store.save('dm:1', 'game.js', Buffer.from(game), 'op', 'text/javascript');
  const result = await runAttempt({ ...f, ...f.base, prompt: 'embed this game', activePermissions: ['inference', 'discord.play'], play: f.play });
  expect(result.success, JSON.stringify(result)).toBe(true);
  expect(JSON.stringify(bodies[0].messages)).toContain('play_start({ file, title })');
  expect(f.posts[0]!.content).toBe('🪑 0');
  expect(JSON.stringify(bodies[2].messages)).toContain('is already live from this turn');
  expect(f.posts).toHaveLength(1);
  expect(JSON.stringify(bodies[3].messages)).toContain('occurs 2 times');
  expect(JSON.stringify(bodies[3].messages)).toContain('set all: true');
  const sent = f.sent[0]!.files[0]!;
  expect(sent.name).toBe('game.js');
  expect(sent.data.toString()).toBe(game.replaceAll('🪑', '🐖'));
});

it('holds a model to a change it claims without calling a play tool, once', async () => {
  const bodies: any[] = [];
  const steps = [
    { text: 'Done — chairs are now pigs 🐷.' },
    { tool: { name: 'play_update', arguments: { edits: [{ find: '🪑', replace: '🐷' }] } } },
    { text: 'Swapped the chairs for pigs.' },
  ];
  const f = await agentSetup((body, _req, res) => { bodies.push(body); completion(res, steps[bodies.length - 1]!); });
  const code = `import { app, button, row } from '@teapilot/discord-play';
export default app({ init: () => 0, update: n => n + 1, view: n => ({ content: '🪑 ' + n, rows: [row(button('go', 'Go'))] }) });`;
  await f.runtime.start({ title: 'Game', channelId: 'c1', conversation: 'dm:1', owner, source: { kind: 'sandbox', code } });
  const result = await runAttempt({ ...f, ...f.base, prompt: 'replace the chairs with pigs', activePermissions: ['inference', 'discord.play'], play: f.play });
  expect(result.success, JSON.stringify(result)).toBe(true);
  expect(JSON.stringify(bodies[1].messages)).toContain('no play_start or play_update succeeded in this turn');
  expect(result.text).toBe('Swapped the chairs for pigs.');
  const source = f.runtime.source(f.runtime.list('dm:1')[0]!.id, 'dm:1');
  expect(source.kind === 'sandbox' && source.code).toContain('🐷');

  // A plain answer about a running app is left alone.
  bodies.length = 0;
  steps.splice(0, steps.length, { text: 'Press Go to count up.' });
  const answer = await runAttempt({ ...f, ...f.base, prompt: 'how do I play?', activePermissions: ['inference', 'discord.play'], play: f.play });
  expect(answer.text).toBe('Press Go to count up.');
  expect(bodies).toHaveLength(1);
});
