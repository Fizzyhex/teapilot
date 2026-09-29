import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import type { Message } from '@earendil-works/pi-ai';
import { carryOver, fitHistory, supersedePlayCalls, supersedeReads, turnSteps, withoutOldThinking } from '../src/agents/history.js';
import { Conversation, TurnQueue, type ConversationOptions } from '../src/discord/bridge.js';
import { HistoryStore } from '../src/discord/history-store.js';
import type { HostResult } from '../src/host.js';
import type { ConversationTurn } from '../src/integration/events.js';
import { emptyUsage } from '../src/integration/inference.js';

const cleanups: Array<() => unknown> = [];
afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup(); });

const model = { provider: 'mock', id: 'mock-model' };
const assistant = (content: Extract<Message, { role: 'assistant' }>['content']): Message =>
  ({ role: 'assistant', content, api: 'openai-completions', provider: 'mock', model: 'mock-model', timestamp: 0, usage: emptyUsage(), stopReason: 'toolUse' });
const call = (id: string, code: string): Message => assistant([{ type: 'text', text: '```js\n' + code + '\n```' }, { type: 'toolCall', id, name: 'play_start', arguments: { title: 'Game' } }]);
const result = (id: string, text: string): Message => ({ role: 'toolResult', toolCallId: id, toolName: 'play_start', content: [{ type: 'text', text }], isError: false, timestamp: 0 });
const code = 'const line = 1;\n'.repeat(60);
const turn = (index: number): ConversationTurn => ({ user: `request ${index}`, assistant: `answer ${index}`, steps: [call(`c${index}`, code), result(`c${index}`, `Started app a${index}. ${'preview '.repeat(100)}`)] });

it('keeps what the tools did, without reasoning or a call that never got its result', () => {
  const steps = turnSteps([
    { role: 'user', content: '[host notice] tools changed', timestamp: 0 },
    assistant([{ type: 'thinking', thinking: 'hmm' }, { type: 'toolCall', id: 'a', name: 'play_start', arguments: {} }]),
    result('a', 'Started app x.'),
    assistant([{ type: 'text', text: 'one more' }, { type: 'toolCall', id: 'b', name: 'play_update', arguments: {} }]),
  ]);
  expect(steps.map(step => step.role)).toEqual(['assistant', 'toolResult', 'assistant']);
  expect(JSON.stringify(steps)).not.toContain('hmm');
  expect(JSON.stringify(steps)).not.toContain('play_update');
});

it('replays the newest turn in full and cuts older ones down to fit the budget', () => {
  const turns = [turn(1), turn(2), turn(3)];
  const roomy = JSON.stringify(fitHistory(turns, 100_000, model));
  expect(roomy.split('const line = 1;').length - 1).toBe(60);
  expect(roomy).toContain('60-line code block from an earlier turn omitted');
  expect(roomy).toContain('Started app a1.');
  expect(roomy).toContain('…[clipped]');

  // Tighter: older turns fall back to their text, then drop out, before the newest loses its steps.
  const tight = fitHistory(turns, 1500, model);
  expect(tight.at(-1)).toMatchObject({ role: 'assistant', content: [{ text: 'answer 3' }] });
  expect(JSON.stringify(tight)).toContain('play_start');
  expect(JSON.stringify(tight)).not.toContain('Started app a1.');
  expect(fitHistory(turns, 0, model)).toEqual([]);
  // Turns that drop out leave a count where the rest begin, so the gap is known rather than guessed across.
  expect(tight[0]).toMatchObject({ role: 'user', content: expect.stringMatching(/^\[2 earlier turns of this conversation are not shown here\.\]\n/) });
  expect(JSON.stringify(fitHistory(turns, 100_000, model))).not.toContain('not shown here');
  // compactAll cuts the newest turn's steps down too, while every turn stays.
  const compacted = JSON.stringify(fitHistory(turns, 100_000, model, undefined, true));
  expect(compacted).not.toContain('const line = 1;');
  expect(compacted).toContain('answer 1');
});

it('cuts app calls a later one superseded: unapplied ones always, applied ones under pressure, never the newest', () => {
  const edits = [{ find: 'x'.repeat(2000), replace: 'y'.repeat(2000) }];
  const update = (id: string) => assistant([{ type: 'text', text: '```js\n' + code + '\n```' }, { type: 'toolCall', id, name: 'play_update', arguments: { edits } }]);
  const outcome = (id: string, text: string): Message => ({ role: 'toolResult', toolCallId: id, toolName: 'play_update', content: [{ type: 'text', text }], isError: false, timestamp: 0 });
  const messages = [update('u1'), outcome('u1', 'Edit 1: its find text occurs 0 times. Nothing was changed.'), update('u2'), outcome('u2', 'Updated app a.'), update('u3'), outcome('u3', 'Updated app a.')];
  const size = (message: Message) => JSON.stringify(message).length;
  const calm = supersedePlayCalls(messages, false);
  expect(size(calm[0]!)).toBeLessThan(size(messages[0]!) / 2);
  expect(calm[2]).toBe(messages[2]);
  const pressed = supersedePlayCalls(messages, true);
  expect(size(pressed[2]!)).toBeLessThan(size(messages[2]!) / 2);
  expect(JSON.stringify(pressed[2])).toContain('code block from an earlier turn omitted');
  expect(pressed[4]).toBe(messages[4]);
  const alone = messages.slice(4);
  expect(supersedePlayCalls(alone, true)).toBe(alone);
});

const read = (id: string, path: string, window: { offset?: number; limit?: number } = {}) => assistant([{ type: 'toolCall', id, name: 'read', arguments: { path, ...window } }]);
const lines = (id: string, text: string): Message => ({ role: 'toolResult', toolCallId: id, toolName: 'read', content: [{ type: 'text', text }], isError: false, timestamp: 0 });
const textOf = (message: Message) => JSON.stringify(message.content);

it('cuts a read that a later read of the same lines covers, and keeps reads of other lines or files', () => {
  const resolve = (path: string) => path.replace(/^\.\//, '/w/').replace(/^(?!\/)/, '/w/');
  const messages = [
    read('r1', 'scene.py'), lines('r1', 'lines 1-200 (old)'),
    read('r2', 'scene.py', { offset: 201 }), lines('r2', 'lines 201-400'),
    read('r3', 'torus.py'), lines('r3', 'torus'),
    read('r4', 'scene.py', { offset: 40, limit: 60 }), lines('r4', 'lines 40-99'),
    read('r5', './scene.py'), lines('r5', 'lines 1-200 (new)'),
  ];
  const cut = supersedeReads(messages, resolve);
  // r5 reads lines 1-200 of the same file again, covering r1 and r4; r2 (201-400) and the other file stay.
  expect(textOf(cut[1]!)).toContain('[Superseded: a later read of scene.py shows these lines as they are now.]');
  expect(textOf(cut[7]!)).toContain('Superseded');
  expect(cut[3]).toBe(messages[3]);
  expect(cut[5]).toBe(messages[5]);
  expect(cut[9]).toBe(messages[9]);
  // Calls are untouched, so every result still has its call; cutting again changes nothing.
  expect(cut.filter((_, index) => index % 2 === 0)).toEqual(messages.filter((_, index) => index % 2 === 0));
  expect(supersedeReads(cut, resolve)).toBe(cut);
  expect(supersedeReads(messages.slice(0, 6), resolve)).toEqual(messages.slice(0, 6));
});

it('keeps thinking only on the newest reply', () => {
  const messages = [
    assistant([{ type: 'thinking', thinking: 'plan the first step' }, { type: 'toolCall', id: 'a', name: 'read', arguments: { path: 'x' } }]), lines('a', 'x'),
    assistant([{ type: 'thinking', thinking: 'only thought' }]),
    assistant([{ type: 'thinking', thinking: 'plan the next step' }, { type: 'toolCall', id: 'b', name: 'read', arguments: { path: 'y' } }]), lines('b', 'y'),
  ];
  const kept = withoutOldThinking(messages);
  expect(textOf(kept[0]!)).not.toContain('plan the first step');
  expect(kept[0]!.role === 'assistant' && kept[0]!.content.some(part => part.type === 'toolCall')).toBe(true);
  // A reply of nothing but thinking would be left empty, so it stays as it was.
  expect(kept[2]).toBe(messages[2]);
  expect(kept[3]).toBe(messages[3]);
  expect(withoutOldThinking(kept)).toBe(kept);
});

it('carries an attempt over without a reply that was cut off or failed, or calls that lost their results', () => {
  const ended = (stopReason: 'length' | 'error', content: Extract<Message, { role: 'assistant' }>['content'] = []): Message => ({ ...assistant(content), stopReason } as Message);
  const request: Message = { role: 'user', content: 'make a space scene', timestamp: 0 };
  const carried = carryOver([
    request, read('a', 'scene.py'), lines('a', 'scene'),
    assistant([{ type: 'text', text: 'running it' }, { type: 'toolCall', id: 'b', name: 'bash', arguments: { command: 'python scene.py' } }]),
    ended('length', [{ type: 'text', text: '```python\nimport numpy' }]),
  ])!;
  // The run never got a result, so only its text is kept; the reply cut off at the output limit goes.
  expect(carried).toHaveLength(4);
  expect(carried.slice(0, 3)).toEqual([request, read('a', 'scene.py'), lines('a', 'scene')]);
  expect(textOf(carried[3]!)).toContain('running it');
  expect(textOf(carried[3]!)).not.toContain('python scene.py');
  expect(carried[3]).toMatchObject({ stopReason: 'stop' });
  expect(carryOver([request, ended('error')])).toBeUndefined();
});

it('keeps a Discord conversation\'s turns, steps included, and removes them when cleared', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'teapilot-history-'));
  cleanups.push(() => rm(directory, { recursive: true, force: true }));
  const store = new HistoryStore(directory);
  expect(store.load('dm:1')).toEqual([]);
  store.save('dm:1', [turn(1)]);
  expect(new HistoryStore(directory).load('dm:1')).toEqual([turn(1)]);
  store.save('dm:1', []);
  expect(store.load('dm:1')).toEqual([]);
});

it('reports each turn with its steps, and clears the history on /new', async () => {
  const controller = new AbortController();
  const histories: ConversationTurn[][] = [];
  const answer: HostResult = { requestId: 'r', success: true, status: 'completed', text: 'Built it.', spentUsd: 0, receipts: [], attempts: 1, steps: turn(1).steps };
  const run = vi.fn<ConversationOptions['run']>(async () => answer);
  const chat = new Conversation({
    key: 'dm:test', queue: new TurnQueue(), maxPromptChars: 20_000, log: vi.fn(), redact: text => text, run,
    transport: { send: vi.fn(async () => '1'), edit: vi.fn(async () => undefined), card: vi.fn(async () => 'card'), typing: vi.fn(), askApproval: vi.fn(async () => false) },
    request: { prompt: '', cwd: '.', mode: 'ask', signal: controller.signal, history: [{ user: 'earlier', assistant: 'before a restart' }] },
    onHistory: history => histories.push(history),
  });
  cleanups.push(async () => { controller.abort(); await chat.done; });
  chat.push('make a game');
  await vi.waitFor(() => expect(histories).toHaveLength(1));
  expect(run.mock.calls[0]![0].history).toEqual([{ user: 'earlier', assistant: 'before a restart' }]);
  expect(histories[0]).toEqual([{ user: 'earlier', assistant: 'before a restart' }, { user: 'make a game', assistant: 'Built it.', steps: turn(1).steps }]);
  chat.push('/new');
  await vi.waitFor(() => expect(histories.at(-1)).toEqual([]));
});

it('never cuts an earlier turn through the middle of an emoji', () => {
  // A long result made of emoji is compacted to its first 400 characters, which here falls inside one.
  const result = { role: 'toolResult', toolCallId: 'c1', toolName: 'play_inspect', content: [{ type: 'text', text: 'x' + '🌽'.repeat(300) }], isError: false, timestamp: 0 } as unknown as Message;
  const call = { role: 'assistant', content: [{ type: 'toolCall', id: 'c1', name: 'play_inspect', arguments: {} }], api: 'openai-completions', provider: 'x', model: 'y', usage: emptyUsage(), stopReason: 'toolUse', timestamp: 0 } as unknown as Message;
  const turns: ConversationTurn[] = [{ user: 'a', assistant: 'b', steps: [call, result] }, { user: 'c', assistant: 'd' }];
  const fitted = [500, 1000, 1500, 2000, 3000].map(budget => fitHistory(turns, budget, { provider: 'x', id: 'y' } as never)
    .flatMap(message => typeof message.content === 'string' ? [message.content] : message.content.map(part => part.type === 'text' ? part.text : '')).join(''));
  expect(fitted.some(text => text.includes('…[clipped]'))).toBe(true);
  expect(fitted.join('')).not.toMatch(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/);
});
