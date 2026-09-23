import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { once } from 'node:events';
import { loadConfig, type Config } from '../src/config.js';

export async function fixture(): Promise<{ config: Config; cwd: string; cleanup: () => Promise<void> }> {
  const cwd = await mkdtemp(join(tmpdir(), 'teapilot-test-'));
  const config = await loadConfig(cwd, {});
  config.stateDir = join(cwd, '.state');
  config.router.apiKey = 'fixture-jev-secret';
  config.secrets = { local: undefined, economy: 'fixture-cloud-secret', strong: 'fixture-cloud-secret' };
  config.models.local.id = 'local-test';
  for (const tier of ['economy', 'strong'] as const) {
    config.models[tier].enabled = true;
    config.models[tier].id = `${tier}-test`;
    config.models[tier].inputUsdPerMillion = tier === 'economy' ? 0.2 : 1;
    config.models[tier].outputUsdPerMillion = tier === 'economy' ? 0.5 : 2;
  }
  config.policy.limits.requestTimeoutMs = 5000;
  config.policy.limits.attemptTimeoutMs = 10000;
  return { config, cwd, cleanup: () => rm(cwd, { recursive: true, force: true }) };
}
export type Handler = (body: any, request: IncomingMessage, response: ServerResponse) => void | Promise<void>;
export async function mockServer(handler: Handler): Promise<{ url: string; close: () => Promise<void> }> {
  const server = createServer(async (request, response) => {
    let raw = '';
    for await (const part of request) raw += part;
    try { await handler(raw ? JSON.parse(raw) : {}, request, response); }
    catch (error) { response.writeHead(500); response.end(String(error)); }
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('Missing mock server address');
  return { url: `http://127.0.0.1:${address.port}`, close: () => new Promise<void>((done, reject) => { server.close(error => error ? reject(error) : done()); server.closeAllConnections(); }) };
}
export function jev(response: ServerResponse, selected: string, confidence = 0.99, probabilities?: Record<string, number>): void {
  response.setHeader('Content-Type', 'application/json');
  const all = Object.fromEntries(['coder.local', 'coder.economy', 'coder.strong', 'ask.local', 'ask.economy', 'ask.strong'].map(id => [id, id === selected ? 1 : 0]));
  response.end(JSON.stringify({ answers: { tool: { type: 'choice', choice: selected, probabilities: { ...all, ...probabilities }, confidence } }, usage: { input_tokens: 100, output_tokens: 0, cost: 0.00001 } }));
}
export function completion(response: ServerResponse, options: { text?: string; tool?: { name: string; arguments: unknown }; cost?: number; noUsage?: boolean; model?: string }): void {
  response.setHeader('Content-Type', 'text/event-stream');
  const common = { id: 'mock-chat', object: 'chat.completion.chunk', created: 1, model: options.model ?? 'mock-model' };
  const delta = options.tool ? { role: 'assistant', tool_calls: [{ index: 0, id: `call-${Date.now()}`, type: 'function', function: { name: options.tool.name, arguments: JSON.stringify(options.tool.arguments) } }] } : { role: 'assistant', content: options.text ?? 'Done.' };
  const chunk = (value: unknown) => response.write(`data: ${JSON.stringify(value)}\n\n`);
  chunk({ ...common, choices: [{ index: 0, delta, finish_reason: null }] });
  chunk({ ...common, choices: [{ index: 0, delta: {}, finish_reason: options.tool ? 'tool_calls' : 'stop' }], ...(!options.noUsage ? { usage: { prompt_tokens: 120, completion_tokens: 20, total_tokens: 140, ...(options.cost !== undefined ? { cost: options.cost } : {}) } } : {}) });
  response.end('data: [DONE]\n\n');
}
export async function events(config: Config): Promise<any[]> {
  return (await readFile(join(config.stateDir, 'outcomes.jsonl'), 'utf8')).trim().split('\n').map(line => JSON.parse(line));
}
