import { describe, it, expect, afterEach } from 'vitest';
import { PassThrough } from 'node:stream';
import { readFile, writeFile, unlink } from 'node:fs/promises';
import { join } from 'node:path';
import { fixture, mockServer, completion } from './helpers.js';
import { StreamRedactor, prepareConversation } from '../src/integration/events.js';
import { runHost } from '../src/host.js';
import { inferenceContext, inferenceSchema, modelInformation, runInference } from '../src/integration/inference.js';
import { Review, cleanReviews, readReviewText } from '../src/integration/review.js';
import { serve } from '../src/integration/service.js';

describe('VS Code integration boundaries', () => {
  const cleanups: (() => Promise<unknown>)[] = [];
  afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup(); });
  async function local(handler: Parameters<typeof mockServer>[0]) {
    const f = await fixture(); cleanups.push(f.cleanup);
    const server = await mockServer(handler); cleanups.push(server.close);
    f.config.routingMode = 'direct';
    f.config.models.fast.baseUrl = server.url;
    f.config.models.capable.baseUrl = server.url;
    f.config.models.capable.contextTokens = 32768;
    return f;
  }
  it('redacts exact secrets even when split across every character', () => {
    const redactor = new StreamRedactor(['secret-value', 'secret']);
    const output = [...'a secret-value z'].map(c => redactor.push(c)).join('') + redactor.push('', true);
    expect(output).toBe('a [REDACTED] z');
    const long = new StreamRedactor(['token-abcdef']);
    expect(long.push('hello token-ab')).toBe('hello ');
    expect(long.push('cdef!')).toBe('[REDACTED]!');
  });
  it('keeps complete recent turns and rejects oversized current context', () => {
    const turn = { user: 'first', assistant: 'answer' };
    expect(prepareConversation('current', [], [turn, turn], 180)).toMatchObject({ history: [turn], omitted: 1 });
    expect(() => prepareConversation('x'.repeat(101), [], [], 100)).toThrow('Current request');
  });
  it('streams a standalone model and settles its cost without executing tools', async () => {
    const f = await local((body, _request, response) => {
      expect(body.tools[0].function.name).toBe('write');
      completion(response, { tool: { name: 'write', arguments: { path: 'untouched', content: 'no' } } });
    });
    const events: any[] = [];
    const request = inferenceSchema.parse({ model: 'normal', messages: [{ role: 'user', content: [{ type: 'text', text: 'write' }] }], tools: [{ name: 'write', description: 'write a file', parameters: { type: 'object', properties: {} } }], toolMode: 'required' });
    const result = await runInference(f.config, request, { approve: async () => true, onEvent: e => events.push(e) });
    expect(result).toMatchObject({ status: 'completed', spentUsd: 0, tier: 'normal' });
    expect(events.some(e => e.type === 'tool_call' && e.name === 'write')).toBe(true);
    await expect(readFile(join(f.cwd, 'untouched'))).rejects.toThrow();
  });
  it('preserves tool call IDs and matching result names', async () => {
    const f = await fixture(); cleanups.push(f.cleanup);
    const request = inferenceSchema.parse({ model: 'normal', messages: [
      { role: 'assistant', content: [{ type: 'toolCall', id: 'call-1', name: 'lookup', arguments: { query: 'x' } }] },
      { role: 'user', content: [{ type: 'toolResult', id: 'call-1', text: 'found' }, { type: 'text', text: 'continue' }] },
    ] });
    const context = inferenceContext(request, f.config, 'normal');
    expect(context.messages[1]).toMatchObject({ role: 'toolResult', toolCallId: 'call-1', toolName: 'lookup' });
    expect(context.messages[2]).toMatchObject({ role: 'user' });
    request.messages[1]!.content[0] = { type: 'toolResult', id: 'missing', text: 'x' };
    expect(() => inferenceContext(request, f.config, 'normal')).toThrow('Unmatched');
  });
  it('fixed models never fallback and unavailable models are not advertised', async () => {
    let calls = 0;
    const f = await local((_body, _request, response) => { calls++; response.writeHead(500); response.end('failure'); });
    await expect(runInference(f.config, inferenceSchema.parse({ model: 'normal', messages: [{ role: 'user', content: [{ type: 'text', text: 'hello' }] }] }), { approve: async () => true })).rejects.toThrow('Inference stopped');
    expect(calls).toBe(1);
    f.config.models.capable.enabled = false;
    expect(modelInformation(f.config).some(m => m.id === 'normal')).toBe(false);
  });
  it('Auto retries an eligible tier before output, but never after partial output', async () => {
    const models: string[] = [];
    const f = await local((body, _request, response) => {
      models.push(body.model);
      if (body.model === 'capable-test') { response.writeHead(500); response.end('failure'); }
      else completion(response, { text: 'fallback', cost: 0.00001 });
    });
    const request = inferenceSchema.parse({ model: 'auto', messages: [{ role: 'user', content: [{ type: 'text', text: 'hello' }] }] });
    const result = await runInference(f.config, request, { approve: async () => true });
    expect(result.tier).toBe('fast'); expect(models).toEqual(['capable-test', 'fast-test']);
    const partial = await mockServer((_body, _request, response) => {
      response.setHeader('Content-Type', 'text/event-stream');
      response.write('data: {"id":"partial","object":"chat.completion.chunk","created":1,"model":"local-test","choices":[{"index":0,"delta":{"content":"partial"},"finish_reason":null}]}\n\n');
      setTimeout(() => response.destroy(), 30);
    }); cleanups.push(partial.close);
    f.config.models.capable.baseUrl = partial.url;
    await expect(runInference(f.config, request, { approve: async () => true })).rejects.toThrow('partial responses');
    expect(models).toHaveLength(2);
  });
  it('performs no inference after approval denial', async () => {
    let calls = 0;
    const f = await local((_body, _request, response) => { calls++; completion(response, { text: 'paid', cost: 0.00001 }); });
    const request = inferenceSchema.parse({ model: 'deep', messages: [{ role: 'user', content: [{ type: 'text', text: 'hello' }] }] });
    f.config.policy.budget.approvalThresholdUsd = 0;
    await expect(runInference(f.config, request, { approve: async () => false })).rejects.toThrow('approval denied');
    expect(calls).toBe(0);
  });
  it('rejects attached protected paths before invoking a provider', async () => {
    const f = await fixture(); cleanups.push(f.cleanup); f.config.routingMode = 'direct';
    await expect(runHost(f.config, { prompt: 'explain', workload: 'ask', cwd: f.cwd, context: [{ name: 'credential', text: 'sensitive', path: '.env' }] }, { approve: async () => true })).rejects.toThrow('protected');
  });
  it('captures pre-existing edits and shell-style additions/deletions, with protected paths excluded', async () => {
    const f = await fixture(); cleanups.push(f.cleanup);
    await writeFile(join(f.cwd, 'existing.txt'), 'user edits');
    await writeFile(join(f.cwd, 'deleted.txt'), 'original');
    await writeFile(join(f.cwd, '.env'), 'password=private');
    const review = new Review(f.cwd, f.config); await review.start();
    await writeFile(join(f.cwd, 'existing.txt'), 'agent edits');
    await writeFile(join(f.cwd, 'created.txt'), 'new');
    await unlink(join(f.cwd, 'deleted.txt'));
    const result = await review.finish();
    expect(result.changes.map(c => c.path).sort()).toEqual(['created.txt', 'deleted.txt', 'existing.txt']);
    const changed = result.changes.find(c => c.path === 'existing.txt')!;
    expect(await readReviewText(f.config.stateDir, result.id, changed.index, 'before')).toBe('user edits');
    expect(await readReviewText(f.config.stateDir, result.id, changed.index, 'after')).toBe('agent edits');
    await expect(readReviewText(f.config.stateDir, '../outside', 0, 'before')).rejects.toThrow('Invalid');
    await cleanReviews(f.config.stateDir, true);
    await expect(readReviewText(f.config.stateDir, result.id, changed.index, 'before')).rejects.toThrow();
  });
  it('replays structured conversational roles and emits streaming text', async () => {
    const f = await local((body, _request, response) => {
      expect(body.messages.some((m: any) => m.role === 'assistant' && m.content === 'earlier answer')).toBe(true);
      completion(response, { text: 'follow-up' });
    });
    const events: any[] = [];
    const result = await runHost(f.config, { prompt: 'continue', cwd: f.cwd, workload: 'ask', history: [{ user: 'earlier question', assistant: 'earlier answer' }] }, { approve: async () => true, localProbe: async () => true, onEvent: e => events.push(e) });
    expect(result.success).toBe(true);
    expect(events.filter(e => e.type === 'text').map(e => e.text).join('')).toBe('follow-up');
  });
  it('rejects protocol mismatches and initializes without touching a repository profile', async () => {
    const input = new PassThrough(), output = new PassThrough(); const replies: any[] = [];
    output.on('data', chunk => replies.push(...chunk.toString().trim().split('\n').map(JSON.parse)));
    const running = serve(input, output);
    input.write(JSON.stringify({ version: 99, id: 'bad', method: 'initialize' }) + '\n');
    input.write(JSON.stringify({ version: 1, id: 'good', method: 'initialize', params: {} }) + '\n');
    await new Promise(resolve => setTimeout(resolve, 20)); input.end(); await running;
    expect(replies[0].error).toContain('Invalid protocol');
    expect(replies.find(r => r.id === 'good').result.protocolVersion).toBe(1);
  });
});
