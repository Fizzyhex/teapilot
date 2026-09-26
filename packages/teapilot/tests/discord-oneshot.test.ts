import { join } from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import type { DiscordTransport } from '../src/discord/bridge.js';
import type { connect, GatewayHandlers, GatewayReply } from '../src/discord/gateway.js';
import { serveDiscord } from '../src/discord/index.js';
import { completion, fixture, jev, mockServer } from './helpers.js';

const cleanups: Array<() => unknown> = [];
afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup(); });

/** teapilot served against a fake gateway, where every /reply answers through its own interaction. */
async function oneShots() {
  const f = await fixture(); cleanups.push(f.cleanup);
  const prompts: string[] = [];
  const server = await mockServer((body, request, response) => {
    if (request.url === '/jev') jev(response, 'ask.normal');
    else if (request.url?.endsWith('/models')) response.end(JSON.stringify({ data: [{ id: 'fast-test' }, { id: 'capable-test' }] }));
    else { prompts.push(JSON.stringify(body.messages)); completion(response, { text: `answer ${prompts.length}` }); }
  });
  cleanups.push(server.close);
  f.config.router.endpoint = `${server.url}/jev`;
  for (const model of [f.config.models.fast, f.config.models.capable]) model.baseUrl = `${server.url}/v1`;

  let handlers: GatewayHandlers | undefined;
  const fake: typeof connect = async (_settings, given) => {
    handlers = given;
    return { botName: 'teapilot', username: async () => undefined, play: { post: async () => 'm', edit: async () => undefined, request: async () => undefined }, close: async () => undefined };
  };
  const controller = new AbortController();
  const settings = { token: 'simulated-discord-token', allowedUserIds: ['op', 'friend'], channelIds: [], root: f.cwd, startMode: 'ask' as const };
  const done = serveDiscord({ config: f.config, settings, log: () => undefined, signal: controller.signal, connect: fake, stateDir: join(f.cwd, 'discord'), teachat: false });
  cleanups.push(async () => { controller.abort(); await done; });
  await vi.waitFor(() => expect(handlers).toBeDefined());

  let invocations = 0;
  const sent: string[] = [];
  const transport: DiscordTransport = { send: async text => { sent.push(text); return String(sent.length); }, edit: async () => undefined, typing: () => undefined, askApproval: async () => false };
  /** Switch notes shown so far; `pick` is the button pressed on the next one. */
  const notes: string[] = [];
  let pick = 0;
  const reply = (authorId: string, text: string, collab = false) => handlers!.reply({
    authorId, authorIsBot: false, authorName: authorId, guildId: 'guild', channelId: 'channel', ownThread: false, mentionsBot: false,
    content: text, title: text, id: `interaction-${++invocations}`, oneShot: true, answerOnly: false, setup: {}, collab,
    transport: () => transport, startThread: () => Promise.reject(new Error('no threads')), respond: async () => undefined,
    choose: async note => { notes.push(note); return { choice: pick, settle: async settled => { notes.push(settled); }, transport: () => transport }; },
  } satisfies GatewayReply);
  const results = (count: number) => vi.waitFor(() => expect(sent.filter(text => text.includes('Result: completed'))).toHaveLength(count), { timeout: 20_000 });
  const command = (authorId: string, text: string) => new Promise<string | undefined>(resolve => handlers!.command({
    authorId, authorIsBot: false, guildId: 'guild', channelId: 'channel', ownThread: false, mentionsBot: false, text, respond: async note => resolve(note),
  }));
  return { prompts, reply, results, command, notes, press: (index: number) => { pick = index; } };
}

it('continues one history per person per channel across one-shot replies, and /clear ends it', async () => {
  const { prompts, reply, results, command } = await oneShots();
  // Sent together: the second waits for the first, so it sees that turn.
  reply('op', 'my name is oolong');
  reply('op', 'what is my name?');
  await results(2);
  expect(prompts[1]).toContain('my name is oolong');

  reply('friend', 'what is my name?');
  await results(3);
  expect(prompts[2]).not.toContain('oolong');

  expect(await command('op', '/exit')).toMatch(/cleared its history/);
  reply('op', 'what is my name?');
  await results(4);
  expect(prompts[3]).not.toContain('oolong');
}, 60_000);

it('shares a collab between everyone in the channel, and moves people between it and their own conversation', async () => {
  const { prompts, reply, results, command, notes, press } = await oneShots();
  reply('op', 'my name is oolong');
  await results(1);

  // In their own conversation, /collab asks first; switching clears it and sends the prompt to the collab.
  reply('op', 'the secret word is matcha', true);
  await results(2);
  expect(notes).toEqual([expect.stringMatching(/Run \/clear to end it before joining the collab/), 'You left your own conversation. Your prompt goes to the collab.']);
  reply('friend', 'what is the secret word?', true);
  await results(3);
  expect(prompts[2]).toContain('matcha');
  expect(prompts[2]).not.toContain('oolong');

  // Staying sends nothing.
  press(1);
  await reply('friend', 'just me', false);
  expect(notes.at(-1)).toBe('You stayed in the collab. Your prompt was not sent.');
  expect(prompts).toHaveLength(3);

  expect(await command('friend', '/exit')).toBe('Left the collab. Its history stays for everyone still in it.');
  expect(await command('op', '/exit')).toBe('Left the collab. You were the last one in it, so its history was cleared.');
  expect(await command('op', '/exit')).toBe('You are not in a conversation with teapilot here.');
  reply('op', 'what is the secret word?', true);
  await results(4);
  expect(prompts[3]).not.toContain('matcha');
}, 60_000);
