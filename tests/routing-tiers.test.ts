import { afterEach, expect, it } from 'vitest';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SessionGrants } from '../src/execution/grants.js';
import { executionProfiles, directTier, effectiveProfile, profileAvailable } from '../src/routing/execution.js';
import { inferenceSchema, runInference } from '../src/integration/inference.js';
import { loadConfig } from '../src/config.js';
import { runHost } from '../src/host.js';
import { readRoutingPlan, readWebAutoGrant } from '../src/routing/intent.js';
import { completion, events, fixture, jev, mockServer } from './helpers.js';

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup(); });

it('defines the four profiles from two physical models', async () => {
  expect(executionProfiles).toEqual({
    fast: expect.objectContaining({ model: 'fast', thinking: 'off', effort: 'none', contextTokens: 8192, maxOutputTokens: 2048 }),
    normal: expect.objectContaining({ model: 'capable', thinking: 'off', effort: 'none', contextTokens: 16384, maxOutputTokens: 4096 }),
    reasoning: expect.objectContaining({ model: 'capable', thinking: 'medium', effort: 'medium', contextTokens: 24576, maxOutputTokens: 8192 }),
    deep: expect.objectContaining({ model: 'capable', thinking: 'xhigh', effort: 'xhigh', contextTokens: 32768, maxOutputTokens: 16384 }),
  });
  const f = await fixture(); cleanups.push(f.cleanup);
  f.config.models.capable.reasoningEfforts = ['off', 'medium'];
  expect(profileAvailable(f.config, 'reasoning').available).toBe(true);
  expect(profileAvailable(f.config, 'deep')).toMatchObject({ available: false, reason: expect.stringContaining('xhigh') });
});

it('gives the highest runnable tier on a model its configured limits', async () => {
  const f = await fixture(); cleanups.push(f.cleanup);
  Object.assign(f.config.models.capable, { contextTokens: 32768, maxOutputTokens: 16384, reasoningEfforts: ['off'] });
  expect(effectiveProfile(f.config, 'normal')).toMatchObject({ contextTokens: 32768, maxOutputTokens: 16384 });
  f.config.models.capable.reasoningEfforts = ['off', 'medium'];
  expect(effectiveProfile(f.config, 'normal')).toMatchObject({ contextTokens: 16384, maxOutputTokens: 4096 });
  expect(effectiveProfile(f.config, 'reasoning')).toMatchObject({ contextTokens: 32768, maxOutputTokens: 16384 });
});

it('selects conservatively and keeps related capable work on 27B', () => {
  expect(directTier('ask', undefined, 'What is dependency injection?')).toBe('fast');
  expect(directTier('coder', undefined, 'Fix a typo')).toBe('normal');
  expect(directTier('ask', undefined, 'Summarize this', 'normal')).toBe('normal');
  expect(directTier('coder', undefined, 'Debug the ambiguous failure', 'normal')).toBe('reasoning');
  expect(directTier('coder', undefined, 'Make an architecture decision', 'reasoning')).toBe('deep');
  expect(directTier('ask', 'fast', 'Architecture decision', 'deep')).toBe('fast');
});

it('sends exact native efforts and profile output caps through the production adapter', async () => {
  const payloads: any[] = [];
  const f = await fixture(); cleanups.push(f.cleanup);
  const server = await mockServer((body, request, response) => {
    if (request.url?.endsWith('/models')) { response.end(JSON.stringify({ data: [{ id: 'fast-test' }, { id: 'capable-test' }] })); return; }
    payloads.push(body); completion(response, { text: 'done' });
  });
  cleanups.push(server.close);
  f.config.routingMode = 'direct';
  f.config.models.fast.baseUrl = server.url;
  f.config.models.capable.baseUrl = server.url;
  for (const tier of ['fast', 'normal', 'reasoning', 'deep'] as const) {
    await runInference(f.config, inferenceSchema.parse({ model: tier, messages: [{ role: 'user', content: [{ type: 'text', text: 'reply' }] }] }), { approve: async () => true });
  }
  expect(payloads.map(body => [body.model, body.reasoning_effort, body.max_tokens])).toEqual([
    ['fast-test', 'none', 2048], ['capable-test', 'none', 4096], ['capable-test', 'medium', 8192], ['capable-test', 'xhigh', 16384],
  ]);
});

it('binds grants to the canonical root, applies prerequisites, and cascades revocation', async () => {
  const f = await fixture(); cleanups.push(f.cleanup);
  const grants = await SessionGrants.create(f.cwd, f.config, 'chat');
  const approvals: any[] = [], events: string[] = [];
  expect(grants.list()).toEqual(['inference']);
  expect(await grants.request(['repository.write'], 'edit the requested file', async approval => { approvals.push(approval); return true; }, undefined,
    async type => { events.push(type); })).toBe(true);
  expect(grants.list()).toEqual(['inference', 'repository.read', 'repository.write']);
  expect(approvals[0]).toMatchObject({ kind: 'capability', permissions: ['repository.read', 'repository.write'], cwd: grants.root, duration: 'session' });
  expect(events).toEqual(['grant_requested', 'grant_granted']);
  grants.revoke('repository.read');
  expect(grants.list()).toEqual(['inference']);
  f.config.policy.permissions = ['inference'];
  const limited = await SessionGrants.create(f.cwd, f.config, 'chat');
  expect(await limited.request(['repository.read'], 'inspect files', async () => true)).toBe(false);
});

it('migrates local-only legacy configuration and rejects enabled cloud execution', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'teapilot-legacy-')); cleanups.push(() => rm(directory, { recursive: true, force: true }));
  const f = await fixture(); cleanups.push(f.cleanup);
  const local = { ...f.config.models.capable, reasoningEfforts: ['off'] };
  const legacy = { local, economy: { ...local, enabled: false }, strong: { ...local, enabled: false } };
  await writeFile(join(directory, 'models.json'), JSON.stringify(legacy));
  const migrated = await loadConfig(directory, {});
  expect(migrated.models.fast.enabled).toBe(false);
  expect(migrated.models.capable).toMatchObject({ id: local.id, compatibility: true, reasoningEfforts: ['off'] });
  expect(migrated.source?.warnings?.[0]).toContain('compatibility capable-only');
  await writeFile(join(directory, 'models.json'), JSON.stringify({ ...legacy, economy: { ...local, enabled: true } }));
  await expect(loadConfig(directory, {})).rejects.toThrow('Cloud execution settings');
});

it('batches routing and capability questions into one Jev charge', async () => {
  const f = await fixture(); cleanups.push(f.cleanup);
  const server = await mockServer((body, request, response) => {
    if (request.url === '/jev') {
      expect(Object.keys(body.questions)).toEqual(expect.arrayContaining(['tool', 'repository.read', 'repository.write', 'repository.shell', 'web.search', 'web.explicit', 'web.volatile', 'web.low_risk', 'execution_tier', 'relatedness']));
      jev(response, 'ask.normal');
    } else completion(response, { text: 'answered' });
  });
  cleanups.push(server.close);
  f.config.router.endpoint = `${server.url}/jev`;
  f.config.models.fast.baseUrl = server.url;
  f.config.models.capable.baseUrl = server.url;
  const grants = await SessionGrants.create(f.cwd, f.config, 'ask');
  const result = await runHost(f.config, { cwd: f.cwd, prompt: 'Explain this topic', mode: 'ask', authorization: grants }, { approve: async () => false, localProbe: async () => true });
  expect(result).toMatchObject({ success: true, capability: 'ask.normal', spentUsd: 0.00001 });
  expect(result.receipts).toHaveLength(1);
});

it('does not expand access for uncertain or contradictory routing answers', () => {
  const answer = (choice: string, confidence = 0.99) => ({ type: 'choice', choice, probabilities: { [choice]: 1 }, confidence });
  const base: any = { answers: {
    'repository.read': answer('no'), 'repository.write': answer('no'), 'repository.shell': answer('no'), 'web.search': answer('no'),
    execution_tier: answer('normal'), relatedness: answer('related'),
  } };
  expect(readRoutingPlan({ ...base, answers: { ...base.answers, 'repository.read': answer('unclear') } }, 0.55, 'ask')).toBeUndefined();
  expect(readRoutingPlan({ ...base, answers: { ...base.answers, 'repository.read': answer('no'), 'repository.write': answer('yes') } }, 0.55, 'coder')).toBeUndefined();
  expect(readRoutingPlan({ ...base, answers: { ...base.answers, 'repository.read': answer('yes', 0.2) } }, 0.55, 'coder')).toBeUndefined();
});

it('reads web.search auto-grant conditions independently, above 0.75 confidence only', () => {
  const answer = (choice: string, confidence = 0.99) => ({ type: 'choice', choice, probabilities: { [choice]: 1 }, confidence });
  const raw = (fields: Record<string, any>): any => ({ answers: { 'repository.read': answer('unclear', 0.1), ...fields } });
  expect(readWebAutoGrant(raw({}))).toEqual([]);
  expect(readWebAutoGrant(raw({ 'web.explicit': answer('yes', 0.76) }))).toEqual(['explicit']);
  expect(readWebAutoGrant(raw({ 'web.volatile': answer('yes', 0.9) }))).toEqual(['volatile']);
  expect(readWebAutoGrant(raw({ 'web.low_risk': answer('yes', 0.9) }))).toEqual(['low_risk']);
  expect(readWebAutoGrant(raw({ 'web.explicit': answer('yes', 0.9), 'web.volatile': answer('yes', 0.9) }))).toEqual(['explicit', 'volatile']);
  expect(readWebAutoGrant(raw({ 'web.explicit': answer('yes', 0.75) }))).toEqual([]);
  expect(readWebAutoGrant(raw({ 'web.volatile': answer('yes', 0.6) }))).toEqual([]);
  expect(readWebAutoGrant(raw({ 'web.explicit': answer('unclear'), 'web.volatile': answer('no'), 'web.low_risk': answer('unclear') }))).toEqual([]);
  expect(readWebAutoGrant(undefined)).toEqual([]);
});

it('falls back to coder.normal, not ask.normal, for a low-confidence Code-mode decision, and the coder agent runs', async () => {
  const f = await fixture(); cleanups.push(f.cleanup);
  let calls = 0;
  const server = await mockServer((body, request, response) => {
    if (request.url === '/jev') { jev(response, 'ask.normal', 0.1); return; }
    calls++;
    if (calls === 1) completion(response, { tool: { name: 'request_capabilities', arguments: { permissions: ['repository.write'] } } });
    else if (calls === 2) {
      expect(body.tools.map((tool: any) => tool.function.name)).toContain('write');
      completion(response, { tool: { name: 'write', arguments: { path: 'index.html', content: '<html></html>\n' } } });
    } else completion(response, { text: 'done' });
  });
  cleanups.push(server.close);
  f.config.router.endpoint = `${server.url}/jev`;
  f.config.models.fast.baseUrl = server.url;
  f.config.models.capable.baseUrl = server.url;
  const grants = await SessionGrants.create(f.cwd, f.config, 'code');
  const result = await runHost(f.config, { cwd: f.cwd, prompt: 'Write a complete, self-contained Pong game to index.html', mode: 'code', authorization: grants }, { approve: async () => true, localProbe: async () => true });
  expect(result).toMatchObject({ success: true, capability: 'coder.normal' });
  expect(await readFile(join(f.cwd, 'index.html'), 'utf8')).toContain('<html>');
  const log = await events(f.config);
  expect(log.find(entry => entry.type === 'routing_fallback')).toMatchObject({ capability: 'coder.normal', reason: 'low_confidence' });
});

it('keeps ask.normal for a low-confidence decision in Ask mode', async () => {
  const f = await fixture(); cleanups.push(f.cleanup);
  f.config.models.fast.enabled = false;
  const server = await mockServer((body, request, response) => {
    if (request.url === '/jev') { jev(response, 'ask.normal', 0.1); return; }
    completion(response, { text: 'answered' });
  });
  cleanups.push(server.close);
  f.config.router.endpoint = `${server.url}/jev`;
  f.config.models.capable.baseUrl = server.url;
  const grants = await SessionGrants.create(f.cwd, f.config, 'ask');
  const result = await runHost(f.config, { cwd: f.cwd, prompt: 'Explain this topic', mode: 'ask', authorization: grants }, { approve: async () => false, localProbe: async () => true });
  expect(result).toMatchObject({ success: true, capability: 'ask.normal' });
  const log = await events(f.config);
  expect(log.find(entry => entry.type === 'routing_fallback')).toMatchObject({ capability: 'ask.normal', reason: 'low_confidence' });
});

it('falls back to ask.normal, not ask.fast, when the router is unsure and fast is enabled', async () => {
  const f = await fixture(); cleanups.push(f.cleanup);
  const server = await mockServer((body, request, response) => {
    if (request.url === '/jev') { jev(response, 'ask.fast', 0.1); return; }
    completion(response, { text: 'answered' });
  });
  cleanups.push(server.close);
  f.config.router.endpoint = `${server.url}/jev`;
  f.config.models.capable.baseUrl = server.url;
  const grants = await SessionGrants.create(f.cwd, f.config, 'ask');
  const result = await runHost(f.config, { cwd: f.cwd, prompt: 'Explain this topic', mode: 'ask', authorization: grants }, { approve: async () => false, localProbe: async () => true });
  expect(result).toMatchObject({ success: true, capability: 'ask.normal' });
  const log = await events(f.config);
  expect(log.find(entry => entry.type === 'routing_fallback')).toMatchObject({ capability: 'ask.normal', reason: 'low_confidence' });
});

it('activates direct-mode repository tools in place without restarting the turn', async () => {
  const f = await fixture(); cleanups.push(f.cleanup);
  let calls = 0;
  const server = await mockServer((body, _request, response) => {
    calls++;
    if (calls === 1) completion(response, { tool: { name: 'request_capabilities', arguments: { permissions: ['repository.write'] } } });
    else if (calls === 2) {
      expect(body.tools.map((tool: any) => tool.function.name)).toContain('write');
      completion(response, { tool: { name: 'write', arguments: { path: 'granted.txt', content: 'approved\n' } } });
    } else completion(response, { text: 'done' });
  });
  cleanups.push(server.close);
  f.config.routingMode = 'direct'; f.config.models.capable.baseUrl = server.url;
  const grants = await SessionGrants.create(f.cwd, f.config, 'chat');
  const result = await runHost(f.config, { cwd: f.cwd, prompt: 'Create granted.txt', mode: 'chat', authorization: grants }, {
    localProbe: async () => true,
    approve: async approval => approval.kind === 'capability',
  });
  expect(result).toMatchObject({ success: true, attempts: 1, capability: 'ask.normal' });
  expect(await readFile(join(f.cwd, 'granted.txt'), 'utf8')).toBe('approved\n');
  expect(grants.list()).toEqual(['inference', 'repository.read', 'repository.write']);
});

it('answers a request for already-active access without asking or re-sending instructions', async () => {
  const f = await fixture(); cleanups.push(f.cleanup);
  const payloads: any[] = [];
  const server = await mockServer((body, _request, response) => {
    payloads.push(body);
    if (payloads.length <= 2) completion(response, { tool: { name: 'request_capabilities', arguments: { permissions: ['repository.read'] } } });
    else completion(response, { text: 'done' });
  });
  cleanups.push(server.close);
  f.config.routingMode = 'direct'; f.config.models.capable.baseUrl = server.url;
  const grants = await SessionGrants.create(f.cwd, f.config, 'code');
  const approvals: string[] = [];
  const result = await runHost(f.config, { cwd: f.cwd, prompt: 'Look around', mode: 'code', authorization: grants }, {
    localProbe: async () => true,
    approve: async approval => { approvals.push(approval.kind); return true; },
  });
  expect(result).toMatchObject({ success: true });
  expect(approvals.filter(kind => kind === 'capability').length).toBeLessThanOrEqual(1);
  const last = JSON.stringify(payloads.at(-1).messages);
  expect(last).toContain('Already active: repository.read');
  expect(last.split('[host notice]').length - 1).toBe(1);
});
