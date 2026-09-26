import type { ServerResponse } from 'node:http';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { afterEach, expect, it } from 'vitest';
import { SessionGrants } from '../src/execution/grants.js';
import { runHost } from '../src/host.js';
import { completion, fixture, mockServer } from './helpers.js';

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup(); });

let callId = 0;
function toolCallMarkedStop(response: ServerResponse, name: string, args: unknown): void {
  response.setHeader('Content-Type', 'text/event-stream');
  const common = { id: 'mock-chat', object: 'chat.completion.chunk', created: 1, model: 'mock-model' };
  const delta = {
    role: 'assistant',
    tool_calls: [{
      index: 0,
      id: `call-stop-${++callId}`,
      type: 'function',
      function: { name, arguments: JSON.stringify(args) },
    }],
  };
  const chunk = (value: unknown) => response.write(`data: ${JSON.stringify(value)}\n\n`);
  chunk({ ...common, choices: [{ index: 0, delta, finish_reason: null }] });
  // Some OpenAI-compatible streaming backends have returned structured
  // tool_calls with "stop" instead of the spec's "tool_calls" finish reason.
  chunk({
    ...common,
    choices: [{ index: 0, delta: {}, finish_reason: 'stop' }],
    usage: { prompt_tokens: 120, completion_tokens: 20, total_tokens: 140 },
  });
  response.end('data: [DONE]\n\n');
}

it('continues after tool results even when the provider marks tool calls as stop', async () => {
  const f = await fixture(); cleanups.push(f.cleanup);
  let calls = 0;
  const server = await mockServer((body, request, response) => {
    if (request.url?.endsWith('/models')) {
      response.end(JSON.stringify({ data: [{ id: 'capable-test' }] }));
      return;
    }
    calls++;
    if (calls === 1) {
      toolCallMarkedStop(response, 'request_capabilities', { permissions: ['repository.write'] });
    } else if (calls === 2) {
      expect(body.tools.map((tool: any) => tool.function.name)).toContain('write');
      toolCallMarkedStop(response, 'write', { path: 'granted.txt', content: 'approved\n' });
    } else {
      completion(response, { text: 'done' });
    }
  });
  cleanups.push(server.close);

  f.config.routingMode = 'direct';
  f.config.models.capable.baseUrl = server.url;
  const grants = await SessionGrants.create(f.cwd, f.config, 'chat');
  const result = await runHost(f.config, {
    cwd: f.cwd,
    prompt: 'Create granted.txt',
    mode: 'chat',
    authorization: grants,
  }, {
    localProbe: async () => true,
    approve: async approval => approval.kind === 'capability',
  });

  expect(result).toMatchObject({ success: true, attempts: 1, capability: 'ask.normal' });
  expect(calls).toBe(3);
  expect(await readFile(join(f.cwd, 'granted.txt'), 'utf8')).toBe('approved\n');
});
