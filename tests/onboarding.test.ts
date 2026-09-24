import { afterEach, expect, it, vi } from 'vitest';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { configDirectory, loadConfig } from '../src/config.js';
import { doctor, liveCheck, modelStatus, routingCheck } from '../src/diagnostics.js';
import { runHost } from '../src/host.js';
import { saveConfiguration, setup } from '../src/setup/index.js';
import { checkDisk, streamOperation } from '../src/setup/ollama.js';
import type { SetupUI } from '../src/setup/terminal.js';
import { completion, events, fixture, jev, mockServer, type Handler } from './helpers.js';

const cleanup: Array<() => Promise<void>> = [];
afterEach(async () => { vi.unstubAllEnvs(); vi.unstubAllGlobals(); for (const fn of cleanup.splice(0).reverse()) await fn(); });

const diagnostic: Handler = (body, request, response) => {
  if (request.url?.endsWith('/models')) { response.end(JSON.stringify({ data: [{ id: 'local-test' }] })); return; }
  const prompt = JSON.stringify(body.messages?.find((m: any) => m.role === 'user')?.content);
  const last = body.messages?.at(-1);
  if (prompt.includes('TEAPILOT_OK')) completion(response, { text: 'TEAPILOT_OK' });
  else if (prompt.includes('teapilot_probe')) {
    if (last.role === 'tool') completion(response, { text: String(last.content) });
    else completion(response, { tool: { name: 'teapilot_probe', arguments: {} } });
  } else if (prompt.includes('Read fixture.js')) {
    const read = body.messages.find((m: any) => m.role === 'tool' && String(m.content).includes('export const add'));
    if (!read) completion(response, { tool: { name: 'read', arguments: { path: 'fixture.js' } } });
    else if (body.messages.filter((m: any) => m.role === 'tool').length === 1) {
      const nonce = String(read.content).match(/\/\/ ([\da-f-]+)/)?.[1];
      completion(response, { tool: { name: 'write', arguments: { path: 'fixture.js', content: `// ${nonce}\nexport const add = (a, b) => a + b;\n` } } });
    } else completion(response, { text: 'DONE' });
  } else completion(response, { text: 'A local answer.' });
};

async function local(handler: Handler = diagnostic) {
  const f = await fixture(); cleanup.push(f.cleanup);
  const server = await mockServer(handler); cleanup.push(server.close);
  f.config.routingMode = 'direct';
  f.config.router.apiKey = undefined;
  f.config.models.capable.baseUrl = `${server.url}/v1`;
  f.config.models.fast.enabled = false;
  f.config.policy.budget.requestUsd = 0; f.config.policy.budget.dailyUsd = 0;
  f.config.secrets = { fast: undefined, capable: undefined };
  return { ...f, server };
}

it('direct local execution needs no credentials, hosted requests, receipts, or budget', async () => {
  const f = await local();
  const provider = { name: 'forbidden', decide: vi.fn(async () => { throw new Error('Hosted network access forbidden'); }) };
  const result = await runHost(f.config, { prompt: 'Explain this', workload: 'ask', cwd: f.cwd }, { approve: async () => false, provider });
  expect(result).toMatchObject({ success: true, spentUsd: 0, receipts: [], capability: 'ask.normal' });
  expect(provider.decide).not.toHaveBeenCalled();
  expect((await events(f.config)).some(e => e.type === 'direct_selection')).toBe(true);
  expect((await events(f.config)).some(e => e.stage === 'routing')).toBe(false);
  await expect(runHost(f.config, { prompt: 'ambiguous', cwd: f.cwd }, { approve: async () => true })).rejects.toThrow('requires');
});

it('direct routing honors permissions, risk, confirmations, and disabled capabilities', async () => {
  const f = await local();
  const run = () => runHost(f.config, { prompt: 'Explain', workload: 'ask', cwd: f.cwd }, { approve: async () => false });
  f.config.policy.permissions = [];
  expect((await run()).success).toBe(false);
  f.config.policy.permissions = ['inference']; f.config.policy.router.allowed_risk_levels = ['medium'];
  expect((await run()).success).toBe(false);
  f.config.policy.router.allowed_risk_levels = ['low']; f.config.policy.router.confirmation_risk_levels = ['low'];
  expect((await run()).status).toBe('approval_denied');
  f.config.policy.router.confirmation_risk_levels = []; f.config.policy.disabledCapabilities = ['ask.normal'];
  expect((await run()).success).toBe(false);
});

it('a failed fully local attempt never falls back to cloud', async () => {
  const f = await local((_body, req, res) => {
    if (req.url?.endsWith('/models')) res.end('{}');
    else { res.writeHead(503); res.end('{}'); }
  });
  const result = await runHost(f.config, { prompt: 'Explain', workload: 'ask', cwd: f.cwd }, { approve: async () => false });
  expect(result).toMatchObject({ success: false, attempts: 3, spentUsd: 0, status: 'escalation_unavailable' });
});

it('live diagnostics prove streaming, tool continuation and a real file edit', async () => {
  const f = await local();
  expect(await liveCheck(f.config, 'normal')).toEqual({ ask: true, tools: true, coding: true, spentUsd: 0 });
});

it('an answer without tool execution is not reported as coding readiness', async () => {
  const f = await local((_body, _req, res) => completion(res, { text: 'TEAPILOT_OK' }));
  expect(await liveCheck(f.config, 'normal')).toEqual({ ask: true, tools: false, coding: false, spentUsd: 0 });
});

it('Ollama execution disables thinking in the actual HTTP request', async () => {
  let effort: unknown;
  const f = await local((body, req, res) => {
    if (req.url?.endsWith('/models')) res.end('{}');
    else { effort = body.reasoning_effort; completion(res, { text: 'A concise answer.' }); }
  });
  f.config.models.capable.provider = 'ollama';
  expect((await runHost(f.config, { prompt: 'Explain', workload: 'ask', cwd: f.cwd }, { approve: async () => false })).success).toBe(true);
  expect(effort).toBe('none');
});

it('local live diagnostics require consent and do not expose credentials', async () => {
  let inferenceCalls = 0;
  const f = await local((body, req, res) => {
    if (!req.url?.endsWith('/models')) inferenceCalls++;
    diagnostic(body, req, res);
  });
  f.config.models.capable.enabled = false;
  Object.assign(f.config.models.fast, { enabled: true, id: 'local-test', baseUrl: `${f.server.url}/v1` });
  f.config.secrets.fast = 'paid-secret';
  const log = vi.fn();
  expect(await doctor(f.config, f.cwd, { live: true, log, consent: async () => false })).toBe(false);
  expect(inferenceCalls).toBe(0);
  expect(await doctor(f.config, f.cwd, { live: true, log, consent: async () => true })).toBe(false);
  expect(inferenceCalls).toBeGreaterThan(0);
  expect(JSON.stringify(log.mock.calls)).not.toContain('paid-secret');
});

it('hosted routing verification needs consent and budget, and never invokes execution', async () => {
  const f = await local();
  let calls = 0;
  const server = await mockServer((_body, _req, res) => { calls++; jev(res, 'ask.normal'); }); cleanup.push(server.close);
  f.config.routingMode = 'hosted';
  f.config.router.apiKey = 'routing-test-key'; f.config.router.endpoint = server.url;
  const log = vi.fn();
  expect(await routingCheck(f.config, async () => false, log)).toBe(false);
  expect(calls).toBe(0);
  expect(await routingCheck(f.config, async () => true, log)).toBe(false);
  expect(calls).toBe(0);
  f.config.policy.budget.requestUsd = 1; f.config.policy.budget.dailyUsd = 5;
  expect(await routingCheck(f.config, async () => true, log)).toBe(true);
  expect(calls).toBe(1);
  expect(JSON.stringify(log.mock.calls)).not.toContain('routing-test-key');
});

it('model checks distinguish missing models, invalid credentials, and an unavailable server', async () => {
  const f = await local();
  f.config.models.capable.id = 'missing';
  expect(await modelStatus(f.config, 'normal')).toContain('not installed');
  const denied = await mockServer((_body, _req, res) => { res.writeHead(401); res.end('{}'); }); cleanup.push(denied.close);
  f.config.models.capable.baseUrl = denied.url;
  expect(await modelStatus(f.config, 'normal')).toContain('401');
  f.config.models.capable.baseUrl = 'http://127.0.0.1:1/v1';
  expect(await modelStatus(f.config, 'normal')).toContain('unreachable');
});

it('setup saves private config, reruns preserve it, and environment overrides remain effective', async () => {
  const f = await local();
  vi.stubEnv('TEAPILOT_STATE_DIR', f.config.stateDir);
  vi.stubEnv('LOCAL_API_KEY', 'private-test-key');
  const messages: string[] = [];
  const ui: SetupUI = { log: text => messages.push(text), input: async () => { throw new Error('Unexpected input'); }, choose: async () => 0, confirm: async () => false };
  const directory = join(f.cwd, 'personal');
  const options = { directory, nonInteractive: true, endpoint: `${f.server.url}/v1`, model: 'local-test', contextTokens: 16384 };
  expect(await setup(options, ui, new AbortController().signal)).toBe(false);
  const content = await readFile(join(directory, '.env'), 'utf8');
  const config = await loadConfig(directory, {});
  expect(config.routingMode).toBe('direct');
  expect(config.models.fast.enabled).toBe(false);
  expect(config.secrets.capable).toBe('private-test-key');
  expect(messages.join('\n')).not.toContain('private-test-key');
  await expect(setup(options, ui, new AbortController().signal)).rejects.toThrow('already exists');
  expect(await setup({ directory }, ui, new AbortController().signal)).toBe(false);
  expect(await readFile(join(directory, '.env'), 'utf8')).toBe(content);
  expect((await loadConfig(directory, { CAPABLE_MODEL: 'override' })).models.capable.id).toBe('override');
  expect((await loadConfig(directory, { CAPABLE_MODEL: 'override' })).source).toMatchObject({ directory, overrides: expect.arrayContaining(['CAPABLE_MODEL']) });
  expect(messages.join('\n')).toContain(`--config-dir "${directory}"`);
});

it('recognizes interrupted first setup without mislabeling retained generations', async () => {
  const f = await local();
  vi.stubEnv('TEAPILOT_STATE_DIR', f.config.stateDir);
  const directory = join(f.cwd, 'interrupted');
  await mkdir(directory);
  await writeFile(join(directory, 'models-incomplete.json'), '{}');
  const messages: string[] = [];
  const ui: SetupUI = { log: text => messages.push(text), input: async () => '', choose: async () => 0, confirm: async () => false };
  expect(await setup({ directory, nonInteractive: true, endpoint: `${f.server.url}/v1`, model: 'local-test', contextTokens: 16384 }, ui, new AbortController().signal)).toBe(false);
  expect(messages.join('\n')).toContain('interrupted before activation');
  messages.length = 0;
  await setup({ directory }, ui, new AbortController().signal);
  expect(messages.join('\n')).not.toContain('interrupted before activation');
});

it('blank optional search still saves a verified interactive setup', async () => {
  const f = await local();
  vi.stubEnv('TEAPILOT_STATE_DIR', f.config.stateDir);
  const messages: string[] = [];
  const ui: SetupUI = {
    log: text => messages.push(text),
    choose: async message => message === 'Execution model' || message.startsWith('Web search') ? 1 : 0,
    input: async () => '',
    confirm: async message => message.startsWith('Save these settings'),
  };
  const directory = join(f.cwd, 'interactive');
  expect(await setup({ directory, endpoint: `${f.server.url}/v1`, model: 'local-test', contextTokens: 16384 }, ui, new AbortController().signal)).toBe(false);
  expect((await loadConfig(directory, {})).models.capable.id).toBe('local-test');
  expect(messages.join('\n')).toContain('Ready to save');
  expect(messages.join('\n')).toContain('Configuration saved');
});

it('config lookup chooses explicit, then repository, then personal settings', async () => {
  const f = await local();
  const personal = join(f.cwd, 'personal'), repository = join(f.cwd, 'repo');
  await mkdir(repository);
  expect(await configDirectory(undefined, repository, personal)).toBe(personal);
  await writeFile(join(repository, '.env'), 'DATABASE_URL=unrelated');
  expect(await configDirectory(undefined, repository, personal)).toBe(personal);
  await writeFile(join(repository, '.env'), 'TEAPILOT_ROUTING_MODE=direct');
  expect(await configDirectory(undefined, repository, personal)).toBe(repository);
  expect(await configDirectory(personal, repository, personal)).toBe(personal);
});

it('configuration commits replace complete generations and cancelled saves retain the old profile', async () => {
  const f = await local();
  const directory = join(f.cwd, 'config');
  const env = { LOCAL_API_KEY: 'private-key' };
  await saveConfiguration(directory, f.config, env, new AbortController().signal);
  const before = await readFile(join(directory, '.env'), 'utf8');
  const cancelled = new AbortController(); cancelled.abort();
  f.config.models.capable.id = 'replacement';
  await expect(saveConfiguration(directory, f.config, env, cancelled.signal)).rejects.toThrow();
  expect(await readFile(join(directory, '.env'), 'utf8')).toBe(before);
  await saveConfiguration(directory, f.config, env, new AbortController().signal);
  expect((await loadConfig(directory, {})).models.capable.id).toBe('replacement');
  expect((await loadConfig(directory, {})).secrets.capable).toBe('private-key');
});

it('downloads reject insufficient space and interrupted progress, and can resume on retry', async () => {
  expect(() => checkDisk(10, 11)).toThrow('Insufficient disk');
  let calls = 0;
  const server = await mockServer((_body, _req, res) => {
    calls++;
    res.end(calls === 1 ? '{"status":"downloading","total":100,"completed":50}\n' : '{"status":"success"}\n');
  }); cleanup.push(server.close);
  const progress = vi.fn();
  await expect(streamOperation('/api/pull', {}, new AbortController().signal, progress, server.url)).rejects.toThrow('interrupted');
  await streamOperation('/api/pull', {}, new AbortController().signal, progress, server.url);
  expect(progress).toHaveBeenCalledWith('success');
  const cancelled = new AbortController(); cancelled.abort();
  await expect(streamOperation('/api/pull', {}, cancelled.signal, progress, server.url)).rejects.toThrow();
});
