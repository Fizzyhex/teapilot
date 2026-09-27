import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import type { Message } from '@earendil-works/pi-ai';
import { fitHistory, turnSteps } from '../src/agents/history.js';
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
