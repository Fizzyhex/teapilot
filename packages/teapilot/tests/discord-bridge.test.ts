import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import type { Message as AnswerMessage } from 'pretty-send';
import { afterEach, expect, it, vi } from 'vitest';
import type { AccessStore } from '../src/discord/access-store.js';
import { Conversation, TurnQueue, type CardButton, type CardControls, type ConversationOptions, type DiscordTransport } from '../src/discord/bridge.js';
import { SessionGrants, type SavedGrants } from '../src/execution/grants.js';
import { grantControls } from '../src/discord/grants-panel.js';
import type { HostResult } from '../src/host.js';
import { WorkspaceStore } from '../src/workspace/store.js';
import { fixture } from './helpers.js';
import { World } from '../scripts/discord-sim/world.js';
import { TurnEvents } from '../scripts/discord-sim/turn-events.js';

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup(); });

const result: HostResult = { requestId: 'req-1', success: true, status: 'completed', text: 'Done with secret-token.', spentUsd: 0, receipts: [], attempts: 1 };

function discord() {
  const sent: string[] = [];
  const approvals: Array<{ text: string; resolve(approved: boolean): void }> = [];
  const continuations: Array<{ text: string; timeoutMs?: number; resolve(outcome: 'approved' | 'denied' | 'auto-approved'): void }> = [];
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
    askContinuationBudget: vi.fn((text: string, signal: AbortSignal, timeoutMs?: number) => new Promise<'approved' | 'denied' | 'auto-approved'>(resolve => {
      continuations.push({ text, timeoutMs, resolve });
      signal.addEventListener('abort', () => resolve('denied'), { once: true });
    })),
  };
  const press = (button: CardButton, userId: string) => cards.at(-1)!.controls.press(button, userId);
  return { sent, approvals, continuations, cards, transport, press };
}
/** An operator, a whitelisted user, and anyone else. */
const access = { roleOf: (id: string) => ({ op: 'operator', bob: 'user' } as const)[id as 'op' | 'bob'], adminFor: () => undefined, callerFor: () => () => ({ permissions: [] }) } as unknown as AccessStore;
const finished = (cards: Array<{ text: string }>) => vi.waitFor(() => expect(cards.at(-1)?.text).toMatch(/^-# (Result: |stopped · )/));

function conversation(overrides: Partial<ConversationOptions> & Pick<ConversationOptions, 'transport'>) {
  const controller = new AbortController();
  const chat = new Conversation({
    key: 'dm:test', queue: new TurnQueue(), maxPromptChars: 20_000, log: vi.fn(), cardDelayMs: 0,
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
  expect(cards.at(-1)!.text).toBe('-# Result: completed · 0 steps · 0s');
  expect(cards.at(-1)!.controls.press('details', 'anyone').text).toContain('accounted $0.000000\nrequest req-1');
  // Stop goes with the turn; Details stays.
  expect(cards[0]!.controls.stop).toBe(true);
  expect(cards.at(-1)!.controls.stop).toBe(false);
});

it('signals simulator completion for a casual reply only after its lines are delivered', async () => {
  const { sent, cards, transport } = discord();
  const turns = new TurnEvents(new World(), () => true);
  let release!: () => void;
  const delivered = new Promise<void>(done => { release = done; });
  transport.send = vi.fn(async text => { await delivered; sent.push(text); return 'reply'; });
  const onTurnEnd = vi.fn(completion => turns.complete(completion));
  const { chat } = conversation({ transport, cardDelayMs: 60_000, lineDelayMs: () => 0, onTurnEnd,
    run: async (_request, dependencies) => {
      dependencies.onEvent?.({ type: 'route', casual: true });
      return { ...result, casual: true, text: 'hey there' };
    },
  });
  const waited = turns.wait(5);
  chat.push('hi');
  await vi.waitFor(() => expect(transport.send).toHaveBeenCalled());
  expect(onTurnEnd).not.toHaveBeenCalled();
  release();
  expect(await waited).toEqual({ event: 'turn_end', status: 'completed', requestId: 'req-1' });
  expect(sent).toEqual(['hey there']);
  expect(cards).toHaveLength(0);
});

it('posts complete intermediate assistant messages silently before the final answer, without duplicating it', async () => {
  const { sent, cards, transport } = discord();
  const { chat } = conversation({ transport, run: async (_request, dependencies) => {
    dependencies.onEvent?.({ type: 'text', text: 'checking secret-' });
    dependencies.onEvent?.({ type: 'text', text: 'token now' });
    dependencies.onEvent?.({ type: 'message_end' });
    dependencies.onEvent?.({ type: 'tool_execution_start', tool: 'read' });
    await vi.waitFor(() => expect(sent).toEqual(['checking [REDACTED] now']));
    dependencies.onEvent?.({ type: 'text', text: 'junior-only text', junior: 'helper' });
    dependencies.onEvent?.({ type: 'message_end', junior: 'helper' });
    dependencies.onEvent?.({ type: 'text', text: result.text });
    dependencies.onEvent?.({ type: 'message_end' });
    return result;
  } });
  chat.push('check this');
  await finished(cards);
  expect(sent).toEqual(['checking [REDACTED] now', 'Done with [REDACTED].']);
  expect(transport.send).toHaveBeenNthCalledWith(1, 'checking [REDACTED] now', { silent: true });
  expect(transport.send).toHaveBeenNthCalledWith(2, 'Done with [REDACTED].');
});

it('chunks and orders silent commentary, and waits for it before completing the turn', async () => {
  const { cards, transport } = discord();
  let release!: () => void;
  const held = new Promise<void>(done => { release = done; });
  transport.send = vi.fn(async (_text, options) => { if (options?.silent) await held; return 'reply'; });
  const onTurnEnd = vi.fn();
  const { chat } = conversation({ transport, onTurnEnd, run: async (_request, dependencies) => {
    dependencies.onEvent?.({ type: 'text', text: 'a'.repeat(2500) });
    dependencies.onEvent?.({ type: 'message_end' });
    dependencies.onEvent?.({ type: 'text', text: 'second update' });
    dependencies.onEvent?.({ type: 'message_end' });
    dependencies.onEvent?.({ type: 'tool_execution_start', tool: 'read' });
    return result;
  } });
  chat.push('check this');
  await vi.waitFor(() => expect(transport.send).toHaveBeenCalledTimes(1));
  expect(onTurnEnd).not.toHaveBeenCalled();
  release();
  await finished(cards);
  const calls = vi.mocked(transport.send).mock.calls;
  expect(calls.slice(0, -2).map(([text]) => text).join('')).toBe('a'.repeat(2500));
  expect(calls.slice(0, -1).every(([text, options]) => text.length <= 2000 && options?.silent)).toBe(true);
  expect(calls.at(-2)).toEqual(['second update', { silent: true }]);
  expect(calls.at(-1)).toEqual(['Done with [REDACTED].']);
});

it.each(['casual', 'answer-only', 'aside', 'quiet'])('keeps %s turns free of public commentary', async kind => {
  const { sent, transport } = discord();
  const onTurnEnd = vi.fn();
  const { chat } = conversation({ transport, onTurnEnd, lineDelayMs: () => 0,
    request: { prompt: '', cwd: '.', mode: 'ask', side: kind === 'aside' },
    run: async (_request, dependencies) => {
      dependencies.onEvent?.({ type: 'route', casual: kind === 'casual' });
      dependencies.onEvent?.({ type: 'text', text: 'internal update' });
      dependencies.onEvent?.({ type: 'message_end' });
      dependencies.onEvent?.({ type: 'tool_execution_start', tool: 'read' });
      return { ...result, casual: kind === 'casual' };
    },
  });
  chat.push('hi', { answerOnly: kind === 'answer-only', quiet: kind === 'quiet' });
  await vi.waitFor(() => expect(onTurnEnd).toHaveBeenCalled());
  expect(sent.join('\n')).not.toContain('internal update');
});

it('skips empty commentary and still delivers the answer if a silent message fails', async () => {
  const { sent, cards, transport } = discord();
  const log = vi.fn();
  vi.mocked(transport.send).mockRejectedValueOnce(new Error('cannot post'));
  const { chat } = conversation({ transport, log, run: async (_request, dependencies) => {
    dependencies.onEvent?.({ type: 'text', text: ' \n' });
    dependencies.onEvent?.({ type: 'message_end' });
    dependencies.onEvent?.({ type: 'tool_execution_start', tool: 'read' });
    dependencies.onEvent?.({ type: 'text', text: 'checking now' });
    dependencies.onEvent?.({ type: 'message_end' });
    dependencies.onEvent?.({ type: 'tool_execution_start', tool: 'read' });
    return result;
  } });
  chat.push('check this');
  await finished(cards);
  expect(transport.send).toHaveBeenCalledTimes(2);
  expect(sent).toEqual(['Done with [REDACTED].']);
  expect(log).toHaveBeenCalledWith('dm:test: commentary failed: cannot post');
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
  expect(press('stop', 'bob').text).toBe('stopping…');
  await finished(cards);
  expect(sent).toEqual([]);
  expect(cards.at(-1)!.text).toMatch(/^-# stopped · /);
  expect(press('stop', 'op').text).toBe('This turn is already ending.');
});

it.each(['button', 'command'])('acknowledges a %s stop with edits without a failure report', async source => {
  const { sent, cards, transport, press } = discord();
  const run: ConversationOptions['run'] = request => new Promise(resolve => {
    request.signal!.addEventListener('abort', () => resolve({ ...result, success: false, status: 'cancelled', text: 'host fallback', interruption: {
      reason: 'cancelled', edits: [{ path: 'secret-token.md', size: 2048 }], shellRan: false,
    } }), { once: true });
  });
  const { chat } = conversation({ transport, run, access });
  chat.push('edit a file', { sender: 'bob' });
  await vi.waitFor(() => expect(cards).not.toHaveLength(0));
  if (source === 'button') press('stop', 'bob');
  else chat.push('/stop', { sender: 'bob' });
  await finished(cards);
  expect(sent).toEqual(['stopped — edits to `[REDACTED].md` are still there.\n\n-# those edits haven’t been checked.']);
  expect(cards.at(-1)!.text).toMatch(/^-# stopped · /);
  expect(press('details', 'bob').text).toContain('edited `[REDACTED].md` (2 KB)');
  expect(press('details', 'bob').text).not.toContain('secret-token');
});

it('keeps an answer-only stop visible when there is no status card', async () => {
  const { sent, cards, transport } = discord();
  const { chat } = conversation({ transport, run: async () => ({ ...result, success: false, status: 'cancelled', text: 'stopped', interruption: { reason: 'cancelled', edits: [], shellRan: false } }) });
  chat.push('/btw quick question');
  await vi.waitFor(() => expect(sent).toContain('stopped\n-# this is an aside - not part of the main convo.'));
  expect(cards).toHaveLength(0);
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

it.each(['approved', 'denied', 'auto-approved'] as const)('uses the continuation approval transport and returns %s', async outcome => {
  const { continuations, approvals, cards, transport } = discord();
  const answers: boolean[] = [];
  const run = vi.fn(async (_request, dependencies) => {
    answers.push(await dependencies.approve({ kind: 'continuation_budget', summary: 'Continue with the next batch', details: 'Budget: $1.00' }));
    return result;
  }) as ConversationOptions['run'];
  const log = vi.fn();
  const { chat } = conversation({ transport, run, log });
  chat.push('continue');
  await vi.waitFor(() => expect(continuations).toHaveLength(1));
  expect(approvals).toHaveLength(0);
  expect(continuations[0]!.timeoutMs).toBe(45_000);
  expect(continuations[0]!.text).toContain('no answer in 45 seconds');
  expect(continuations[0]!.text).toContain('Budget: $1.00');
  continuations[0]!.resolve(outcome);
  await vi.waitFor(() => expect(answers).toEqual([outcome !== 'denied']));
  expect(log).toHaveBeenCalledWith(expect.stringContaining(`continuation_budget ${outcome}:`));
  expect(cards.at(-1)?.text).toMatch(/^(🫖 thinking|-# Result)/);
});

it('fails closed when continuation approval transport is unavailable', async () => {
  const { transport } = discord();
  delete (transport as Partial<DiscordTransport>).askContinuationBudget;
  const answers: boolean[] = [];
  const run = vi.fn(async (_request, dependencies) => { answers.push(await dependencies.approve({ kind: 'continuation_budget', summary: 'Continue?' })); return result; }) as ConversationOptions['run'];
  const { chat } = conversation({ transport, run });
  chat.push('continue');
  await vi.waitFor(() => expect(answers).toEqual([false]));
});

it('approves everything without asking for an operator\'s yolo message, and only for that message', async () => {
  const { sent, approvals, cards, transport } = discord();
  const answers: boolean[] = [];
  const run = vi.fn<ConversationOptions['run']>(async (_request, dependencies) => { answers.push(await dependencies.approve({ kind: 'shell', summary: 'Run a command' })); return result; });
  const { chat } = conversation({ transport, run, access });
  chat.push('run it', { sender: 'op', yolo: true });
  await vi.waitFor(() => expect(answers).toEqual([true]));
  expect(approvals).toHaveLength(0);
  expect(sent).toContain('-# Auto-approved (shell): Run a command');
  await finished(cards);
  chat.push('again', { sender: 'op' });
  await vi.waitFor(() => expect(approvals).toHaveLength(1));
  approvals[0]!.resolve(false);
  await vi.waitFor(() => expect(answers).toEqual([true, false]));
});

it('still asks when someone who cannot approve sends a yolo message', async () => {
  const { approvals, transport } = discord();
  const run = vi.fn<ConversationOptions['run']>(async (_request, dependencies) => { await dependencies.approve({ kind: 'shell', summary: 'Run a command' }); return result; });
  const { chat } = conversation({ transport, run, access });
  chat.push('run it', { sender: 'bob', yolo: true });
  await vi.waitFor(() => expect(approvals).toHaveLength(1));
  approvals[0]!.resolve(false);
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
  const { sent, cards, transport } = discord();
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
  await finished(cards);
  expect(sent).toEqual([]);
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

it('offers a conversation with a workspace its repository only in Code mode inside one', async () => {
  const f = await fixture(); cleanups.push(f.cleanup);
  const repo = join(f.cwd, 'repo');
  await mkdir(join(repo, '.git'), { recursive: true });
  const files = WorkspaceStore.at(join(f.cwd, 'workspaces'));
  const seen: boolean[] = [];
  for (const [cwd, mode] of [[f.cwd, 'ask'], [f.cwd, 'code'], [repo, 'ask'], [repo, 'code']] as const) {
    const authorization = await SessionGrants.create(cwd, f.config, mode);
    authorization.setCaller(() => ({ permissions: ['inference', 'repository.read', 'repository.write', 'repository.shell'] }));
    const { transport } = discord();
    const run = vi.fn(async () => { seen.push(authorization.available().includes('repository.read')); return result; }) as ConversationOptions['run'];
    const { chat } = conversation({ transport, run, files, request: { prompt: '', cwd, mode, authorization } });
    chat.push('fix the game');
    await vi.waitFor(() => expect(run).toHaveBeenCalledTimes(1));
    await new Promise(resolve => setTimeout(resolve, 0));
  }
  expect(seen).toEqual([false, false, false, true]);
});

it('lets anyone allowed revoke from /convo grants, and asks an operator before granting to anyone else', async () => {
  const f = await fixture(); cleanups.push(f.cleanup);
  const authorization = await SessionGrants.create(f.cwd, f.config, 'ask');
  const { approvals, transport } = discord();
  const roles = { ...access, callerFor: (id: string) => () => ({ permissions: id === 'op' ? f.config.policy.permissions : ['inference', 'web.search'] }) } as unknown as AccessStore;
  const { chat } = conversation({ transport, access: roles, request: { prompt: '', cwd: f.cwd, mode: 'ask', authorization } });
  const panel = chat.grantPanel()!;
  const held = () => panel.state().filter(entry => entry.granted).map(entry => entry.permission);
  expect(panel.state().map(entry => entry.permission)).toEqual(['inference', 'repository.read', 'repository.write', 'repository.shell', 'web.search', 'discord.play']);
  expect(held()).toEqual(['inference']);
  // An operator's press is its own approval.
  expect(await panel.press('repository.write', 'op')).toBeUndefined();
  expect(held()).toEqual(['inference', 'repository.read', 'repository.write']);
  expect(approvals).toHaveLength(0);
  // Anyone else asks an operator, and only for what they may hold.
  const asked = panel.press('web.search', 'bob');
  await vi.waitFor(() => expect(approvals).toHaveLength(1));
  expect(approvals[0]!.text).toContain('Allow web.search for this session?');
  approvals[0]!.resolve(true);
  expect(await asked).toBeUndefined();
  expect(await panel.press('discord.play', 'bob')).toBe("discord.play wasn't granted - denied or unavailable.");
  expect(approvals).toHaveLength(1);
  // Revoking needs no approval, and read takes write with it.
  expect(await panel.press('repository.read', 'bob')).toBeUndefined();
  expect(held()).toEqual(['inference', 'web.search']);
  expect(await panel.press('web.search', 'mallory')).toBe("you can't use teapilot here.");
  expect(held()).toEqual(['inference', 'web.search']);
});

it('grants from an idle /convo grants only what needs no approval, or on an operator\'s press', async () => {
  const f = await fixture(); cleanups.push(f.cleanup);
  const grants = await SessionGrants.create(f.cwd, f.config, 'ask');
  const roles = { ...access, callerFor: (id: string) => () => ({ permissions: id === 'op' ? f.config.policy.permissions : ['inference', 'web.search', 'discord.play'], preapproved: ['discord.play'] }) } as unknown as AccessStore;
  const panel = grantControls({ grants, access: roles, key: 'dm:bob', log: () => undefined });
  expect(await panel.press('discord.play', 'bob')).toBeUndefined();
  expect(await panel.press('web.search', 'bob')).toBe("web.search needs an operator's ok. ask one to press it, or send a message and ask for it there.");
  expect(await panel.press('web.search', 'op')).toBeUndefined();
  expect(grants.list()).toEqual(['inference', 'web.search', 'discord.play']);
});

it('saves session grants as they change, and restores them only within the ceiling and the same root', async () => {
  const f = await fixture(); cleanups.push(f.cleanup);
  const grants = await SessionGrants.create(f.cwd, f.config, 'ask');
  const saves: SavedGrants[] = [];
  grants.persist(saved => saves.push(saved));
  await grants.request(['repository.read'], 'test', async approval => { expect(approval.details).toContain('Access lasts until revoked. '); return true; });
  grants.revoke('inference');
  expect(saves.map(saved => saved.granted)).toEqual([['inference', 'repository.read'], ['repository.read']]);
  expect((await SessionGrants.create(f.cwd, f.config, 'code', false, saves.at(-1))).list()).toEqual(['repository.read']);
  const elsewhere = join(f.cwd, 'elsewhere');
  await mkdir(elsewhere);
  expect((await SessionGrants.create(f.cwd, f.config, 'ask', false, { root: elsewhere, granted: ['inference', 'repository.read'] })).list()).toEqual(['inference']);
  f.config.policy.permissions = ['inference'];
  expect((await SessionGrants.create(f.cwd, f.config, 'ask', false, { root: f.cwd, granted: ['inference', 'web.search'] })).list()).toEqual(['inference']);
});

it('lays an answer out with workspace pictures and files, and sends a part Discord refuses as text', async () => {
  const f = await fixture(); cleanups.push(f.cleanup);
  const files = WorkspaceStore.at(join(f.cwd, 'workspaces'));
  await files.save('dm:test', 'chart.png', Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=', 'base64'), 'teapilot');
  await files.save('dm:test', 'script.py', Buffer.from('print(1)'), 'teapilot');
  const { sent, cards, transport } = discord();
  const answered: AnswerMessage[] = [];
  transport.answer = vi.fn(async (message: AnswerMessage) => { if (message.embeds) throw new Error('refused'); answered.push(message); return 'a'; });
  const table = '| a | b |\n|---|---|\n| 1 | secret-token |';
  const run = vi.fn<ConversationOptions['run']>(async () => ({ ...result, text: `here it is\n\n---\n\n![chart](chart.png)\n![script.py]\n\n${table}\n\nbye` }));
  const { chat } = conversation({ transport, files, run });
  chat.push('chart please');
  await finished(cards);
  expect(run.mock.calls[0]![0].workspace?.inline).toBe(true);
  expect(answered.map(message => message.components!.map(component => component.type))).toEqual([[10, 14, 12, 13], [10]]);
  expect(answered[0]!.files!.map(file => file.name)).toEqual(['chart.png', 'script.py']);
  expect(sent).toEqual([table.replace('secret-token', '[REDACTED]')]);
});
