import { afterEach, expect, it, vi } from 'vitest';
import { readFile, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import { parse } from 'dotenv';
import { loadConfig } from '../src/config.js';
import { configureDiscord, invitePermissions, removeDiscord } from '../src/discord/setup.js';
import { SetupScreen } from '../src/setup/screen.js';
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

it('saves several channels and replaces a single saved DISCORD_CHANNEL_ID', async () => {
  const p = await profile();
  const [one, two] = ['222222222222222222', '333333333333333333'];
  await writeFile(join(p.cwd, '.env'), `TEAPILOT_ROUTING_MODE="direct"\nDISCORD_CHANNEL_ID="${one}"\n`);
  const terminal = ui(['good-token', alice, `${one}, general`, `${one}, ${two} ${one}`, p.cwd]);
  expect(await configureDiscord({ directory: p.cwd, cwd: p.cwd, api: p.api }, terminal, signal())).toBe(true);
  expect(vi.mocked(terminal.input).mock.calls[2]![1]).toBe(one);
  const env = await p.env();
  expect(env.DISCORD_CHANNEL_IDS).toBe(`${one},${two}`);
  expect(env.DISCORD_CHANNEL_ID).toBeUndefined();
  expect(terminal.logs.join('\n')).toContain(`DMs and @mentions in channels ${one}, ${two}`);
});

/** Drive a screen that is not attached to the terminal, as a user would through keys. */
function driver(screen: SetupScreen) {
  const internals = screen as unknown as { question?: { label: string }; title: string; key(value: string | undefined, key: object): void };
  const describe = () => `${internals.title}\n${internals.question?.label ?? ''}`;
  const until = async (pattern: RegExp) => {
    // Time rather than ticks: the screen's module loads on first use.
    for (const deadline = Date.now() + 5000; Date.now() < deadline;) {
      if (internals.question && pattern.test(describe())) return describe();
      await new Promise(resolve => setImmediate(resolve));
    }
    throw new Error(`Expected ${pattern}, found ${describe()}`);
  };
  const type = (text: string) => { for (const character of text) internals.key(character, { name: character, sequence: character }); };
  return {
    wait: until,
    async answer(pattern: RegExp, text: string) { await until(pattern); type(text); internals.key('\r', { name: 'return' }); },
    async key(pattern: RegExp, name: string) { await until(pattern); internals.key(undefined, { name }); },
  };
}

it('the tabbed screen edits channel and operator lists and saves only on request', async () => {
  const p = await profile();
  const [one, two, three] = ['222222222222222222', '333333333333333333', '444444444444444444'];
  await writeFile(join(p.cwd, '.env'), `TEAPILOT_ROUTING_MODE="direct"\nDISCORD_CHANNEL_ID="${one}"\n`);
  const screen = new SetupScreen({ colour: false, motion: false });
  const terminal = { ...ui([]), screen: () => screen };
  const run = configureDiscord({ directory: p.cwd, cwd: p.cwd, api: p.api }, terminal, signal());
  const drive = driver(screen);
  // A rejected token stays on Bot; a good one moves on to Operators.
  await drive.answer(/^Bot\nChoose/, '1');
  await drive.answer(/Bot token/, 'bad-token');
  await drive.answer(/^Bot\nChoose/, '1');
  await drive.answer(/Bot token/, 'good-token');
  // Operators cannot be left empty.
  await drive.answer(/^Operators/, '1');
  await drive.answer(/^Operators/, '2');
  await drive.answer(/User IDs to add/, 'alice');
  await drive.answer(/^Operators/, '2');
  await drive.answer(/User IDs to add/, alice);
  await drive.wait(/^Operators/);
  expect(screen.markOf('operators')).toBe('changed');
  await drive.answer(/^Operators/, '1');
  // Channels start from the saved one: add two, then remove the saved one.
  await drive.answer(/^Channels/, '3');
  await drive.answer(/Channel IDs to add/, `${two}, ${three}`);
  await drive.answer(/^Channels/, '2');
  await drive.answer(/^Channels/, '1');
  // Repository opens on a choice, so ←/→ still switch tabs from it.
  await drive.key(/^Repository\nChoose/, 'left');
  await drive.answer(/^Channels/, '1');
  await drive.answer(/^Repository\nChoose/, '2');
  await drive.answer(/Repository root/, '');
  await drive.answer(/^Repository\nChoose/, '1');
  expect(await p.env()).not.toHaveProperty('DISCORD_BOT_TOKEN');
  await drive.answer(/^Save these Discord settings/, '1');
  expect(await run).toBe(true);
  const env = await p.env();
  expect(env).toMatchObject({ DISCORD_BOT_TOKEN: 'good-token', DISCORD_ALLOWED_USER_IDS: alice, DISCORD_CHANNEL_IDS: `${two},${three}` });
  expect(env.DISCORD_CHANNEL_ID).toBeUndefined();
  expect(terminal.logs.some(text => text.includes('client_id=999999999999999999'))).toBe(true);
});
