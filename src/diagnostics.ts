import { during, type ActivityUI } from './activity.js';
import { Agent, type AgentTool } from '@earendil-works/pi-agent-core';
import { Type } from '@earendil-works/pi-ai';
import { randomUUID } from 'node:crypto';
import { access, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Config, Tier } from './config.js';
import { tiers } from './config.js';
import { runAttempt } from './agents/run.js';
import { SpendGovernor, lockState } from './inference/budget.js';
import { budgetedJev, guardedStream, piModel } from './inference/providers.js';
import { Telemetry } from './telemetry/outcome.js';
import { defaultPolicy, JevRouter } from 'jevrouter';
import { capabilities } from './routing/capabilities.js';
import { effectiveProfile, modelFor, profileFor } from './routing/execution.js';

export async function endpointHint(config: Config, tier: Tier, log: (text: string) => void, signal?: AbortSignal): Promise<void> {
  try {
    const response = await fetch('http://127.0.0.1:11434/api/version', { redirect: 'error', signal: AbortSignal.any([signal ?? new AbortController().signal, AbortSignal.timeout(1500)]) });
    if (response.ok) log(`Ollama detected at http://127.0.0.1:11434; configured endpoint: ${modelFor(config, tier).baseUrl}. To choose installed models, run teapilot setup${config.source ? ` --config-dir "${config.source.directory}"` : ''} and select Reconfigure, then Local Ollama. No endpoint was changed.`);
  } catch { signal?.throwIfAborted(); }
}

export async function routingCheck(config: Config, consent: (message: string) => Promise<boolean>, log: (text: string) => void, signal?: AbortSignal): Promise<boolean> {
  if (!config.router.apiKey) { log('Hosted routing: FAIL (missing key). Run teapilot setup to configure routing.'); return false; }
  if (!await consent(`Verify hosted routing with one paid routing call (maximum $${config.router.maxCallUsd}, within request/day budgets)? No execution model will be called.`)) {
    log('Hosted routing: NOT TESTED (paid check declined).'); return false;
  }
  signal?.throwIfAborted();
  const unlock = await lockState(config.stateDir);
  try {
    const id = randomUUID();
    const budget = new SpendGovernor(join(config.stateDir, 'spend.jsonl'), id, config.policy.budget);
    await budget.load();
    const telemetry = new Telemetry(config.stateDir, id, [config.router.apiKey]);
    const router = new JevRouter(budgetedJev(config, budget, telemetry), { ...defaultPolicy, ...config.policy.router, single_stage_max_candidates: 32 });
    const decision = await router.route({ request: 'Explain dependency injection. Diagnostic routing only; do not execute.', actor_permissions: config.policy.permissions }, capabilities(config, budget, true));
    await telemetry.receipt(decision);
    signal?.throwIfAborted();
    const passed = Boolean(decision.decision.selected && decision.status !== 'no_decision');
    log(`Hosted routing: ${passed ? 'PASS' : 'FAIL (no authorized route)'}; accounted $${budget.spent().request.toFixed(6)}. Execution readiness is checked separately.`);
    return passed;
  } catch {
    signal?.throwIfAborted();
    log('Hosted routing: FAIL. Check routing credentials, provider settings, and remaining budget; rerun teapilot doctor --live.');
    return false;
  } finally { await unlock(); }
}

export async function modelStatus(config: Config, tier: Tier, signal?: AbortSignal): Promise<string | undefined> {
  const model = modelFor(config, tier); const secret = config.secrets[profileFor(tier).model];
  try {
    const response = await fetch(`${model.baseUrl.replace(/\/$/, '')}/models`, {
      headers: secret ? { Authorization: `Bearer ${secret}` } : {},
      signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(5000)]) : AbortSignal.timeout(5000), redirect: 'error',
    });
    if (!response.ok) return `Model listing returned HTTP ${response.status}; check the endpoint and credential.`;
    const body = await response.json() as { data?: Array<{ id?: string }> };
    if (!Array.isArray(body.data)) return 'Endpoint did not return an OpenAI-compatible model list.';
    if (!body.data.some(item => item.id === model.id)) return 'Selected model is not installed/available; rerun teapilot setup.';
    return undefined;
  } catch {
    signal?.throwIfAborted();
    return 'Endpoint is unreachable; start the model server and check its URL.';
  }
}

export interface LiveReport { ask: boolean; tools: boolean; coding: boolean; spentUsd: number }

// Uses the production metered streaming adapter and real pi file tools. The probe
// never executes generated code; coding file tools are confined to its disposable directory.
export async function liveCheck(config: Config, tier: Tier, signal?: AbortSignal, progress: (text: string) => void = () => {}): Promise<LiveReport> {
  if (!config.policy.permissions.includes('inference')) throw new Error('Live inference is disabled by the configured permission policy.');
  const unlock = await lockState(config.stateDir);
  let scratch: string | undefined;
  const report: LiveReport = { ask: false, tools: false, coding: false, spentUsd: 0 };
  try {
    scratch = await mkdtemp(join(tmpdir(), 'teapilot-probe-'));
    const requestId = randomUUID();
    const budget = new SpendGovernor(join(config.stateDir, 'spend.jsonl'), requestId, config.policy.budget);
    await budget.load();
    const telemetry = new Telemetry(config.stateDir, requestId, [config.router.apiKey, ...Object.values(config.secrets)].filter((v): v is string => Boolean(v)));
    const probeConfig = structuredClone(config);
    modelFor(probeConfig, tier).temperature = 0;
    probeConfig.policy.limits.maxTurns = Math.min(6, config.policy.limits.maxTurns);
    async function run(prompt: string, tools: AgentTool[] = []): Promise<{ text: string; ok: boolean }> {
      const state = { turns: 0 };
      const agent = new Agent({
        initialState: { model: piModel(modelFor(probeConfig, tier), effectiveProfile(probeConfig, tier)), systemPrompt: 'Follow the diagnostic task exactly. Use only the provided tools. Do not use markdown in the final answer. Align with the user's tone and formality.', tools, thinkingLevel: profileFor(tier).thinking },
        streamFn: guardedStream(probeConfig, tier, budget, telemetry, state), toolExecution: 'sequential',
      });
      const abort = () => agent.abort();
      const timer = setTimeout(abort, config.policy.limits.attemptTimeoutMs);
      signal?.addEventListener('abort', abort, { once: true });
      try { signal?.throwIfAborted(); await agent.prompt(`${prompt}\n/no_think`); }
      finally { clearTimeout(timer); signal?.removeEventListener('abort', abort); }
      signal?.throwIfAborted();
      const last = agent.state.messages.findLast(message => message.role === 'assistant');
      return { ok: last?.role === 'assistant' && last.stopReason === 'stop', text: last?.role === 'assistant' ? last.content.filter(part => part.type === 'text').map(part => part.text).join('') : '' };
    }
    progress('Checking streamed answers...');
    const answer = await run('Reply with exactly TEAPILOT_OK.');
    report.ask = answer.ok && answer.text.includes('TEAPILOT_OK');
    if (report.ask && modelFor(config, tier).toolCalling) {
      progress('Checking tool calls and continuation...');
      const token = randomUUID();
      let called = false;
      const tool: AgentTool = {
        name: 'teapilot_probe', label: 'Diagnostic', description: 'Return the diagnostic token.', parameters: Type.Object({}),
        execute: async () => { called = true; return { content: [{ type: 'text', text: token }], details: {} }; },
      };
      const result = await run('Call teapilot_probe, then reply with the exact token returned by the tool.', [tool]);
      report.tools = called && result.ok && result.text.includes(token);
      if (!report.tools) progress(`Tool check failed: executed=${called}, completed=${result.ok}, returned token=${result.text.includes(token)}. Try another model or update Ollama.`);
      if (report.tools) {
        progress('Checking a disposable coding task...');
        const nonce = randomUUID();
        const before = `// ${nonce}\nexport const add = (a, b) => a - b;\n`;
        const expected = before.replace('a - b', 'a + b');
        await writeFile(join(scratch, 'fixture.js'), before);
        probeConfig.policy.permissions = probeConfig.policy.permissions.filter(permission => ['inference', 'repository.read', 'repository.write'].includes(permission));
        const result = await runAttempt({ config: probeConfig, tier, workload: 'coder', cwd: scratch,
          prompt: 'Read fixture.js. Change only the subtraction operator to addition, preserving every other character including the comment and final newline. Write fixture.js, then reply DONE. Do not call any shell. /no_think',
          web: false, budget, telemetry, approve: async () => false, signal });
        signal?.throwIfAborted();
        report.coding = result.success && result.toolCalls >= 2 && await readFile(join(scratch, 'fixture.js'), 'utf8') === expected;
        if (!report.coding) progress(`Coding check failed: ${result.stopped ?? result.reason ?? 'file edit did not match the fixture'}; ${result.toolCalls} tool calls. Check context capacity or choose another model.`);
      }
    }
    report.spentUsd = budget.spent().request;
    await telemetry.event('diagnostic', { tier, ...report });
    return report;
  } finally {
    try { if (scratch) await rm(scratch, { recursive: true, force: true }); }
    finally { await unlock(); }
  }
}

export async function doctor(config: Config, cwd: string, options: ActivityUI & { live?: boolean; signal?: AbortSignal; consent: (message: string) => Promise<boolean>; log: (text: string) => void }): Promise<boolean> {
  const { log } = options;
  let healthy = true;
  if (config.source) {
    log(`Configuration: ${config.source.directory} (${config.source.reason})`);
    if (config.source.overrides.length) log(`Environment overrides (names only): ${config.source.overrides.join(', ')}`);
  }
  log(`Repository: ${cwd} (--cwd; independent of configuration)`);
  if (!options.live) log('Basic check: endpoint metadata only. Answers, tool use, and coding: NOT TESTED in this check.');
  log(`Routing: ${config.routingMode ?? 'hosted'}`);
  if (config.routingMode !== 'direct') {
    log(`Hosted routing credential: ${config.router.apiKey ? 'configured (not live-tested)' : 'MISSING; run teapilot setup'}`);
    healthy &&= Boolean(config.router.apiKey);
    if (options.live) healthy = await during(options, 'Verifying hosted routing...', () => routingCheck(config, options.consent, log, options.signal)) && healthy;
  }
  try {
    await access(cwd);
    await mkdir(config.stateDir, { recursive: true, mode: 0o700 });
    const probe = await mkdtemp(join(config.stateDir, '.doctor-'));
    await rm(probe, { recursive: true });
    log('Workspace and state directory: accessible');
  } catch { log('Workspace or state directory is inaccessible; check paths and permissions.'); healthy = false; }
  let available = false;
  for (const tier of tiers) {
    const model = modelFor(config, tier);
    if (!model.enabled) continue;
    const error = await during(options, `Checking ${tier} endpoint...`, () => modelStatus(config, tier, options.signal));
    log(`${tier}: ${model.id}; endpoint ${model.baseUrl}: ${error ? `FAIL: ${error}` : 'PASS (model found; live inference checked separately)'}`);
    if (config.policy.disabledCapabilities.includes(`coder.${tier}`)) log(`${tier}: coding is disabled by configuration; rerun setup to reconfigure and validate it.`);
    if (error) { healthy = false; await during(options, 'Checking local endpoint...', () => endpointHint(config, tier, log, options.signal)); continue; }
    available = true;
    if (options.live) {
      if (!await options.consent(`Run local ${tier} diagnostic calls within the configured request/day limits?`)) { log(`${tier}: live check declined`); healthy = false; continue; }
      const result = await during(options, `Verifying ${tier} answers and coding...`, () => liveCheck(config, tier, options.signal, log));
      log(`${tier}: answers ${result.ask ? 'PASS' : 'FAIL'}; tools ${result.tools ? 'PASS' : 'unverified'}; coding ${result.coding ? 'PASS' : 'unverified'}; accounted $${result.spentUsd.toFixed(6)}`);
      healthy &&= result.ask && (!model.toolCalling || result.coding);
    }
  }
  log(`Budgets: $${config.policy.budget.requestUsd}/request; $${config.policy.budget.dailyUsd}/UTC day`);
  if (!options.live) log('Run teapilot doctor --live to verify streamed inference and coding.');
  return healthy && available;
}
