import { afterEach, expect, it, vi } from 'vitest';
import type { AccessStore } from '../src/discord/access-store.js';
import { Conversation, TurnQueue, type CardButton, type CardControls, type ConversationOptions, type DiscordTransport } from '../src/discord/bridge.js';
import { SessionGrants } from '../src/execution/grants.js';
import type { HostResult } from '../src/host.js';
import { fixture } from './helpers.js';

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup(); });

const result: HostResult = { requestId: 'req-1', success: true, status: 'completed', text: 'Done with secret-token.', spentUsd: 0, receipts: [], attempts: 1 };

function discord() {
  const sent: string[] = [];
  const approvals: Array<{ text: string; resolve(approved: boolean): void }> = [];
  /** Every version of the status card, newest last, with the buttons it had then. */
  const cards: Array<{ text: string; controls: CardControls }> = [];
  const transport: DiscordTransport = {
    send: vi.fn(async (text: string) => { sent.push(text); return String(sent.length); }),
    edit: vi.fn(async () => undefined),
    card: vi.fn(async (text: string, controls: CardControls) => { cards.push({ text, controls }); return 'card'; }),
    typing: vi.fn(),
    askApproval: vi.fn((text: string, signal: AbortSignal) => new Promise<boolean>(resolve => {
      approvals.push({ text, resolve });
      signal.addEventListener('abort', () => resolve(false), { once: true });
    })),
  };
  const press = (button: CardButton, userId: string) => cards.at(-1)!.controls.press(button, userId);
  return { sent, approvals, cards, transport, press };
}
/** An operator, a whitelisted user, and anyone else. */
const access = { roleOf: (id: string) => ({ op: 'operator', bob: 'user' } as const)[id as 'op' | 'bob'], adminFor: () => undefined, callerFor: () => () => ({ permissions: [] }) } as unknown as AccessStore;
const finished = (cards: Array<{ text: string }>) => vi.waitFor(() => expect(cards.at(-1)?.text).toMatch(/^-# Result: /));

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

it('runs a turn per message, posts the redacted answer, then collapses the status card to its result', async () => {
  const { sent, cards, transport } = discord();
  const run = vi.fn<ConversationOptions['run']>(async () => { await vi.waitFor(() => expect(cards).toHaveLength(1)); return result; });
  const { chat } = conversation({ transport, run });
  chat.push('What does this repo do?');
  await finished(cards);
  expect(run.mock.calls[0]![0]).toMatchObject({ prompt: 'What does this repo do?', mode: 'ask' });
  expect(sent).toEqual(['Done with [REDACTED].']);
  expect(cards[0]!.text).toMatch(/^🫖 thinking\.+ · 0s$/);
  expect(cards.at(-1)!.text).toBe('-# Result: completed · 0 steps · 0s · accounted $0.000000 · request req-1');
  // Stop goes with the turn; Details stays.
  expect(cards[0]!.controls.stop).toBe(true);
  expect(cards.at(-1)!.controls.stop).toBe(false);
});

it('shows steps, the running tool and the answer being written, and keeps the whole log behind Details', async () => {
  const { cards, transport, press } = discord();
  let release: (() => void) | undefined;
  const run = vi.fn<ConversationOptions['run']>(async (_request, dependencies) => {
    dependencies.onEvent?.({ type: 'tool_execution_start', tool: 'bash', command: 'npm test' });
    await vi.waitFor(() => expect(cards.at(-1)?.text).toMatch(/^⚙️ running shell: npm test/));
    dependencies.onEvent?.({ type: 'tool_execution_end', tool: 'bash', command: 'npm test', isError: true });
    dependencies.onEvent?.({ type: 'text', text: 'The **store** drops secret-token' });
    await vi.waitFor(() => expect(cards.at(-1)?.text).toMatch(/^✍️ writing/));
    await new Promise<void>(resolve => { release = resolve; });
    return result;
  });
  const { chat } = conversation({ transport, run, progressIntervalMs: 1 });
  chat.push('why does it fail?');
  await vi.waitFor(() => expect(release).toBeDefined());
  expect(cards.at(-1)!.text.split('\n').slice(1)).toEqual(['-# shell: npm test — failed', '-# The \\*\\*store\\*\\* drops \\[REDACTED\\]']);
  expect(press('details', 'anyone').text).toMatch(/^\*\*Turn details\*\* · running · 1 step · \d+s\n- shell: npm test — failed$/);
  release!();
  await finished(cards);
  expect(cards.at(-1)!.text).toMatch(/^-# Result: completed · 1 step · /);
});

it('streams reasoning onto the card and keeps it, between the steps, in Details', async () => {
  const { cards, transport, press } = discord();
  let release: (() => void) | undefined;
  const run = vi.fn<ConversationOptions['run']>(async (_request, dependencies) => {
    dependencies.onReasoning?.('the lock is released before the write flushes');
    dependencies.onEvent?.({ type: 'tool_execution_start', tool: 'read', path: 'store.ts' });
    dependencies.onEvent?.({ type: 'tool_execution_end', tool: 'read', path: 'store.ts' });
    dependencies.onReasoning?.('so move the release');
    await new Promise<void>(resolve => { release = resolve; });
    return result;
  });
  const { chat } = conversation({ transport, run, access, progressIntervalMs: 1 });
  chat.push('fix the race', { sender: 'bob' });
  await vi.waitFor(() => expect(release).toBeDefined());
  await vi.waitFor(() => expect(cards.at(-1)?.text).toContain('-# 💭 so move the release'));
  expect(press('details', 'mallory').text).toContain('> 💭 the lock is released before the write flushes\n- read store.ts\n> 💭 so move the release');
  release!();
  await finished(cards);
});

it('lets the person who asked, or an operator, stop the turn from its card', async () => {
  const { sent, cards, transport, press } = discord();
  const run = vi.fn<ConversationOptions['run']>(request => new Promise((_resolve, reject) =>
    request.signal!.addEventListener('abort', () => reject(Object.assign(new Error('aborted'), { name: 'AbortError' })))));
  const { chat } = conversation({ transport, run, access });
  chat.push('long task', { sender: 'bob' });
  await vi.waitFor(() => expect(cards).not.toHaveLength(0));
  expect(press('stop', 'mallory').text).toMatch(/^Only the person who asked/);
  expect(press('stop', 'bob').text).toMatch(/^Stopping/);
  await finished(cards);
  expect(sent).toEqual(['Stopped.']);
  expect(cards.at(-1)!.text).toMatch(/^-# Result: stopped/);
  expect(press('stop', 'op').text).toBe('This turn is already ending.');
});

it('says on the card when a turn waits for an approval, then carries on', async () => {
  const { approvals, cards, transport } = discord();
  const run = vi.fn<ConversationOptions['run']>(async (_request, dependencies) => { await dependencies.approve({ kind: 'shell', summary: 'Run a command' }); return result; });
  const { chat } = conversation({ transport, run, progressIntervalMs: 1 });
  chat.push('run it');
  await vi.waitFor(() => expect(approvals).toHaveLength(1));
  await vi.waitFor(() => expect(cards.at(-1)?.text).toMatch(/^⏸️ waiting for approval/));
  approvals[0]!.resolve(true);
  await vi.waitFor(() => expect(cards.at(-1)?.text).toMatch(/^(🫖 thinking|-# Result)/));
  await finished(cards);
});

it('moves the card on by itself while nothing else happens', async () => {
  const { cards, transport } = discord();
  let release: (() => void) | undefined;
  const run = vi.fn<ConversationOptions['run']>(() => new Promise(resolve => { release = () => resolve(result); }));
  const { chat } = conversation({ transport, run, progressIntervalMs: 1, heartbeatMs: 5 });
  chat.push('think hard');
  await vi.waitFor(() => expect(new Set(cards.map(card => card.text)).size).toBeGreaterThan(2));
  release!();
  await finished(cards);
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
  const { sent, cards, transport } = discord();
  const log = vi.fn();
  const run = vi.fn<ConversationOptions['run']>(async (_request, dependencies) => { dependencies.onEvent?.({ type: 'tool_started', name: 'read' } as never); return result; });
  const { chat } = conversation({ transport, run, log, progressIntervalMs: 1 });
  chat.push('summarise this', { answerOnly: true });
  await vi.waitFor(() => expect(log).toHaveBeenCalledWith(expect.stringMatching(/completed; \$/)));
  expect(sent).toEqual(['Done with [REDACTED].']);
  expect(cards).toEqual([]);
  expect(transport.typing).not.toHaveBeenCalled();
  // The next turn is back to normal.
  chat.push('and again');
  await finished(cards);
});
