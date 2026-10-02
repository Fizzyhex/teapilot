import { afterEach, expect, it } from 'vitest';
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { completion, events, fixture, mockServer } from './helpers.js';
import { lostCallNotice, runAttempt } from '../src/agents/run.js';
import { RequestRecovery } from '../src/agents/recovery.js';
import { runHost } from '../src/host.js';
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
function lostCall(res: import('node:http').ServerResponse, eosReason?: string, tool?: { name: string; arguments: unknown }, rawArguments?: string) {
  res.setHeader('Content-Type', 'text/event-stream');
  const common = { id: 'mock-chat', object: 'chat.completion.chunk', created: 1, model: 'mock-model' };
  res.write(`data: ${JSON.stringify({ ...common, choices: [{ index: 0, delta: { role: 'assistant', content: '', ...(tool ? { tool_calls: [{ index: 0, id: 'partial', type: 'function', function: { name: tool.name, arguments: rawArguments ?? JSON.stringify(tool.arguments) } }] } : {}) }, finish_reason: null }] })}\n\n`);
  res.write(`data: ${JSON.stringify({ ...common, choices: [{ index: 0, delta: {}, finish_reason: 'tool_calls', ...(eosReason ? { eos_reason: eosReason } : {}) }] })}\n\n`);
  res.end('data: [DONE]\n\n');
}

it('asks again after a tool call the server announced but did not send, then gives up as a provider error', async () => {
  const bodies: any[] = [];
  const f = await setup((body, _req, res) => { bodies.push(body); if (bodies.length === 1) lostCall(res); else completion(res, { text: 'Hello.' }); });
  const result = await runAttempt({ ...f, tier: 'normal', workload: 'ask', web: false, approve: async () => true, prompt: 'hello' });
  expect(result.success).toBe(true);
  expect(JSON.stringify(bodies[1].messages)).toContain('announced a tool call but sent no usable call');

  const stuck = await setup((_body, _req, res) => lostCall(res));
  const failed = await runAttempt({ ...stuck, tier: 'normal', workload: 'ask', web: false, approve: async () => true, prompt: 'hello' });
  expect(failed.success).toBe(false);
  expect(failed.reason).toBe('provider_error');
  expect(failed.turns).toBe(3);
  expect(failed.ending).toMatchObject({ stopReason: 'toolUse', textChars: 0 });
});

it('diagnoses provider token loops and never executes even parsed loop-truncated mutations', async () => {
  const bodies: any[] = [];
  const f = await setup((body, _req, res) => {
    bodies.push(body);
    if (bodies.length === 1) lostCall(res, 'loop_detected', { name: 'write', arguments: { path: 'unsafe.txt', content: 'partial' } });
    else completion(res, { text: 'The generation loop stopped; nothing changed.' });
  });
  const result = await runAttempt({ ...f, tier: 'normal', workload: 'coder', web: false, approve: async () => true, prompt: 'write a file' });
  expect(result.success).toBe(true);
  expect(result.toolCalls).toBe(0);
  expect(JSON.stringify(bodies[1].messages)).toContain('detected a token loop');
  await expect(readFile(join(f.cwd, 'unsafe.txt'))).rejects.toMatchObject({ code: 'ENOENT' });
  expect((await events(f.config)).find(event => event.type === 'provider_termination')).toMatchObject({ eosReason: 'loop_detected', toolData: true, parsedCalls: 1 });
});

it('keeps missing-call recovery limits across attempts on the same model', async () => {
  const f = await setup((_body, _req, res) => lostCall(res, 'loop_detected'));
  const recovery = new RequestRecovery();
  const input = { ...f, tier: 'normal' as const, workload: 'ask' as const, web: false, approve: async () => true, prompt: 'hello', recovery };
  expect((await runAttempt(input)).turns).toBe(3);
  expect((await runAttempt(input)).turns).toBe(1);
});

it.each(['max_new_tokens', 'malformed'])('never executes %s tool arguments even if pi can salvage a partial call', async cause => {
  let calls = 0;
  const f = await setup((_body, _req, res) => {
    if (++calls === 1) lostCall(res, cause === 'malformed' ? undefined : cause,
      { name: 'write', arguments: { path: 'unsafe.txt', content: 'partial' } },
      cause === 'malformed' ? '{"path":"unsafe.txt","content":"partial' : undefined);
    else completion(res, { text: 'Nothing was written.' });
  });
  const result = await runAttempt({ ...f, tier: 'normal', workload: 'coder', web: false, approve: async () => true, prompt: 'write a file' });
  expect(result.success).toBe(true);
  expect(result.toolCalls).toBe(0);
  await expect(readFile(join(f.cwd, 'unsafe.txt'))).rejects.toMatchObject({ code: 'ENOENT' });
  expect((await events(f.config)).find(event => event.type === 'provider_termination')).toMatchObject(cause === 'malformed' ? { malformedTools: true } : { eosReason: cause });
});

it('reports a confirmed provider loop without blaming size or retrying it under another tier name', async () => {
  const f = await setup((_body, _req, res) => lostCall(res, 'loop_detected'));
  f.config.routingMode = 'direct';
  const result = await runHost(f.config, { cwd: f.cwd, workload: 'ask', tier: 'normal', prompt: 'hello' }, { approve: async () => true, localProbe: async () => true });
  expect(result).toMatchObject({ success: false, attempts: 1, status: 'escalation_unavailable' });
  expect(result.text).toContain('the provider stopped a token loop');
  expect(result.text).not.toContain('raise maxOutputTokens');
});

it('distinguishes token limits, malformed protocol and unknown missing calls without guessing size', () => {
  expect(lostCallNotice({ finishReason: 'length', toolData: false, parsedCalls: 0, outputLimit: 100 })).toContain('output-token limit');
  expect(lostCallNotice({ toolData: true, parsedCalls: 0, outputLimit: 100 })).toContain('no usable call remained');
  expect(lostCallNotice()).toContain('cause is unknown');
});

it('does not count identical writes and edits as changes or invalidate a successful check', async () => {
  let calls = 0;
  const f = await setup((_body, _req, res) => {
    calls++;
    completion(res, calls === 1 ? { tool: { name: 'write', arguments: { path: 'same.txt', content: 'same\n' } } }
      : calls === 2 ? { tool: { name: 'edit', arguments: { path: 'same.txt', edits: [{ oldText: 'same', newText: 'same' }] } } }
      : { text: 'The file was already correct; nothing changed.' });
  });
  await writeFile(join(f.cwd, 'same.txt'), 'same\n');
  const result = await runAttempt({ ...f, tier: 'normal', workload: 'coder', web: false, approve: async () => true, prompt: 'check this file' });
  expect(result.success).toBe(true);
  expect(result.changedFiles).toEqual([]);
  expect(result.fileSizes).toEqual({});
  expect(JSON.stringify(result.steps)).toContain('no change: oldText and newText are identical');
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
