import { afterEach, expect, it, vi } from 'vitest';
import { readFile, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import { parse } from 'dotenv';
import { loadConfig } from '../src/config.js';
import { configureDiscord, invitePermissions, removeDiscord } from '../src/discord/setup.js';
import type { SetupUI } from '../src/setup/terminal.js';
import { fixture, mockServer } from './helpers.js';

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup(); });
const signal = () => new AbortController().signal;
const alice = '111111111111111111';

function ui(inputs: string[], confirms: boolean[] = []): SetupUI & { logs: string[] } {
  const logs: string[] = [];
  return { logs, input: vi.fn(async () => inputs.shift() ?? ''), choose: vi.fn(async () => 0), confirm: vi.fn(async () => confirms.shift() ?? true), log: vi.fn((text: string) => { logs.push(text); }) };
}

async function profile() {
  const f = await fixture(); cleanups.push(f.cleanup);
  await writeFile(join(f.cwd, '.env'), 'TEAPILOT_ROUTING_MODE="direct"\n');
  const requests: Array<{ url?: string; authorization?: string }> = [];
  const server = await mockServer((_body, request, response) => {
    requests.push({ url: request.url, authorization: request.headers.authorization });
    if (request.headers.authorization !== 'Bot good-token') { response.writeHead(401); response.end('{}'); return; }
    response.end(JSON.stringify({ id: '999999999999999999', name: 'teapilot-test', flags: 1 << 18 }));
  });
  cleanups.push(server.close);
  return { ...f, api: server.url, requests, env: async () => parse(await readFile(join(f.cwd, '.env'))) };
}

it('declining the opt-in writes nothing and contacts nobody', async () => {
  const p = await profile();
  const terminal = ui([], [false]);
  expect(await configureDiscord({ directory: p.cwd, cwd: p.cwd, api: p.api }, terminal, signal())).toBe(false);
  expect(await p.env()).toEqual({ TEAPILOT_ROUTING_MODE: 'direct' });
  expect(p.requests).toEqual([]);
});

it('checks the token, re-prompts invalid IDs and saves only after confirmation', async () => {
  const p = await profile();
  const terminal = ui(['bad-token', 'good-token', 'alice', `${alice}, 12`, alice, 'not-a-channel', '', p.cwd]);
  expect(await configureDiscord({ directory: p.cwd, cwd: p.cwd, api: p.api }, terminal, signal())).toBe(true);
  expect(p.requests.map(request => request.url)).toEqual(['/oauth2/applications/@me', '/oauth2/applications/@me']);
  expect(terminal.logs.some(text => text.startsWith('Token check: FAIL'))).toBe(true);
  const env = await p.env();
  expect(env).toMatchObject({ TEAPILOT_ROUTING_MODE: 'direct', DISCORD_BOT_TOKEN: 'good-token', DISCORD_ALLOWED_USER_IDS: alice, DISCORD_START_MODE: 'ask' });
  expect(env.DISCORD_CHANNEL_ID).toBeUndefined();
  expect(env.DISCORD_ROOT).not.toContain('\\');
  expect(terminal.logs.some(text => text.includes(`client_id=999999999999999999&scope=bot&permissions=${invitePermissions}`))).toBe(true);
  expect(terminal.logs.join('\n')).not.toContain('good-token');
  // The model profile still loads unchanged.
  expect((await loadConfig(p.cwd, {})).routingMode).toBe('direct');
});

it('warns when the Message Content intent is off', async () => {
  const f = await fixture(); cleanups.push(f.cleanup);
  await writeFile(join(f.cwd, '.env'), 'TEAPILOT_ROUTING_MODE="direct"\n');
  const server = await mockServer((_body, _request, response) => { response.end(JSON.stringify({ id: '999999999999999999', name: 'bot', flags: 0 })); });
  cleanups.push(server.close);
  const terminal = ui(['token', alice, '', f.cwd], [true, true, false, true]);
  expect(await configureDiscord({ directory: f.cwd, cwd: f.cwd, api: server.url }, terminal, signal())).toBe(true);
  expect(terminal.logs.some(text => text.startsWith('Message Content Intent: not enabled'))).toBe(true);
});

it('requires a teapilot profile first', async () => {
  const f = await fixture(); cleanups.push(f.cleanup);
  const terminal = ui([]);
  expect(await configureDiscord({ directory: f.cwd, cwd: f.cwd }, terminal, signal())).toBe(false);
  expect(terminal.logs[0]).toContain('Run teapilot setup first');
});

it('remove deletes only the Discord keys', async () => {
  const p = await profile();
  await writeFile(join(p.cwd, '.env'), `TEAPILOT_ROUTING_MODE="direct"\nDISCORD_BOT_TOKEN="x"\nDISCORD_ALLOWED_USER_IDS="${alice}"\nDISCORD_ROOT="/repo"\n`);
  expect(await removeDiscord(p.cwd, ui([], [false]), signal())).toBe(false);
  expect((await p.env()).DISCORD_BOT_TOKEN).toBe('x');
  expect(await removeDiscord(p.cwd, ui([]), signal())).toBe(true);
  expect(await p.env()).toEqual({ TEAPILOT_ROUTING_MODE: 'direct' });
});

it('the main setup wizard never offers Discord', async () => {
  const source = await readFile(fileURLToPath(new URL('../src/setup/index.ts', import.meta.url)), 'utf8');
  expect(source).not.toMatch(/discord/i);
});
