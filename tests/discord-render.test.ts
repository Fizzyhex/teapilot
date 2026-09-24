import { expect, it, vi } from 'vitest';
import { route, type IncomingMessage } from '../src/discord/access.js';
import { chunk, ProgressLine, throttle } from '../src/discord/render.js';
import { readDiscordSettings } from '../src/discord/settings.js';

const alice = '111111111111111111', mallory = '222222222222222222', channel = '333333333333333333', guild = '444444444444444444';
const settings = { allowedUserIds: [alice], channelId: channel };
const message = (fields: Partial<IncomingMessage>): IncomingMessage => ({ authorId: alice, authorIsBot: false, channelId: '555555555555555555', ownThread: false, mentionsBot: false, ...fields });

it('routes allowlisted DMs, owned threads and channel mentions, and ignores everything else', () => {
  expect(route(message({}), settings)).toEqual({ key: 'dm:555555555555555555', kind: 'dm' });
  expect(route(message({ authorId: mallory }), settings)).toBeUndefined();
  expect(route(message({ authorIsBot: true }), settings)).toBeUndefined();
  expect(route(message({ guildId: guild, channelId: channel }), settings)).toBeUndefined();
  expect(route(message({ guildId: guild, channelId: channel, mentionsBot: true }), settings)).toEqual({ key: '', kind: 'new-thread' });
  expect(route(message({ guildId: guild, channelId: '666666666666666666', mentionsBot: true }), settings)).toBeUndefined();
  expect(route(message({ guildId: guild, channelId: '777777777777777777', parentId: channel, ownThread: true }), settings)).toEqual({ key: 'thread:777777777777777777', kind: 'thread' });
  expect(route(message({ guildId: guild, channelId: '777777777777777777', parentId: channel, ownThread: false }), settings)).toBeUndefined();
  expect(route(message({ guildId: guild, channelId: channel, mentionsBot: true }), { allowedUserIds: [alice] })).toBeUndefined();
});

it('fails closed without a token, root or allowlist and rejects malformed IDs', () => {
  const env = { DISCORD_BOT_TOKEN: 'token', DISCORD_ALLOWED_USER_IDS: alice, DISCORD_ROOT: '/repo' };
  expect(readDiscordSettings(env)).toMatchObject({ allowedUserIds: [alice], startMode: 'ask', channelId: undefined });
  expect(() => readDiscordSettings({ ...env, DISCORD_ALLOWED_USER_IDS: '' })).toThrow(/teapilot discord setup/);
  expect(() => readDiscordSettings({ ...env, DISCORD_ALLOWED_USER_IDS: 'alice' })).toThrow(/allowedUserIds/);
  expect(() => readDiscordSettings({ ...env, DISCORD_START_MODE: 'code' })).toThrow(/startMode/);
});

it('splits long answers within the message limit and keeps code fences balanced', () => {
  expect(chunk('short answer')).toEqual(['short answer']);
  expect(chunk('')).toEqual([]);
  const code = ['```ts', ...Array.from({ length: 200 }, (_, index) => `const value${index} = ${index};`), '```'].join('\n');
  const text = `Intro paragraph.\n\n${code}\n\nClosing words.`;
  const parts = chunk(text, 500);
  expect(parts.length).toBeGreaterThan(1);
  for (const part of parts) {
    expect(part.length).toBeLessThanOrEqual(500);
    expect(part.split('\n').filter(line => line.startsWith('```')).length % 2).toBe(0);
  }
  expect(parts.slice(1, -1).every(part => part.startsWith('```ts'))).toBe(true);
  expect(parts.join('\n')).toContain('const value199 = 199;');
  expect(parts.at(-1)).toContain('Closing words.');
});

it('hard-splits a single line longer than the limit', () => {
  const parts = chunk('x'.repeat(4500));
  expect(parts.map(part => part.length).every(length => length <= 2000)).toBe(true);
  expect(parts.join('')).toBe('x'.repeat(4500));
});

it('folds tool events into one redacted progress message', () => {
  const progress = new ProgressLine(text => text.replace('secret', '[REDACTED]'), 2);
  expect(progress.push({ type: 'text', text: 'ignored' })).toBe(false);
  progress.push({ type: 'tool_execution_start', tool: 'read' });
  expect(progress.render()).toBe('- running read...');
  progress.push({ type: 'tool_execution_end', tool: 'read', path: 'a.ts' });
  progress.push({ type: 'tool_execution_end', tool: 'bash', command: 'echo secret' });
  progress.push({ type: 'tool_execution_end', tool: 'write', path: 'b.ts', size: 10, isError: true });
  expect(progress.render()).toBe('- ... 1 earlier\n- shell: echo [REDACTED]\n- write b.ts (10 B) — failed');
});

it('coalesces frequent progress updates and delivers the latest on flush', async () => {
  const action = vi.fn(async () => undefined);
  const update = throttle(action, 10_000);
  update.request(); update.request(); update.request();
  await vi.waitFor(() => expect(action).toHaveBeenCalledTimes(1));
  update.request(); update.request();
  expect(action).toHaveBeenCalledTimes(1);
  await update.flush();
  expect(action).toHaveBeenCalledTimes(2);
});
