import { afterEach, expect, it } from 'vitest';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { completion, fixture, mockServer } from './helpers.js';
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

it('does not size a failed write and records no observed edit', async () => {
  const f = await setup((_body, _req, res) => completion(res, { text: 'No tools used.' }));
  const result = await runAttempt({ ...f, tier: 'normal', workload: 'ask', web: false, approve: async () => true, prompt: 'hello' });
  expect(result.success).toBe(true);
  expect(result.changedFiles).toEqual([]);
  expect(result.fileSizes).toEqual({});
});
