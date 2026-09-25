import { afterEach, expect, it, vi } from 'vitest';
import { Conversation, TurnQueue, type ConversationOptions, type DiscordTransport } from '../src/discord/bridge.js';
import { SessionGrants } from '../src/execution/grants.js';
import type { HostResult } from '../src/host.js';
import { fixture } from './helpers.js';

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup(); });

const result: HostResult = { requestId: 'req-1', success: true, status: 'completed', text: 'Done with secret-token.', spentUsd: 0, receipts: [], attempts: 1 };

function discord() {
  const sent: string[] = [];
  const approvals: Array<{ text: string; resolve(approved: boolean): void }> = [];
  const transport: DiscordTransport = {
    send: vi.fn(async (text: string) => { sent.push(text); return String(sent.length); }),
    edit: vi.fn(async () => undefined),
    typing: vi.fn(),
    askApproval: vi.fn((text: string, signal: AbortSignal) => new Promise<boolean>(resolve => {
      approvals.push({ text, resolve });
      signal.addEventListener('abort', () => resolve(false), { once: true });
    })),
  };
  return { sent, approvals, transport };
}

function conversation(overrides: Partial<ConversationOptions> & Pick<ConversationOptions, 'transport'>) {
  const controller = new AbortController();
  const chat = new Conversation({
    key: 'dm:test', queue: new TurnQueue(), maxPromptChars: 20_000, log: vi.fn(),
    redact: text => text.replaceAll('secret-token', '[REDACTED]'),
    request: { prompt: '', cwd: '.', mode: 'ask', signal: controller.signal },
    run: vi.fn(async () => result),
    ...overrides,
    ...(overrides.request ? { request: { ...overrides.request, signal: controller.signal } } : {}),
  });
  cleanups.push(async () => { controller.abort(); await chat.done; });
  return { chat, controller };
}

it('runs a turn per message and posts the redacted answer with a result line', async () => {
  const { sent, transport } = discord();
  const run = vi.fn<ConversationOptions['run']>(async () => result);
  const { chat } = conversation({ transport, run });
  chat.push('What does this repo do?');
  await vi.waitFor(() => expect(sent.some(text => text.startsWith('-# Result: completed'))).toBe(true));
  expect(run.mock.calls[0]![0]).toMatchObject({ prompt: 'What does this repo do?', mode: 'ask' });
  expect(sent).toContain('Done with [REDACTED].');
});

it('asks for tool approval with buttons and returns the clicked answer', async () => {
  const { approvals, transport } = discord();
  const answers: boolean[] = [];
  const run = vi.fn(async (_request, dependencies) => {
    answers.push(await dependencies.approve({ kind: 'shell', summary: 'Run a command', details: 'echo secret-token' }));
    return result;
  }) as ConversationOptions['run'];
  const { chat } = conversation({ transport, run });
  chat.push('run it');
  await vi.waitFor(() => expect(approvals).toHaveLength(1));
  expect(approvals[0]!.text).toContain('echo [REDACTED]');
  expect(approvals[0]!.text).toContain('(shell)');
  approvals[0]!.resolve(true);
  await vi.waitFor(() => expect(answers).toEqual([true]));
});

it('denies an approval nobody answers before the timeout', async () => {
  const { transport } = discord();
  const answers: boolean[] = [];
  const run = vi.fn(async (_request, dependencies) => { answers.push(await dependencies.approve({ kind: 'overwrite', summary: 'Overwrite a.ts' })); return result; }) as ConversationOptions['run'];
  const { chat } = conversation({ transport, run, approvalTimeoutMs: 20 });
  chat.push('go');
  await vi.waitFor(() => expect(answers).toEqual([false]));
});

it('requests code access through an approval and keeps the mode when denied', async () => {
  const f = await fixture(); cleanups.push(f.cleanup);
  const { sent, approvals, transport } = discord();
  const authorization = await SessionGrants.create(f.cwd, f.config, 'ask');
  const { chat } = conversation({ transport, request: { prompt: '', cwd: f.cwd, mode: 'ask', authorization } });
  chat.push('/mode code');
  await vi.waitFor(() => expect(approvals).toHaveLength(1));
  expect(approvals[0]!.text).toContain('(capability)');
  approvals[0]!.resolve(false);
  await vi.waitFor(() => expect(sent).toContain('Code access was not approved; mode unchanged.'));
  expect(authorization.list()).not.toContain('repository.write');
});

it('refuses /cd so the repository root stays fixed', async () => {
  const { sent, transport } = discord();
  const run = vi.fn(async () => result);
  const { chat } = conversation({ transport, run });
  chat.push('/cd ..');
  await vi.waitFor(() => expect(sent.some(text => text.includes('root is fixed'))).toBe(true));
  expect(run).not.toHaveBeenCalled();
});

it('/stop cancels only the running turn; the conversation continues', async () => {
  const { sent, transport } = discord();
  let calls = 0;
  const run = vi.fn(async request => {
    if (++calls > 1) return result;
    await new Promise((_resolve, reject) => request.signal!.addEventListener('abort', () => reject(Object.assign(new Error('aborted'), { name: 'AbortError' }))));
    return result;
  }) as ConversationOptions['run'];
  const { chat } = conversation({ transport, run });
  chat.push('long task');
  await vi.waitFor(() => expect(run).toHaveBeenCalledTimes(1));
  chat.push('/stop');
  await vi.waitFor(() => expect(sent).toContain('Stopped.'));
  chat.push('next');
  await vi.waitFor(() => expect(run).toHaveBeenCalledTimes(2));
  expect(chat.active).toBe(true);
});

it('/exit ends the session and a stopped process ends it quietly', async () => {
  const { sent, transport } = discord();
  const { chat } = conversation({ transport });
  chat.push('/exit');
  await chat.done;
  expect(chat.active).toBe(false);
  expect(sent.at(-1)).toContain('Session ended');

  const second = discord();
  const { chat: quiet, controller } = conversation({ transport: second.transport });
  controller.abort();
  await quiet.done;
  expect(second.sent).toEqual([]);
});

it('serialises turns across conversations and tells the waiting one', async () => {
  const queue = new TurnQueue();
  const order: string[] = [];
  let release!: () => void;
  const first = queue.run(async () => { order.push('first start'); await new Promise<void>(resolve => { release = resolve; }); order.push('first end'); });
  const waited = vi.fn();
  const second = queue.run(async () => { order.push('second'); }, waited);
  await vi.waitFor(() => expect(order).toEqual(['first start']));
  expect(waited).toHaveBeenCalledTimes(1);
  release();
  await Promise.all([first, second]);
  expect(order).toEqual(['first start', 'first end', 'second']);
});

it('sends only the answer to Discord for an answer-only turn and logs the rest', async () => {
  const { sent, transport } = discord();
  const log = vi.fn();
  const run = vi.fn<ConversationOptions['run']>(async (_request, dependencies) => { dependencies.onEvent?.({ type: 'tool_started', name: 'read' } as never); return result; });
  const { chat } = conversation({ transport, run, log, progressIntervalMs: 1 });
  chat.push('summarise this', { answerOnly: true });
  await vi.waitFor(() => expect(log).toHaveBeenCalledWith(expect.stringMatching(/completed; \$/)));
  expect(sent).toEqual(['Done with [REDACTED].']);
  expect(transport.typing).not.toHaveBeenCalled();
  // The next turn is back to normal.
  chat.push('and again');
  await vi.waitFor(() => expect(sent.some(text => text.startsWith('-# Result: completed'))).toBe(true));
});
