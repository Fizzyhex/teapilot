import { afterEach, expect, it, vi } from 'vitest';
import { doctor, endpointStatus } from '../src/diagnostics.js';
import { endpointDriver, isRuntimeError, RuntimeError, type RuntimeDriver, type Runtimes } from '../src/runtime/index.js';
import { ollamaDriver, provisionedOllama, streamOperation } from '../src/runtime/ollama.js';
import { applyProvisioned, modelSources } from '../src/setup/draft.js';
import { fixture, mockServer } from './helpers.js';

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => { vi.unstubAllGlobals(); for (const cleanup of cleanups.splice(0).reverse()) await cleanup(); });

async function setupFixture() { const f = await fixture(); cleanups.push(f.cleanup); return f; }

/** A managed runtime that touches no process or network. */
function fake(overrides: Partial<RuntimeDriver> = {}): RuntimeDriver {
  return {
    id: 'fake', label: 'Fake runtime', ownership: 'managed',
    suitability: async () => ({ suitable: true, summary: 'ok' }),
    inspect: async () => ({ ownership: 'managed', ready: false }),
    ensure: async () => {}, provision: async () => [], hint: async () => undefined,
    ...overrides,
  };
}

it('fills ordinary model entries from provisioned Ollama models, as setup always has', async () => {
  const { config } = await setupFixture();
  const env: Record<string, string> = { LOCAL_API_KEY: 'stale' };
  const prepared = [
    { id: 'teapilot/fast:q4', source: 'fast:q4', context: 8192, tools: true, reasoning: [], roles: ['fast' as const] },
    { id: 'teapilot/big:q4', source: 'big:q4', context: 32768, tools: false, reasoning: ['medium' as const, 'xhigh' as const], roles: ['capable' as const] },
  ];
  const result = applyProvisioned(config, env, ollamaDriver, prepared.map(provisionedOllama));
  expect(result).toEqual({ roles: ['fast', 'capable'], displayModel: 'fast:q4 (fast), big:q4 (capable)' });
  expect(config.models.fast).toMatchObject({ id: 'teapilot/fast:q4', provider: 'ollama', baseUrl: 'http://127.0.0.1:11434/v1', apiKeyEnv: 'LOCAL_API_KEY', contextTokens: 8192, maxOutputTokens: 2048, temperature: 0.2, reasoningEfforts: ['off'], reasoning: { type: 'reasoning_effort', values: { off: 'none' } } });
  // Reasoning levels are candidates in the protocol; none is verified yet.
  expect(config.models.capable).toMatchObject({ id: 'teapilot/big:q4', contextTokens: 32768, maxOutputTokens: 16384, toolCalling: false, reasoningEfforts: ['off'], reasoning: { type: 'reasoning_effort', values: { off: 'none', medium: 'medium', xhigh: 'xhigh' } } });
  expect(env.LOCAL_API_KEY).toBeUndefined();
  expect(config.policy.limits.requestTimeoutMs).toBe(120000);
  // No runtime metadata leaks into the saved model entries.
  expect(Object.keys(config.models.capable).sort()).toEqual(Object.keys(config.models.fast).sort());
});

it('connects an existing endpoint without reasoning, keeping its credential outside the model entry', async () => {
  const { config } = await setupFixture();
  const env: Record<string, string> = {};
  const timeout = config.policy.limits.requestTimeoutMs;
  const driver = endpointDriver({ baseUrl: 'http://127.0.0.1:9/v1', id: 'served', contextTokens: 16384, key: 'endpoint-secret' });
  expect(driver.ownership).toBe('unmanaged');
  applyProvisioned(config, env, driver, await driver.provision({ ui: undefined as never, signal: new AbortController().signal }));
  expect(config.models.capable).toMatchObject({ id: 'served', provider: 'local', maxOutputTokens: 4096, toolCalling: true, reasoningEfforts: ['off'] });
  expect(config.models.capable.reasoning).toBeUndefined();
  expect(JSON.stringify(config.models)).not.toContain('endpoint-secret');
  expect(env[config.models.capable.apiKeyEnv]).toBe('endpoint-secret');
  expect(config.policy.limits.requestTimeoutMs).toBe(timeout);
});

it('offers unavailable runtimes with the reason instead of hiding them', async () => {
  const nvidia = fake({ id: 'nvidia', label: 'Optimized NVIDIA', suitability: async () => ({ suitable: false, kind: 'hardware', reason: 'No NVIDIA GPU was found.' }) });
  const sources = await modelSources({ ollama: fake({ id: 'ollama', label: 'Locally via Ollama' }), nvidia }, new AbortController().signal);
  expect(sources.flatMap(source => source.summary ?? [])).toEqual(['Locally via Ollama: ok', 'Optimized NVIDIA is not available on this computer: No NVIDIA GPU was found.']);
  expect(sources.map(source => [source.id, source.label, source.unavailable])).toEqual([
    ['ollama', 'Locally via Ollama', undefined],
    ['endpoint', 'An existing local OpenAI-compatible endpoint', undefined],
    ['nvidia', 'Optimized NVIDIA · unavailable', 'No NVIDIA GPU was found.'],
  ]);
});

it('classifies runtime failures by kind, not by message', async () => {
  let calls = 0;
  const server = await mockServer((_body, _request, response) => { calls++; response.end(calls === 1 ? '{"status":"downloading"}\n' : '{"error":"boom"}\n'); });
  cleanups.push(server.close);
  const progress = () => {};
  const interrupted = await streamOperation('/api/pull', {}, new AbortController().signal, progress, server.url).catch(error => error);
  expect(isRuntimeError(interrupted, 'download')).toBe(true);
  const failed = await streamOperation('/api/create', {}, new AbortController().signal, progress, server.url).catch(error => error);
  expect(isRuntimeError(failed, 'load')).toBe(true);
  expect(isRuntimeError(new RuntimeError('declined', 'x'), 'download')).toBe(false);
});

it('tells endpoint failure layers apart', async () => {
  const f = await setupFixture();
  const server = await mockServer((_body, request, response) => {
    if (request.url === '/broken/models') { response.end('{"models":[]}'); return; }
    response.end(JSON.stringify({ data: [{ id: 'other' }] }));
  });
  cleanups.push(server.close);
  f.config.models.capable.baseUrl = `${server.url}/v1`;
  expect(await endpointStatus(f.config, 'normal')).toMatchObject({ layer: 'model-missing' });
  f.config.models.capable.baseUrl = `${server.url}/broken`;
  expect(await endpointStatus(f.config, 'normal')).toMatchObject({ layer: 'api' });
  f.config.models.capable.baseUrl = 'http://127.0.0.1:1/v1';
  expect(await endpointStatus(f.config, 'normal')).toMatchObject({ layer: 'not-ready' });
});

it('doctor reports runtime state and runtime hints from drivers, without generating', async () => {
  const f = await setupFixture();
  f.config.routingMode = 'direct';
  f.config.models.fast.enabled = false;
  f.config.models.capable.baseUrl = 'http://127.0.0.1:1/v1';
  const hint = vi.fn(async () => 'Fake runtime is stopped; start it.');
  const runtimes: Runtimes = { ollama: fake({ inspect: async () => ({ ownership: 'managed', ready: false, baseUrl: 'http://127.0.0.1:1/v1', detail: 'installed' }), hint }) };
  const log = vi.fn();
  expect(await doctor(f.config, f.cwd, { log, consent: async () => false, runtimes })).toBe(false);
  const output = log.mock.calls.map(call => call[0]).join('\n');
  expect(output).toContain('Runtime: Fake runtime: NOT RUNNING; installed');
  expect(output).toContain('Fake runtime is stopped; start it.');
  expect(hint).toHaveBeenCalledWith(expect.objectContaining({ baseUrl: 'http://127.0.0.1:1/v1' }), expect.anything());
  // Reasoning tiers the model has not verified are reported, not probed.
  f.config.models.capable.reasoningEfforts = ['off'];
  log.mockClear();
  await doctor(f.config, f.cwd, { log, consent: async () => false, runtimes });
  expect(log.mock.calls.map(call => call[0]).join('\n')).toContain('deep: unavailable (Native xhigh reasoning is not verified)');
});
