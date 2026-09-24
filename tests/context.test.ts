import { afterEach, expect, it } from 'vitest';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { completion, events, fixture, mockServer } from './helpers.js';
import { runAttempt } from '../src/agents/run.js';
import { SpendGovernor } from '../src/inference/budget.js';
import { Telemetry } from '../src/telemetry/outcome.js';
import { estimateInputTokens, estimateTextTokens, MAX_PAYLOAD_BYTES } from '../src/inference/context.js';
import { formatCompactionSummary } from '../src/inference/compaction.js';

const cleanups: (() => Promise<unknown>)[] = [];
afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup(); });
async function setup(handler: Parameters<typeof mockServer>[0]) {
  const f = await fixture(); cleanups.push(f.cleanup);
  const server = await mockServer(handler); cleanups.push(server.close);
  Object.assign(f.config.models.capable, { provider: 'ollama', baseUrl: server.url, contextTokens: 32768, maxOutputTokens: 16384 });
  const telemetry = new Telemetry(f.config.stateDir, 'context-test');
  await telemetry.event('start', {});
  const budget = new SpendGovernor(join(f.config.stateDir, 'spend.jsonl'), 'context-test', f.config.policy.budget);
  return { ...f, budget, telemetry };
}

it.each([false, true])('completes several coding tool round trips at 16k (web=%s)', async web => {
  const bodies: any[] = [];
  const f = await setup((body, _req, res) => {
    bodies.push(body);
    const steps = [
      { name: 'repo_list', arguments: { path: '.' } },
      { name: 'read', arguments: { path: 'notes.txt' } },
      { name: 'write', arguments: { path: 'web-pong/index.html', content: '<html>Pong</html>\n' } },
      { name: 'read', arguments: { path: 'web-pong/index.html' } },
    ];
    completion(res, bodies.length <= steps.length ? { tool: steps[bodies.length - 1]! } : { text: 'Created and verified.' });
  });
  f.config.searchUrl = 'http://unused.test';
  if (!f.config.policy.permissions.includes('web.search')) f.config.policy.permissions.push('web.search');
  await mkdir(join(f.cwd, 'web-pong'));
  await writeFile(join(f.cwd, 'notes.txt'), 'Keep the game self contained.\n'.repeat(120));
  const result = await runAttempt({ ...f, tier: 'normal', workload: 'coder', prompt: 'Read notes.txt and create web-pong/index.html, then read it to verify.', web, approve: async () => true });
  expect(result, JSON.stringify(result)).toMatchObject({ success: true, turns: 5, toolCalls: 4 });
  expect(await readFile(join(f.cwd, 'web-pong/index.html'), 'utf8')).toContain('Pong');
  expect(bodies.some(body => Buffer.byteLength(JSON.stringify(body)) > 8 * 1024)).toBe(true);
  expect(bodies[0].tools.some((tool: any) => tool.function.name === 'web_search')).toBe(web);
  const admissions = (await events(f.config)).filter(e => e.type === 'context_admission');
  expect(admissions).toHaveLength(5);
  expect(admissions.every(e => e.estimatedInputTokens + e.reservedOutputTokens <= 16384 && !e.rejection)).toBe(true);
  expect(f.budget.spent().request).toBe(0);
});

it.each([400, 404, 422])('keeps provider HTTP %s separate from local overflow', async status => {
  let calls = 0;
  const f = await setup((_body, _req, res) => { calls++; res.writeHead(status); res.end('{}'); });
  const input = { ...f, tier: 'normal' as const, workload: 'ask' as const, web: false, approve: async () => true };
  expect(await runAttempt({ ...input, prompt: 'hello' })).toMatchObject({ stopped: 'unsupported' });
  expect(await runAttempt({ ...input, prompt: 'x!'.repeat(20000) })).toMatchObject({ stopped: 'context_limit' });
  expect(calls).toBe(1);
  expect((await events(f.config)).some(e => e.type === 'provider_http_error' && e.status === status)).toBe(true);
});

it('keeps local inference free when providers omit usage', async () => {
  let calls = 0;
  const f = await setup((_body, _req, res) => { calls++; completion(res, { noUsage: true }); });
  const input = { ...f, tier: 'normal' as const, workload: 'ask' as const, web: false, prompt: 'hello', approve: async () => true };
  expect((await runAttempt(input)).success).toBe(true);
  expect(f.budget.spent().request).toBe(0);
  expect((await runAttempt(input)).success).toBe(true);
  expect(calls).toBe(2);
});

it('rejects an unreasonable transport payload before inference or reservation', async () => {
  let calls = 0;
  const f = await setup((_body, _req, res) => { calls++; completion(res, {}); });
  const result = await runAttempt({ ...f, tier: 'normal', workload: 'ask', web: false,
    prompt: 'x'.repeat(MAX_PAYLOAD_BYTES), approve: async () => true });
  expect(result.stopped).toBe('payload_limit');
  expect(calls).toBe(0);
  await expect(readFile(f.budget.path)).rejects.toThrow();
});

it('counts Unicode, punctuation, schemas and framing rather than JSON escape bytes', () => {
  expect(estimateTextTokens('你好🙂')).toBe(Buffer.byteLength('你好🙂'));
  expect(estimateTextTokens('{}!?')).toBe(4);
  const messages = [{ role: 'user', content: 'hello\nworld' }];
  expect(estimateInputTokens(JSON.stringify({ messages, tools: [{ description: 'search' }] }))).toBeGreaterThan(estimateInputTokens(JSON.stringify({ messages })));
  expect(estimateInputTokens(JSON.stringify({ messages, model: 'x'.repeat(20000) }))).toBe(estimateInputTokens(JSON.stringify({ messages })));
});


it('replays compacted session context as an explicitly untrusted history message', async () => {
  const bodies: any[] = [];
  const f = await setup((body, _req, res) => { bodies.push(body); completion(res, { text: 'continued' }); });
  const result = await runAttempt({ ...f, tier: 'normal', workload: 'ask', prompt: 'continue', summary: 'Keep src/parser.ts and the exact E_PARSE error.', web: false, approve: async () => true });
  expect(result.success).toBe(true);
  expect(JSON.stringify(bodies[0].messages)).toContain(formatCompactionSummary('Keep src/parser.ts and the exact E_PARSE error.'));
  expect(JSON.stringify(bodies[0].messages)).toContain('explicitly untrusted summary');
});
