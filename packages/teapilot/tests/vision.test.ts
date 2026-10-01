import { randomBytes } from 'node:crypto';
import { mkdtemp, readdir, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Message } from '@earendil-works/pi-ai';
import { afterEach, expect, it } from 'vitest';
import { runAttempt } from '../src/agents/run.js';
import { turnSteps, withoutOldPictures } from '../src/agents/history.js';
import { canvasLibrary, imageInfo } from '../src/discord/images.js';
import { SpendGovernor } from '../src/inference/budget.js';
import { estimateValueTokens, IMAGE_SIDE, IMAGE_TOKENS, imageBytes } from '../src/inference/context.js';
import { piModel } from '../src/inference/providers.js';
import { provisionedOllama } from '../src/runtime/ollama.js';
import { endpointDriver } from '../src/runtime/index.js';
import { applyReports } from '../src/setup/draft.js';
import { Telemetry } from '../src/telemetry/outcome.js';
import { receiveFiles } from '../src/workspace/attach.js';
import { modelImage, workspaceImages } from '../src/workspace/images.js';
import { WorkspaceStore } from '../src/workspace/store.js';
import { completion, fixture, mockServer } from './helpers.js';

const cleanups: Array<() => unknown> = [];
afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup(); });

/** A PNG: red on the left half, blue on the right. */
async function png(width = 64, height = 64): Promise<Buffer> {
  const { createCanvas } = await canvasLibrary();
  const canvas = createCanvas(width, height);
  const context = canvas.getContext('2d');
  context.fillStyle = '#ff0000'; context.fillRect(0, 0, width / 2, height);
  context.fillStyle = '#0000ff'; context.fillRect(width / 2, 0, width / 2, height);
  return canvas.encode('png');
}

async function setup(handler: Parameters<typeof mockServer>[0], vision = true) {
  const f = await fixture(); cleanups.push(f.cleanup);
  const server = await mockServer(handler); cleanups.push(server.close);
  Object.assign(f.config.models.capable, { provider: 'ollama', baseUrl: server.url, vision });
  const telemetry = new Telemetry(f.config.stateDir, 'vision-test');
  await telemetry.event('start', {});
  const budget = new SpendGovernor(join(f.config.stateDir, 'spend.jsonl'), 'vision-test', f.config.policy.budget);
  const folder = await mkdtemp(join(tmpdir(), 'teapilot-vision-')); cleanups.push(() => rm(folder, { recursive: true, force: true }));
  const store = WorkspaceStore.at(folder);
  const workspace = { store, conversation: 'dm:1', delivery: 'post' as const, send: async () => undefined };
  return { ...f, budget, telemetry, store, workspace,
    base: { tier: 'normal' as const, workload: 'ask' as const, web: false, approve: async () => true } };
}

/** The pictures in a request's messages, as data URLs. */
const sentPictures = (body: { messages: unknown[] }) => [...JSON.stringify(body.messages).matchAll(/data:image\/[a-z]+;base64,[A-Za-z0-9+/=]+/g)].map(match => match[0]);

it('declares a model as taking images only when it can see', async () => {
  const { config } = await fixture();
  expect(piModel({ ...config.models.capable, vision: true }).input).toEqual(['text', 'image']);
  expect(piModel({ ...config.models.capable, vision: false }).input).toEqual(['text']);
});

it('records what a runtime says about vision, and what a live check saw', async () => {
  const { config } = await fixture();
  const prepared = { id: 'a', source: 'a', context: 8192, tools: true, roles: ['capable' as const] };
  expect(provisionedOllama({ ...prepared, vision: true }).model.vision).toBe(true);
  expect(provisionedOllama(prepared).model.vision).toBe(false);
  const endpoint = await endpointDriver({ baseUrl: 'http://127.0.0.1:9/v1', id: 'served', contextTokens: 16384 }).provision({ ui: undefined as never, signal: new AbortController().signal });
  expect(endpoint[0]!.model.vision).toBe(false);
  // Images stay off until a check has seen one, as tool calls do.
  config.models.capable.vision = true;
  applyReports(config, ['capable'], new Map([['capable', { ask: true, tools: true, coding: true, spentUsd: 0, vision: true }]]));
  expect(config.models.capable.vision).toBe(true);
  applyReports(config, ['capable'], new Map([['capable', { ask: true, tools: true, coding: true, spentUsd: 0, vision: false }]]));
  expect(config.models.capable.vision).toBe(false);
  config.models.capable.vision = true;
  applyReports(config, ['capable'], new Map([['capable', undefined]]));
  expect(config.models.capable.vision).toBe(false);
  config.models.capable.vision = false;
  applyReports(config, ['capable'], new Map([['capable', { ask: true, tools: true, coding: true, spentUsd: 0, vision: true }]]));
  expect(config.models.capable.vision).toBe(false);
});

it('counts a picture by its size on screen, never by its bytes', async () => {
  const data = (await png(600, 600)).toString('base64');
  const piece = { type: 'image', data, mimeType: 'image/png' };
  const wire = { type: 'image_url', image_url: { url: `data:image/png;base64,${data}` } };
  expect(estimateValueTokens(piece)).toBe(IMAGE_TOKENS);
  expect(estimateValueTokens([wire, wire])).toBe(2 * IMAGE_TOKENS + 4);
  // The words around it count as before.
  expect(estimateValueTokens([{ role: 'user', content: [{ type: 'text', text: 'hello there' }, wire] }])).toBeLessThan(IMAGE_TOKENS + 60);
  expect(imageBytes(JSON.stringify({ messages: [wire, { content: 'data:text/plain;base64,AAAA' }] }))).toBe(wire.image_url.url.length);
});

it('keeps a picture that arrived once, for the next request only', async () => {
  const f = await setup(() => undefined);
  const result = await receiveFiles(f.store, 'dm:1', [
    { name: 'tree.png', size: 100, type: 'image/png', data: async () => png() },
    { name: 'notes.txt', size: 5, data: async () => Buffer.from('hello') },
  ], 'op', 10_000);
  expect(result).toContain('tree.png (PNG image 64×64');
  expect(f.store.takeImages('dm:1')).toEqual(['tree.png']);
  expect(f.store.takeImages('dm:1')).toEqual([]);
  expect(f.store.takeImages('dm:2')).toEqual([]);
});

it('sends a large picture scaled down, a small PNG as it is, and nothing for what is not a picture', async () => {
  const big = await modelImage(await png(3000, 1500), 'image/png');
  expect(big!.mimeType).toBe('image/png');
  expect(await imageInfo(Buffer.from(big!.data, 'base64'))).toMatchObject({ width: IMAGE_SIDE, height: IMAGE_SIDE / 2 });
  const small = await png(64, 64);
  expect((await modelImage(small, 'image/png'))!.data).toBe(small.toString('base64'));
  expect(await modelImage(Buffer.from('not an image'), 'image/png')).toBeUndefined();
  const f = await setup(() => undefined);
  await f.store.save('dm:1', 'tree.png', small, 'op');
  await f.store.save('dm:1', 'notes.txt', Buffer.from('hello'), 'op');
  expect(await workspaceImages(f.store, 'dm:1', ['tree.png', 'notes.txt', 'missing.png'])).toHaveLength(1);
});

it('shows a model that can see the pictures attached to its request, and keeps their bytes out of what is saved', async () => {
  const bodies: any[] = [];
  const steps = [{ tool: { name: 'read', arguments: { path: 'tree.png' } } }, { text: 'a red and blue picture' }];
  const f = await setup((body, _req, res) => { bodies.push(body); completion(res, steps[bodies.length - 1]!); });
  await f.store.save('dm:1', 'tree.png', await png(), 'op');
  const result = await runAttempt({ ...f, ...f.base, prompt: 'what is in tree.png?', activePermissions: ['inference'], workspace: f.workspace, scratch: f.store.scratch('dm:1'), images: ['tree.png'] });
  expect(result.success, JSON.stringify(result)).toBe(true);
  // The picture goes with the first message, and the instructions say the model can see it.
  expect(sentPictures(bodies[0])).toHaveLength(1);
  expect(JSON.stringify(bodies[0].messages)).toContain('You can see images, not hear audio');
  // read gives a picture back as one, and the next call shows the model both.
  expect(sentPictures(bodies[1]).length).toBeGreaterThanOrEqual(2);
  // What is saved for later turns has a note where the read's picture was.
  expect(JSON.stringify(result.steps)).not.toContain('base64');
  expect(JSON.stringify(result.steps)).toContain('picture not kept in history');
  // So does the session's transcript.
  const transcripts = (await readdir(f.store.scratch('dm:1'), { recursive: true })).filter(name => name.endsWith('.jsonl'));
  expect(transcripts).not.toHaveLength(0);
  for (const name of transcripts) expect(await readFile(join(f.store.scratch('dm:1'), name), 'utf8')).not.toContain('base64,');
});

it('shows nothing to a model that cannot see, and says so', async () => {
  const bodies: any[] = [];
  const f = await setup((body, _req, res) => { bodies.push(body); completion(res, { text: 'I cannot see it' }); }, false);
  await f.store.save('dm:1', 'tree.png', await png(), 'op');
  const result = await runAttempt({ ...f, ...f.base, prompt: 'what is in tree.png?', activePermissions: ['inference'], workspace: f.workspace, scratch: f.store.scratch('dm:1'), images: ['tree.png'] });
  expect(result.success, JSON.stringify(result)).toBe(true);
  expect(sentPictures(bodies[0])).toEqual([]);
  expect(JSON.stringify(bodies[0].messages)).toContain('You cannot see images or hear audio');
});

it('admits a request with pictures that would be far over the limit counted as text', async () => {
  const bodies: any[] = [];
  const f = await setup((body, _req, res) => { bodies.push(body); completion(res, { text: 'ok' }); });
  // Noisy pictures do not compress, so their bytes are many times a 32k context if counted as words.
  const { createCanvas } = await canvasLibrary();
  const canvas = createCanvas(600, 600);
  const context = canvas.getContext('2d');
  const pixels = context.createImageData(600, 600);
  pixels.data.set(randomBytes(600 * 600 * 4));
  context.putImageData(pixels, 0, 0);
  const noisy = await canvas.encode('png');
  expect(noisy.length * 4 / 3 / 3).toBeGreaterThan(32768);
  await f.store.save('dm:1', 'noise.png', noisy, 'op');
  const result = await runAttempt({ ...f, ...f.base, prompt: 'describe noise.png', activePermissions: ['inference'], workspace: f.workspace, scratch: f.store.scratch('dm:1'), images: ['noise.png'] });
  expect(result.success, JSON.stringify(result)).toBe(true);
  expect(sentPictures(bodies[0])).toHaveLength(1);
});

it('replaces pictures in saved steps, and in a long run all but the newest two', () => {
  const picture = (id: string) => ({ type: 'image' as const, data: `data-${id}`, mimeType: 'image/png' });
  const result = (id: string, toolCallId: string): Message => ({ role: 'toolResult', toolCallId, toolName: 'read', content: [{ type: 'text', text: `read ${id}` }, picture(id)], isError: false, timestamp: 0 });
  const call = (id: string): Message => ({ role: 'assistant', content: [{ type: 'toolCall', id, name: 'read', arguments: { path: id } }], api: 'openai-completions', provider: 'p', model: 'm', usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } }, stopReason: 'toolUse', timestamp: 0 });
  const user: Message = { role: 'user', content: [{ type: 'text', text: 'look' }, picture('attached')], timestamp: 0 };
  const messages = [user, call('a'), result('a', 'a'), call('b'), result('b', 'b'), call('c'), result('c', 'c')];
  const kept = withoutOldPictures(messages);
  expect(JSON.stringify(kept)).not.toContain('data-attached');
  expect(JSON.stringify(kept)).not.toContain('data-a');
  expect(JSON.stringify(kept)).toContain('data-b');
  expect(JSON.stringify(kept)).toContain('data-c');
  expect(JSON.stringify(kept)).toContain('no longer shown');
  // The same array comes back when nothing is cut, and the originals are never changed.
  expect(withoutOldPictures(kept)).toBe(kept);
  expect(JSON.stringify(messages)).toContain('data-attached');
  const steps = turnSteps(messages);
  expect(JSON.stringify(steps)).not.toContain('data-');
  expect(JSON.stringify(steps)).toContain('picture not kept in history');
});
