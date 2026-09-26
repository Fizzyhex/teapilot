import { afterEach, expect, it, vi } from 'vitest';
import { mkdir, realpath } from 'node:fs/promises';
import { join } from 'node:path';
import { runChat } from '../src/chat.js';
import { SessionGrants } from '../src/execution/grants.js';
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
  expect(run.mock.calls[0]![0]).toMatchObject({ workload: 'ask', mode: 'chat', conversational: true, web: true, history: [] });
  expect(run.mock.calls[1]![0]).toMatchObject({ prompt: 'Cost', correction: undefined, history: [{ user: 'Help plan\nUser correction:\nKeep it simple', assistant: result.text }] });
});

it('ignores empty prompts, continues after incomplete turns, and bounds retained history', async () => {
  const input = vi.fn().mockResolvedValueOnce('').mockResolvedValueOnce('First').mockResolvedValueOnce('Next').mockResolvedValueOnce('/quit');
  const run = vi.fn().mockResolvedValueOnce({ ...result, text: 'x'.repeat(500) }).mockResolvedValueOnce({ ...result, success: false });
  expect(await runChat({ request: { prompt: '', cwd: '.' }, maxPromptChars: 200, input, run })).toBe(2);
  expect(run).toHaveBeenCalledTimes(2);
  expect(run.mock.calls[1]![0].history).toEqual([]);
});

it('keeps host diagnostics from failed turns out of the conversation history', async () => {
  const input = vi.fn().mockResolvedValueOnce('try again').mockResolvedValueOnce('/exit');
  const run = vi.fn().mockResolvedValueOnce({ ...result, success: false, status: 'context_limit', text: 'Incomplete: context limit.\nNext: Type /new' })
    .mockResolvedValueOnce(result);
  await runChat({ request: { prompt: 'Build it', cwd: '.' }, maxPromptChars: 2000, input, run });
  expect(run.mock.calls[1]![0].history).toEqual([{ user: 'Build it', assistant: '[that request stopped before finishing: context limit]' }]);
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

it('/cd moves the session root, keeps history and drops write and shell', async () => {
  const f = await fixture(); cleanups.push(f.cleanup);
  await mkdir(join(f.cwd, '.git')); await mkdir(join(f.cwd, 'pong'));
  const grants = await SessionGrants.create(f.cwd, f.config, 'code');
  const root = grants.root, sub = await realpath(join(f.cwd, 'pong'));
  const log = vi.fn(), onEvent = vi.fn();
  const input = vi.fn().mockResolvedValueOnce('/cd pong').mockResolvedValueOnce('Next').mockResolvedValueOnce('/exit');
  const run = vi.fn(async (_request: HostRequest) => ({ ...result, spentUsd: 0.1 }));
  await runChat({ request: { prompt: 'First', cwd: f.cwd, mode: 'code', authorization: grants, tier: 'deep' }, maxPromptChars: 2000, input, run, log, onEvent });
  expect(run.mock.calls[0]![0].cwd).toBe(f.cwd);
  expect(run.mock.calls[1]![0]).toMatchObject({ cwd: sub, tier: 'deep', history: [{ user: 'First', assistant: result.text }] });
  expect(input.mock.calls[1]![0]).toMatchObject({ cwd: sub, spentUsd: 0.1, grants: ['inference', 'repository.read'] });
  expect(log).toHaveBeenCalledWith(`Root: ${sub}\nSession access: inference, repository.read (write and shell are requested for this root when first needed)`);
  expect(onEvent).toHaveBeenCalledWith(expect.objectContaining({ type: 'root_changed', from: root, cwd: sub }));
});

it('/cd to a missing path reports an error and changes nothing', async () => {
  const f = await fixture(); cleanups.push(f.cleanup);
  await mkdir(join(f.cwd, '.git'));
  const grants = await SessionGrants.create(f.cwd, f.config, 'code');
  const before = grants.list(), log = vi.fn(), onEvent = vi.fn();
  const input = vi.fn().mockResolvedValueOnce('/cd "no such dir"').mockResolvedValueOnce('/exit');
  await runChat({ request: { prompt: '', cwd: f.cwd, mode: 'code', authorization: grants }, maxPromptChars: 2000, input, run: vi.fn(), log, onEvent });
  expect(before).toEqual(['inference', 'repository.read', 'repository.write', 'repository.shell']);
  expect(log).toHaveBeenCalledWith(`Cannot change directory: no such dir does not exist. Root unchanged: ${grants.root}`);
  expect(grants.root).toBe(await realpath(f.cwd));
  expect(grants.list()).toEqual(before);
  expect(input.mock.calls[1]![0].cwd).toBe(grants.root);
  expect(onEvent).not.toHaveBeenCalled();
});

it('runs extension hooks around commands and turns', async () => {
  const calls: string[] = [];
  const extension = {
    help: '/teachat [who]',
    busy: vi.fn(async () => { calls.push('busy'); }),
    request: vi.fn(() => ({ teachatIdentities: { pip: 'Quick questions.' } })),
    turnEnd: vi.fn(async (_turn: unknown, _result: HostResult) => { calls.push('turnEnd'); }),
    reset: vi.fn(async () => { calls.push('reset'); }),
    command: vi.fn(async (command: string, _args: string) => { calls.push(command); return command === '/teachat'; }),
  };
  const input = vi.fn().mockResolvedValueOnce('/teachat read #ysk').mockResolvedValueOnce('/bogus').mockResolvedValueOnce('/new').mockResolvedValueOnce('Next').mockResolvedValueOnce('/exit');
  const answer = { choice: 'pip', probabilities: { pip: 1 }, confidence: 1 };
  const run = vi.fn(async (_request: HostRequest) => { calls.push('run'); return { ...result, teachatIdentity: answer }; });
  const log = vi.fn();
  await runChat({ request: { prompt: 'First', cwd: '.' }, maxPromptChars: 2000, input, run, log, extension });
  expect(calls).toEqual(['busy', 'run', 'turnEnd', 'busy', '/teachat', 'busy', '/bogus', 'busy', 'reset', 'busy', 'run', 'turnEnd']);
  expect(extension.command.mock.calls).toEqual([['/teachat', 'read #ysk'], ['/bogus', '']]);
  expect(run.mock.calls.map(call => call[0].teachatIdentities)).toEqual([{ pip: 'Quick questions.' }, { pip: 'Quick questions.' }]);
  expect(extension.turnEnd.mock.calls[0]).toEqual([{ user: 'First', assistant: result.text }, expect.objectContaining({ teachatIdentity: answer })]);
  expect(extension.turnEnd.mock.calls[1]![0]).toEqual({ user: 'Next', assistant: result.text });
  expect(log.mock.calls.map(call => call[0])).toEqual([expect.stringMatching(/^Commands: .*\/new.*, \/teachat \[who\]$/), expect.stringContaining('Started a new task')]);
});
