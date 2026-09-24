import { afterEach, expect, it, vi } from 'vitest';
import { runChat } from '../src/chat.js';
import { runHost, type HostRequest, type HostResult } from '../src/host.js';
import { completion, fixture, mockServer } from './helpers.js';

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup(); });

const result: HostResult = { requestId: 'test', success: true, status: 'completed', text: 'What matters most to you?', spentUsd: 0, receipts: [], attempts: 1 };

it('reports session costs and last attempted models including unsuccessful and model-free turns', async () => {
  const input = vi.fn().mockResolvedValueOnce('next').mockResolvedValueOnce('again').mockResolvedValueOnce('/exit');
  const run = vi.fn().mockResolvedValueOnce({ ...result, spentUsd: 0.1, models: ['local', 'economy'] })
    .mockResolvedValueOnce({ ...result, success: false, spentUsd: 0.2, models: ['strong'] })
    .mockResolvedValueOnce({ ...result, spentUsd: 0.05, models: [] });
  expect(await runChat({ request: { prompt: 'opening', cwd: '.' }, maxPromptChars: 2000, input, run })).toBe(2);
  expect(input.mock.calls[0]![0]).toEqual({ spentUsd: 0.1, lastModel: 'economy', tier: 'auto' });
  expect(input.mock.calls[1]![0].spentUsd).toBeCloseTo(0.3);
  expect(input.mock.calls[1]![0].lastModel).toBe('strong');
  expect(input.mock.calls[2]![0].spentUsd).toBeCloseTo(0.35);
  expect(input.mock.calls[2]![0].lastModel).toBe('strong');
});

it('starts the composer with zero cost and no model', async () => {
  const input = vi.fn().mockResolvedValue('/exit');
  await runChat({ request: { prompt: '', cwd: '.' }, maxPromptChars: 2000, input, run: vi.fn() });
  expect(input).toHaveBeenCalledWith({ spentUsd: 0, lastModel: undefined, tier: 'auto' });
});

it('continues after an opening prompt and carries the conversation and correction forward', async () => {
  const input = vi.fn().mockResolvedValueOnce('Cost').mockResolvedValueOnce('/exit');
  const run = vi.fn(async (_request: HostRequest) => result);
  expect(await runChat({ request: { prompt: 'Help plan', correction: 'Keep it simple', cwd: '.', web: true }, maxPromptChars: 2000, input, run })).toBe(0);
  expect(run).toHaveBeenCalledTimes(2);
  expect(run.mock.calls[0]![0]).toMatchObject({ workload: 'ask', chat: true, web: true, history: [] });
  expect(run.mock.calls[1]![0]).toMatchObject({ prompt: 'Cost', correction: undefined, history: [{ user: 'Help plan\nUser correction:\nKeep it simple', assistant: result.text }] });
});

it('ignores empty prompts, continues after incomplete turns, and bounds retained history', async () => {
  const input = vi.fn().mockResolvedValueOnce('').mockResolvedValueOnce('First').mockResolvedValueOnce('Next').mockResolvedValueOnce('/quit');
  const run = vi.fn(async (_request: HostRequest) => ({ ...result, success: false, text: 'x'.repeat(500) }));
  expect(await runChat({ request: { prompt: '', cwd: '.' }, maxPromptChars: 200, input, run })).toBe(2);
  expect(run).toHaveBeenCalledTimes(2);
  expect(run.mock.calls[1]![0].history).toEqual([]);
});

it('ends an empty session on terminal EOF without running a request', async () => {
  const error = new Error('closed'); error.name = 'TerminalClosedError';
  const run = vi.fn();
  expect(await runChat({ request: { prompt: '', cwd: '.' }, maxPromptChars: 200, input: async () => { throw error; }, run })).toBe(0);
  expect(run).not.toHaveBeenCalled();
});

it('sends conversational instructions and prior turns to the ask model without repository tools', async () => {
  const f = await fixture(); cleanups.push(f.cleanup);
  const payloads: any[] = [];
  const server = await mockServer((body, _request, response) => { payloads.push(body); completion(response, { text: 'What matters most?' }); });
  cleanups.push(server.close);
  f.config.routingMode = 'direct';
  f.config.models.capable.baseUrl = `${server.url}/v1`;
  const input = vi.fn().mockResolvedValueOnce('Cost').mockResolvedValueOnce('/exit');
  const code = await runChat({
    request: { prompt: 'Help plan', cwd: f.cwd }, maxPromptChars: f.config.policy.limits.maxPromptChars, input,
    run: request => runHost(f.config, request, { approve: async () => false, localProbe: async () => true }),
  });
  expect(code).toBe(0);
  expect(payloads).toHaveLength(2);
  expect(JSON.stringify(payloads[0].messages)).toContain('ongoing back-and-forth conversation');
  expect(payloads[1].messages).toEqual(expect.arrayContaining([
    expect.objectContaining({ role: 'user', content: 'Help plan' }),
    expect.objectContaining({ role: 'assistant', content: 'What matters most?' }),
    expect.objectContaining({ role: 'user', content: [{ type: 'text', text: 'Cost' }] }),
  ]));
  expect(payloads[0].tools.map((tool: any) => tool.function.name)).toEqual(['request_escalation']);
});


it('compacts on demand with focus and /new clears the checkpoint', async () => {
  const input = vi.fn()
    .mockResolvedValueOnce('/compact focus on parser failures')
    .mockResolvedValueOnce('Next')
    .mockResolvedValueOnce('/new')
    .mockResolvedValueOnce('After reset')
    .mockResolvedValueOnce('/exit');
  const run = vi.fn(async (_request: HostRequest) => result);
  const compact = vi.fn(async (request: import('../src/inference/compaction.js').SessionCompactionInput) => {
    if (request.force) return {
      performed: true, summary: 'parser checkpoint', history: [], compactedTurns: request.history.length,
      tokensBefore: 100, estimatedTokensAfter: 20, spentUsd: 0, tier: 'normal' as const, model: 'local',
    };
    return { performed: false, summary: request.summary, history: request.history, compactedTurns: 0, tokensBefore: 20, spentUsd: 0, tier: 'normal' as const, model: 'local' };
  });
  expect(await runChat({ request: { prompt: 'Opening', cwd: '.' }, maxPromptChars: 2000, input, run, compact })).toBe(0);
  expect(compact.mock.calls.some(call => call[0].force && call[0].focus === 'focus on parser failures')).toBe(true);
  expect(run.mock.calls[1]![0]).toMatchObject({ prompt: 'Next', summary: 'parser checkpoint', history: [] });
  expect(run.mock.calls[2]![0]).toMatchObject({ prompt: 'After reset', summary: undefined, history: [] });
});
