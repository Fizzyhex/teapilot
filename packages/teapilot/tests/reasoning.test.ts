import { afterEach, expect, it } from 'vitest';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadConfig, ollamaReasoning, type ModelConfig } from '../src/config.js';
import { liveCheck } from '../src/diagnostics.js';
import { inferenceSchema, runInference } from '../src/integration/inference.js';
import { profileAvailable } from '../src/routing/execution.js';
import { applyReports, candidates } from '../src/setup/draft.js';
import { completion, fixture, mockServer, type Handler } from './helpers.js';

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup(); });

async function local(handler: Handler) {
  const f = await fixture(); cleanups.push(f.cleanup);
  const server = await mockServer(handler); cleanups.push(server.close);
  f.config.routingMode = 'direct';
  f.config.models.fast.baseUrl = `${server.url}/v1`;
  f.config.models.capable.baseUrl = `${server.url}/v1`;
  f.config.policy.budget.requestUsd = 0; f.config.policy.budget.dailyUsd = 0;
  return f;
}

/** The reasoning-related fields of every chat request sent through the production adapter. */
async function payloads(reasoning: ModelConfig['reasoning']) {
  const bodies: any[] = [];
  const f = await local((body, _request, response) => { bodies.push(body); completion(response, { text: 'done' }); });
  f.config.models.fast.reasoning = reasoning;
  f.config.models.capable.reasoning = reasoning;
  for (const tier of ['fast', 'normal', 'reasoning', 'deep'] as const) {
    await runInference(f.config, inferenceSchema.parse({ model: tier, messages: [{ role: 'user', content: [{ type: 'text', text: 'reply' }] }] }), { approve: async () => true });
  }
  return bodies.map(body => Object.fromEntries(Object.entries(body).filter(([key]) => ['reasoning_effort', 'chat_template_kwargs', 'messages'].includes(key))));
}

it('builds exact reasoning payloads from the model protocol', async () => {
  const effort = await payloads(ollamaReasoning);
  expect(effort.map(body => body.reasoning_effort)).toEqual(['none', 'none', 'medium', 'xhigh']);
  expect(effort.every(body => !('chat_template_kwargs' in body))).toBe(true);

  const template = await payloads({ type: 'chat_template_kwargs', values: { off: { enable_thinking: false }, medium: { reasoning_effort: 'medium' }, xhigh: { reasoning_effort: 'xhigh' } } });
  expect(template.map(body => body.chat_template_kwargs)).toEqual([{ enable_thinking: false }, { enable_thinking: false }, { reasoning_effort: 'medium' }, { reasoning_effort: 'xhigh' }]);
  expect(template.every(body => !('reasoning_effort' in body))).toBe(true);

  // No protocol: no reasoning field at all, whatever the tier.
  const none = await payloads(undefined);
  expect(none.every(body => !('reasoning_effort' in body) && !('chat_template_kwargs' in body))).toBe(true);
  // Nothing is appended to the prompt to switch reasoning off.
  expect(JSON.stringify(none.concat(effort, template).map(body => body.messages))).not.toContain('/no_think');
});

it('loads saved configurations without a protocol with unchanged behaviour', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'teapilot-reasoning-')); cleanups.push(() => rm(directory, { recursive: true, force: true }));
  const f = await fixture(); cleanups.push(f.cleanup);
  const saved = (model: ModelConfig, provider: string) => { const copy: Partial<ModelConfig> = { ...model, provider }; delete copy.reasoning; return copy; };
  await writeFile(join(directory, 'models.json'), JSON.stringify({ fast: saved(f.config.models.fast, 'local'), capable: saved(f.config.models.capable, 'ollama') }));
  const config = await loadConfig(directory, {});
  // Ollama models keep sending exactly the reasoning_effort they sent before; other endpoints send none.
  expect(config.models.capable.reasoning).toEqual(ollamaReasoning);
  expect(config.models.capable.reasoningEfforts).toEqual(['off', 'medium', 'xhigh']);
  expect(config.models.fast.reasoning).toBeUndefined();
  // A verified level the protocol cannot express is rejected rather than silently sent as nothing.
  await writeFile(join(directory, 'models.json'), JSON.stringify({ ...config.models, capable: { ...config.models.capable, reasoning: { type: 'reasoning_effort', values: { off: 'none' } } } }));
  await expect(loadConfig(directory, {})).rejects.toThrow('reasoning protocol');
});

it('enables only the reasoning tiers whose own live check passes', async () => {
  const efforts: unknown[] = [];
  const f = await local((body, request, response) => {
    if (request.url?.endsWith('/models')) { response.end(JSON.stringify({ data: [{ id: 'capable-test' }] })); return; }
    efforts.push(body.reasoning_effort);
    // This server cannot run xhigh.
    if (body.reasoning_effort === 'xhigh') { response.writeHead(400); response.end('{"error":"unsupported reasoning_effort"}'); return; }
    completion(response, { text: 'TEAPILOT_OK' });
  });
  const model = f.config.models.capable;
  Object.assign(model, { toolCalling: false, reasoningEfforts: ['off'] });
  expect(candidates(f.config, 'capable')).toEqual(['medium', 'xhigh']);
  const report = await liveCheck(f.config, 'normal', undefined, undefined, candidates(f.config, 'capable'));
  expect(report).toMatchObject({ ask: true, reasoning: ['medium'] });
  expect(efforts).toEqual(['none', 'medium', 'xhigh']);
  // The probe leaves the caller's configuration alone.
  expect(model.reasoningEfforts).toEqual(['off']);
  applyReports(f.config, ['capable'], new Map([['capable', report]]));
  expect(model.reasoningEfforts).toEqual(['off', 'medium']);
  expect(profileAvailable(f.config, 'reasoning').available).toBe(true);
  expect(profileAvailable(f.config, 'deep')).toMatchObject({ available: false });
  // Coding was never verified, so no capable tier may code.
  expect(f.config.policy.disabledCapabilities).toEqual(expect.arrayContaining(['coder.normal', 'coder.reasoning', 'coder.deep']));

  // Failed or skipped checks leave both tiers unavailable.
  applyReports(f.config, ['capable'], new Map([['capable', undefined]]));
  expect(model.reasoningEfforts).toEqual(['off']);
  expect(profileAvailable(f.config, 'reasoning').available).toBe(false);
});

it('reports the layer a live check failed at without matching message text', async () => {
  const incompatible = await local((_body, _request, response) => { response.writeHead(422); response.end('{}'); });
  expect(await liveCheck(incompatible.config, 'normal')).toMatchObject({ ask: false, failure: 'api' });
  const unloadable = await local((_body, _request, response) => { response.writeHead(500); response.end('{"error":"out of memory"}'); });
  expect(await liveCheck(unloadable.config, 'normal')).toMatchObject({ ask: false, failure: 'load' });
  const silent = await local((_body, _request, response) => completion(response, { text: 'something else' }));
  expect(await liveCheck(silent.config, 'normal')).toMatchObject({ ask: false, failure: 'answer' });
  const noTools = await local((_body, _request, response) => completion(response, { text: 'TEAPILOT_OK' }));
  expect(await liveCheck(noTools.config, 'normal')).toMatchObject({ ask: true, tools: false, failure: 'tools' });
});
