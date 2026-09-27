import { afterEach, expect, it, vi } from 'vitest';
import { casualPrompt } from '../src/agents/casual.js';
import { casualLines, paceLines } from '../src/casual.js';
import { Conversation, TurnQueue, type CardControls, type ConversationOptions, type DiscordTransport } from '../src/discord/bridge.js';
import { SessionGrants } from '../src/execution/grants.js';
import { runHost, type HostResult } from '../src/host.js';
import { readCasual } from '../src/routing/intent.js';
import { completion, fixture, jev, mockServer } from './helpers.js';

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup(); });

const answer = (choice: string, confidence = 0.99) => ({ type: 'choice', choice, probabilities: { [choice]: 1 }, confidence });
const signals = (fields: Record<string, ReturnType<typeof answer>>): any => ({ answers: Object.fromEntries(
  ['threat', 'personal', 'existential', 'banter', 'romance', 'task', 'make'].map(key => [`conversation.${key}`, fields[key] ?? answer('no')])) });

it('enters conversational mode on a confident + signal only when every - signal is a confident no', () => {
  expect(readCasual(signals({ banter: answer('yes') }), 0.55)).toBe(true);
  expect(readCasual(signals({ romance: answer('yes'), existential: answer('yes') }), 0.55)).toBe(true);
  expect(readCasual(signals({}), 0.55)).toBe(false);
  expect(readCasual(signals({ banter: answer('yes'), task: answer('yes') }), 0.55)).toBe(false);
  expect(readCasual(signals({ banter: answer('yes'), make: answer('unclear') }), 0.55)).toBe(false);
  expect(readCasual(signals({ banter: answer('yes'), make: answer('no', 0.3) }), 0.55)).toBe(false);
  expect(readCasual(signals({ banter: answer('yes', 0.3) }), 0.55)).toBe(false);
  const missing = signals({ personal: answer('yes') }); delete missing.answers['conversation.task'];
  expect(readCasual(missing, 0.55)).toBe(false);
  expect(readCasual(undefined, 0.55)).toBe(false);
});

it('splits a conversational reply into its lines, including a literal \\n, and leaves code alone', () => {
  expect(casualLines('duno mate\\n my source is public haha')).toEqual(['duno mate', 'my source is public haha']);
  expect(casualLines('_ _\nyea ig we all want things jake :3\n\n')).toEqual(['_ _', 'yea ig we all want things jake :3']);
  expect(casualLines('look\n```js\nx()\n```')).toBeUndefined();
  expect(casualLines(Array.from({ length: 9 }, (_, index) => `line ${index}`).join('\n'))).toBeUndefined();
});

it('sends the first line at once and types before each later one', async () => {
  const calls: string[] = [];
  await paceLines(['a', 'b', 'c'], line => { calls.push(line); }, { typing: () => calls.push('typing'), delayMs: () => 0 });
  expect(calls).toEqual(['a', 'typing', 'b', 'typing', 'c']);
});

async function route(conversation: Record<string, 'yes' | 'no'>, selected = 'ask.deep') {
  const f = await fixture(); cleanups.push(f.cleanup);
  const bodies: any[] = [];
  const server = await mockServer((body, request, response) => {
    if (request.url === '/jev') {
      expect(Object.keys(body.questions)).toEqual(expect.arrayContaining(['conversation.banter', 'conversation.task', 'conversation.make']));
      jev(response, selected, 0.99, undefined, {}, 0.99, conversation);
    } else { bodies.push(body); completion(response, { text: 'duno mate\\n my source is public haha' }); }
  });
  cleanups.push(server.close);
  f.config.router.endpoint = `${server.url}/jev`;
  f.config.models.fast.baseUrl = server.url;
  f.config.models.capable.baseUrl = server.url;
  const grants = await SessionGrants.create(f.cwd, f.config, 'chat');
  const events: any[] = [];
  const result = await runHost(f.config, { cwd: f.cwd, prompt: 'are you conscious?', mode: 'chat', authorization: grants }, { approve: async () => false, localProbe: async () => true, onEvent: event => events.push(event) });
  return { result, bodies, events };
}

it('answers a conversational message on the least-reasoning ask tier, with the casual prompt and no tools', async () => {
  const { result, bodies, events } = await route({ existential: 'yes' });
  expect(result).toMatchObject({ success: true, capability: 'ask.normal', casual: true });
  expect(events).toContainEqual({ type: 'route', capability: 'ask.normal', casual: true });
  expect(bodies).toHaveLength(1);
  expect(bodies[0].tools ?? []).toEqual([]);
  const system = bodies[0].messages[0].content;
  expect(system).toContain(casualPrompt());
  expect(system).not.toContain('request_capabilities');
});

it('keeps a task an ordinary turn even when it is also banter', async () => {
  const { result, events } = await route({ banter: 'yes', task: 'yes' }, 'ask.normal');
  expect(result.casual).toBeUndefined();
  expect(events).toContainEqual({ type: 'route', capability: 'ask.normal', casual: false });
});

function discord() {
  const sent: string[] = [];
  const log: string[] = [];
  const cards: string[] = [];
  const transport: DiscordTransport = {
    send: vi.fn(async (text: string) => { sent.push(text); log.push(`send ${text}`); return String(sent.length); }),
    edit: vi.fn(async () => undefined),
    card: vi.fn(async (text: string, _controls: CardControls) => { cards.push(text); return 'card'; }),
    typing: vi.fn(() => { log.push('typing'); }),
    askApproval: vi.fn(async () => false),
  };
  return { sent, log, cards, transport };
}
function conversation(transport: DiscordTransport, run: ConversationOptions['run']) {
  const controller = new AbortController();
  const chat = new Conversation({ key: 'dm:test', transport, queue: new TurnQueue(), maxPromptChars: 20_000, log: vi.fn(), redact: text => text,
    request: { prompt: '', cwd: '.', mode: 'chat', signal: controller.signal }, run, cardDelayMs: 60_000, lineDelayMs: () => 0 });
  cleanups.push(async () => { controller.abort(); await chat.done; });
  return chat;
}
const reply: HostResult = { requestId: 'req-1', success: true, status: 'completed', text: '_ _\nyea ig we all want things jake :3', spentUsd: 0, receipts: [], attempts: 1, casual: true };

it('sends a conversational reply a line at a time with typing, and no status card or result', async () => {
  const { sent, log, cards, transport } = discord();
  const chat = conversation(transport, async (_request, dependencies) => {
    dependencies.onEvent?.({ type: 'route', capability: 'ask.normal', casual: true });
    dependencies.onEvent?.({ type: 'text', text: 'yea' });
    return reply;
  });
  chat.push('i want you so bad');
  await vi.waitFor(() => expect(sent).toHaveLength(2));
  expect(log.slice(-3)).toEqual(['send _ _', 'typing', 'send yea ig we all want things jake :3']);
  await new Promise(resolve => setTimeout(resolve, 20));
  expect(cards).toEqual([]);
});

it('still shows the card and result for an ordinary turn', async () => {
  const { sent, cards, transport } = discord();
  const chat = conversation(transport, async (_request, dependencies) => {
    dependencies.onEvent?.({ type: 'route', capability: 'ask.normal', casual: false });
    return { ...reply, casual: undefined, text: 'line one\nline two' };
  });
  chat.push('explain closures');
  await vi.waitFor(() => expect(cards.at(-1)).toMatch(/^-# Result: /));
  expect(sent).toEqual(['line one\nline two']);
});
