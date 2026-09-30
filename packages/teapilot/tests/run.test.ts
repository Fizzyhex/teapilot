import { afterEach, expect, it } from 'vitest';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { completion, events, fixture, mockServer } from './helpers.js';
import { runAttempt } from '../src/agents/run.js';
import { SpendGovernor } from '../src/inference/budget.js';
import { Telemetry } from '../src/telemetry/outcome.js';

const cleanups: Array<() => Promise<unknown>> = [];
afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup(); });
async function setup(handler: Parameters<typeof mockServer>[0]) {
  const f = await fixture(); cleanups.push(f.cleanup);
  const server = await mockServer(handler); cleanups.push(server.close);
  Object.assign(f.config.models.capable, { provider: 'ollama', baseUrl: server.url });
  const telemetry = new Telemetry(f.config.stateDir, 'run-test');
  await telemetry.event('start', {});
  const budget = new SpendGovernor(join(f.config.stateDir, 'spend.jsonl'), 'run-test', f.config.policy.budget);
  return { ...f, budget, telemetry };
}

it('records the written file size and the largest observed tool payload', async () => {
  let calls = 0;
  const content = `<html>${'x'.repeat(200)}</html>`;
  const f = await setup((_body, _req, res) => {
    calls++;
    completion(res, calls === 1 ? { tool: { name: 'write', arguments: { path: 'index.html', content } } } : { text: 'Created index.html.' });
  });
  const result = await runAttempt({ ...f, tier: 'normal', workload: 'coder', web: false, approve: async () => true, prompt: 'Create index.html' });
  expect(result.success, JSON.stringify(result)).toBe(true);
  expect(result.changedFiles).toEqual(['index.html']);
  expect(result.fileSizes).toEqual({ 'index.html': Buffer.byteLength(content) });
  expect(result.largestToolResult?.tool).toBe('write');
  expect(await readFile(join(f.cwd, 'index.html'), 'utf8')).toBe(content);
});

it('streams redacted reasoning to callers that ask, and says what a tool is about to run', async () => {
  let calls = 0;
  const f = await setup((_body, _req, res) => {
    calls++;
    completion(res, calls === 1 ? { reasoning: 'check with hunter2', tool: { name: 'read', arguments: { path: 'missing.txt' } } } : { text: 'Nothing there.' });
  });
  f.config.secrets = { ...f.config.secrets, fast: 'hunter2' };
  const reasoning: string[] = [];
  const starts: unknown[] = [];
  await runAttempt({ ...f, tier: 'normal', workload: 'coder', web: false, approve: async () => true, prompt: 'read it',
    onReasoning: text => reasoning.push(text), onEvent: event => { if (event.type === 'tool_execution_start') starts.push(event); } });
  expect(reasoning.join('')).toBe('check with [REDACTED]');
  expect(starts).toEqual([{ type: 'tool_execution_start', tool: 'read', path: 'missing.txt' }]);
});

it('does not size a failed write and records no observed edit', async () => {
  const f = await setup((_body, _req, res) => completion(res, { text: 'No tools used.' }));
  const result = await runAttempt({ ...f, tier: 'normal', workload: 'ask', web: false, approve: async () => true, prompt: 'hello' });
  expect(result.success).toBe(true);
  expect(result.changedFiles).toEqual([]);
  expect(result.fileSizes).toEqual({});
});

/** A reply that ends to call a tool but carries no call, as a model server sends when it cannot parse one. */
function lostCall(res: import('node:http').ServerResponse) {
  res.setHeader('Content-Type', 'text/event-stream');
  const common = { id: 'mock-chat', object: 'chat.completion.chunk', created: 1, model: 'mock-model' };
  res.write(`data: ${JSON.stringify({ ...common, choices: [{ index: 0, delta: { role: 'assistant', content: '' }, finish_reason: null }] })}\n\n`);
  res.write(`data: ${JSON.stringify({ ...common, choices: [{ index: 0, delta: {}, finish_reason: 'tool_calls' }] })}\n\n`);
  res.end('data: [DONE]\n\n');
}

it('asks again after a tool call the server announced but did not send, then gives up as a provider error', async () => {
  const bodies: any[] = [];
  const f = await setup((body, _req, res) => { bodies.push(body); if (bodies.length === 1) lostCall(res); else completion(res, { text: 'Hello.' }); });
  const result = await runAttempt({ ...f, tier: 'normal', workload: 'ask', web: false, approve: async () => true, prompt: 'hello' });
  expect(result.success).toBe(true);
  expect(JSON.stringify(bodies[1].messages)).toContain('could not read your last tool call');

  const stuck = await setup((_body, _req, res) => lostCall(res));
  const failed = await runAttempt({ ...stuck, tier: 'normal', workload: 'ask', web: false, approve: async () => true, prompt: 'hello' });
  expect(failed.success).toBe(false);
  expect(failed.reason).toBe('provider_error');
  expect(failed.turns).toBe(3);
  expect(failed.ending).toMatchObject({ stopReason: 'toolUse', textChars: 0 });
});

it('adds a tip to the result that calls for it, once per context, and reports it', async () => {
  const bodies: any[] = [];
  const f = await setup((body, _req, res) => {
    bodies.push(body);
    const files = ['a.py', 'b.py', 'c.py'];
    completion(res, bodies.length <= files.length ? { tool: { name: 'write', arguments: { path: files[bodies.length - 1], content: 'print(1)\n' } } } : { text: 'Done.' });
  });
  const result = await runAttempt({ ...f, tier: 'normal', workload: 'coder', web: false, approve: async () => true, prompt: 'Write three scripts' });
  expect(result.success, JSON.stringify(result)).toBe(true);
  const sent = JSON.stringify(bodies.at(-1).messages);
  const count = (text: string) => sent.split(text).length - 1;
  expect(count('[tip] the user prefers creative, minimalist decision making')).toBe(1);
  expect(count('[tip] keep your workspace organised')).toBe(1);
  expect((await events(f.config)).filter(event => event.type === 'tip').map(event => event.name)).toEqual(['pythonPref', 'stayOrganised']);
});
