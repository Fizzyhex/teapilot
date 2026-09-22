import { Agent, type AgentTool } from '@earendil-works/pi-agent-core';
import { Type } from '@earendil-works/pi-ai';
import { createReadTool, createWriteTool } from '@earendil-works/pi-coding-agent';
import { randomUUID } from 'node:crypto';
import { access, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Config, Tier } from './config.js';
import { tiers } from './config.js';
import { ExecutionPolicy } from './execution/policy.js';
import { SpendGovernor, lockState } from './inference/budget.js';
import { guardedStream, piModel } from './inference/providers.js';
import { Telemetry } from './telemetry/outcome.js';

export async function modelStatus(config: Config, tier: Tier, signal?: AbortSignal): Promise<string | undefined> {
  const model = config.models[tier];
  try {
    const response = await fetch(`${model.baseUrl.replace(/\/$/, '')}/models`, {
      headers: config.secrets[tier] ? { Authorization: `Bearer ${config.secrets[tier]}` } : {},
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
// never executes generated code and can only read/write its disposable fixture.
export async function liveCheck(config: Config, tier: Tier, signal?: AbortSignal, progress: (text: string) => void = () => {}): Promise<LiveReport> {
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
    probeConfig.policy.limits.maxTurns = Math.min(6, config.policy.limits.maxTurns);
    async function run(prompt: string, tools: AgentTool[] = []): Promise<{ text: string; ok: boolean }> {
      const state = { turns: 0 };
      const agent = new Agent({
        initialState: { model: piModel(probeConfig.models[tier]), systemPrompt: 'Follow the diagnostic task exactly. Use only the provided tools. Do not use markdown in the final answer. /no_think', tools, thinkingLevel: 'off' },
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
    if (report.ask && config.models[tier].toolCalling) {
      progress('Checking tool calls and continuation...');
      const token = randomUUID();
      let called = false;
      const tool: AgentTool = {
        name: 'teapilot_probe', label: 'Diagnostic', description: 'Return the diagnostic token.', parameters: Type.Object({}),
        execute: async () => { called = true; return { content: [{ type: 'text', text: token }], details: {} }; },
      };
      const result = await run('Call teapilot_probe, then reply with the exact token returned by the tool.', [tool]);
      report.tools = called && result.ok && result.text.includes(token);
      if (report.tools) {
        progress('Checking a disposable coding task...');
        const nonce = randomUUID();
        const before = `// ${nonce}\nexport const add = (a, b) => a - b;\n`;
        const expected = before.replace('a - b', 'a + b');
        await writeFile(join(scratch, 'fixture.js'), before);
        const policy = new ExecutionPolicy(scratch, probeConfig, async () => false);
        const seen = new Set<string>();
        const tools = [createReadTool(scratch, { operations: { readFile, access, detectImageMimeType: async () => null } }), createWriteTool(scratch)].map(raw => {
          const wrapped = policy.wrap(raw);
          return { ...wrapped, execute: async (...args: Parameters<AgentTool['execute']>) => {
            if ((args[1] as { path?: string }).path !== 'fixture.js') throw new Error('Diagnostic only allows fixture.js');
            const value = await wrapped.execute(...args); seen.add(raw.name); return value;
          } };
        });
        const result = await run('Read fixture.js. Change only the subtraction operator to addition, preserving every other character including the comment and final newline. Write fixture.js, then reply DONE. Do not call any shell.', tools);
        report.coding = result.ok && seen.has('read') && seen.has('write') && await readFile(join(scratch, 'fixture.js'), 'utf8') === expected;
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

export async function doctor(config: Config, cwd: string, options: { live?: boolean; signal?: AbortSignal; consent: (message: string) => Promise<boolean>; log: (text: string) => void }): Promise<boolean> {
  const { log } = options;
  let healthy = true;
  log(`Routing: ${config.routingMode ?? 'hosted'}`);
  if (config.routingMode !== 'direct') {
    log(`Hosted routing credential: ${config.router.apiKey ? 'configured (not live-tested)' : 'MISSING; run teapilot setup'}`);
    healthy &&= Boolean(config.router.apiKey);
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
    const model = config.models[tier];
    if (!model.enabled) continue;
    const error = tier !== 'local' && !config.secrets[tier] ? 'Missing credential; run teapilot setup.' : await modelStatus(config, tier, options.signal);
    log(`${tier}: ${model.id}: ${error ?? 'model found (inference not yet tested)'}`);
    if (error) { healthy = false; continue; }
    available = true;
    if (options.live) {
      if (tier !== 'local' && !await options.consent(`Run paid ${tier} diagnostic calls within $${config.policy.budget.requestUsd}/request and $${config.policy.budget.dailyUsd}/day limits?`)) {
        log(`${tier}: live check declined`); healthy = false; continue;
      }
      const result = await liveCheck(config, tier, options.signal, log);
      log(`${tier}: answers ${result.ask ? 'PASS' : 'FAIL'}; tools ${result.tools ? 'PASS' : 'unverified'}; coding ${result.coding ? 'PASS' : 'unverified'}; accounted $${result.spentUsd.toFixed(6)}`);
      healthy &&= result.ask && (!model.toolCalling || result.coding);
    }
  }
  log(`Budgets: $${config.policy.budget.requestUsd}/request; $${config.policy.budget.dailyUsd}/UTC day`);
  if (!options.live) log('Run teapilot doctor --live to verify streamed inference and coding.');
  return healthy && available;
}
