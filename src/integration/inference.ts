import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { z } from 'zod';
import { normalizeContext, Type, type Message } from '@earendil-works/pi-ai';
import { defaultPolicy, JevRouter, validateManifest } from 'jevrouter';
import { tiers, type Config, type Tier } from '../config.js';
import { budgetedJev, guardedStream, piModel, type InferenceState } from '../inference/providers.js';
import { callCeiling, lockState, SpendGovernor } from '../inference/budget.js';
import { assessCandidate } from '../routing/selection.js';
import { Telemetry } from '../telemetry/outcome.js';
import type { HostDependencies } from '../host.js';
import { StreamRedactor } from './events.js';

const text = z.object({ type: z.literal('text'), text: z.string() }).strict();
const call = z.object({ type: z.literal('toolCall'), id: z.string().min(1), name: z.string().min(1), arguments: z.record(z.string(), z.json()) }).strict();
const result = z.object({ type: z.literal('toolResult'), id: z.string().min(1), text: z.string(), isError: z.boolean().optional() }).strict();
export const inferenceSchema = z.object({
  model: z.enum(['auto', ...tiers]),
  messages: z.array(z.object({ role: z.enum(['user', 'assistant']), content: z.array(z.discriminatedUnion('type', [text, call, result])).max(1000) }).strict()).max(1000),
  tools: z.array(z.object({ name: z.string().min(1).max(256), description: z.string().max(50_000), parameters: z.record(z.string(), z.unknown()) }).strict()).max(256).default([]),
  toolMode: z.enum(['auto', 'required', 'none']).default('auto'),
}).strict();
export type InferenceRequest = z.infer<typeof inferenceSchema>;
export const emptyUsage = () => ({ input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } });

export function modelInformation(config: Config) {
  const available = tiers.filter(tier => config.models[tier].enabled && !config.policy.disabledCapabilities.includes(`inference.${tier}`) && (tier === 'local' || config.secrets[tier]));
  if (!config.policy.permissions.includes('inference')) return [];
  const fixed = available.map(tier => ({ id: tier, name: `TeaPilot ${tier[0]!.toUpperCase()}${tier.slice(1)} · ${config.models[tier].id}`, family: 'teapilot', version: '1',
    maxInputTokens: config.models[tier].contextTokens - config.models[tier].maxOutputTokens - 2048, maxOutputTokens: config.models[tier].maxOutputTokens,
    capabilities: { toolCalling: config.models[tier].toolCalling, imageInput: false },
    detail: `${tier === 'local' ? 'Local' : 'Paid'} · $${config.policy.budget.requestUsd}/call · $${config.policy.budget.dailyUsd}/UTC day`,
  }));
  return fixed.length ? [{ ...fixed[0]!, id: 'auto', name: 'TeaPilot Auto', maxInputTokens: Math.max(...fixed.map(m => m.maxInputTokens)), maxOutputTokens: Math.min(...fixed.map(m => m.maxOutputTokens)), capabilities: { toolCalling: fixed.some(m => m.capabilities.toolCalling), imageInput: false } }, ...fixed] : [];
}

export function inferenceContext(request: InferenceRequest, config: Config, tier: Tier) {
  const names = new Map<string, string>();
  const messages: Message[] = [];
  for (const message of request.messages) {
    let content: typeof message.content = [];
    const flush = () => {
      if (!content.length) return;
      if (message.role === 'assistant') {
        if (content.some(part => part.type === 'toolResult')) throw new Error('Tool results must use the user role');
        messages.push({ role: 'assistant', content: content as ({ type: 'text'; text: string } | z.infer<typeof call>)[], api: 'openai-completions', provider: config.models[tier].provider, model: config.models[tier].id, timestamp: Date.now(), usage: emptyUsage(), stopReason: content.some(p => p.type === 'toolCall') ? 'toolUse' : 'stop' });
      } else {
        if (content.some(part => part.type !== 'text')) throw new Error('Tool calls must use the assistant role');
        messages.push({ role: 'user', content: content as z.infer<typeof text>[], timestamp: Date.now() });
      }
      content = [];
    };
    for (const part of message.content) {
      if (part.type === 'toolResult') {
        flush();
        if (message.role !== 'user' || !names.has(part.id)) throw new Error('Unmatched tool result');
        messages.push({ role: 'toolResult', toolCallId: part.id, toolName: names.get(part.id)!, content: [{ type: 'text', text: part.text }], isError: part.isError ?? false, timestamp: Date.now() });
      } else {
        if (part.type === 'toolCall') names.set(part.id, part.name);
        content.push(part);
      }
    }
    flush();
  }
  return normalizeContext({ messages, tools: request.tools.map(tool => ({ ...tool, parameters: Type.Unsafe(tool.parameters) })) });
}

export async function runInference(config: Config, request: InferenceRequest, dependencies: HostDependencies, signal?: AbortSignal) {
  request = inferenceSchema.parse(request);
  if (request.toolMode === 'required' && !request.tools.length) throw new Error('Required tool mode needs tools');
  const unlock = await lockState(config.stateDir);
  const requestId = randomUUID();
  const secrets = [config.router.apiKey ?? '', ...Object.values(config.secrets).map(s => s ?? '')];
  const telemetry = new Telemetry(config.stateDir, requestId, secrets, dependencies.onEvent);
  const budget = new SpendGovernor(join(config.stateDir, 'spend.jsonl'), requestId, config.policy.budget);
  const receipts: string[] = [];
  const tried = new Set<Tier>();
  let emitted = false;
  try {
    await budget.load();
    const advertised = modelInformation(config).find(m => m.id === request.model);
    if (!advertised) throw new Error('Model is disabled or lacks credentials. Open TeaPilot: Manage Models.');
    for (let attempt = 0; attempt <= config.policy.escalation.maxEscalations; attempt++) {
      signal?.throwIfAborted();
      const routingCost = request.model === 'auto' && config.routingMode !== 'direct' ? config.router.maxCallUsd : 0;
      const candidates = tiers.map(tier => {
        const spec = config.models[tier];
        const size = Buffer.byteLength(JSON.stringify(inferenceContext(request, config, tier))) + 4096;
        const available = spec.enabled && !config.policy.disabledCapabilities.includes(`inference.${tier}`) && !tried.has(tier)
          && (request.model === 'auto' || request.model === tier) && (tier === 'local' || Boolean(config.secrets[tier]))
          && (!request.tools.length || spec.toolCalling) && size <= spec.contextTokens - spec.maxOutputTokens
          && budget.permits(callCeiling(spec) + routingCost);
        return validateManifest({ id: `inference.${tier}`, name: spec.id, type: 'subagent', description: `Supply ${tier} text inference${spec.toolCalling ? ' and tool calls' : ''}; caller executes tools.`, verification: { status: 'verified', source: 'teapilot:built-in' }, permissions: ['inference'], risk: { level: 'low', categories: [] }, availability: { available }, policy: { requires_confirmation: tier !== 'local' && (callCeiling(spec) >= config.policy.budget.approvalThresholdUsd || tier === 'strong' && config.policy.budget.strongRequiresApproval) }, execution: { mode: 'subagent', target: 'inference' }, metadata: { model: spec.id, tier, context_tokens: spec.contextTokens } });
      });
      let chosen = candidates.find(candidate => assessCandidate(config, candidate).allowed);
      let routeConfirmation = false;
      if (!chosen) throw new Error('No enabled model fits this context, tool requirements, and remaining budget.');
      if (routingCost) {
        const router = new JevRouter(budgetedJev(config, budget, telemetry, dependencies.provider), { ...defaultPolicy, ...config.policy.router, single_stage_max_candidates: 32, allow_unavailable_fallback: false });
        const decision = await router.route({ request: JSON.stringify(request.messages.slice(-1)).slice(0, 4000), context: { preference: 'Prefer the cheapest suitable tier. Caller owns tool execution.', input_bytes: Buffer.byteLength(JSON.stringify(request)), tool_count: request.tools.length }, actor_permissions: config.policy.permissions }, candidates);
        receipts.push(await telemetry.receipt(decision));
        chosen = candidates.find(c => c.id === decision.decision.selected);
        const assessment = decision.decision.candidates.find(c => c.id === chosen?.id);
        if (!chosen || !assessCandidate(config, chosen).allowed || !assessment?.router.allowed || assessment.router.filtered || decision.status === 'no_decision') throw new Error('Routing did not authorize inference');
        routeConfirmation = decision.status === 'needs_confirmation' || Boolean(assessment.router.requires_confirmation);
      }
      const tier = chosen.id.split('.')[1] as Tier;
      tried.add(tier);
      signal?.throwIfAborted();
      if (assessCandidate(config, chosen).confirmation || routeConfirmation) {
        if (!await dependencies.approve({ kind: 'route', summary: `Use ${config.models[tier].id}?`, details: `Maximum inference charge: $${callCeiling(config.models[tier]).toFixed(6)}. Budget: $${config.policy.budget.requestUsd}/call; $${config.policy.budget.dailyUsd}/UTC day.`, signal })) throw new Error('Inference approval denied');
      }
      await telemetry.event('model_selection', { model: config.models[tier].id, tier, attempt: attempt + 1 });
      const state: InferenceState = { turns: 0 };
      const stream = await guardedStream(config, tier, budget, telemetry, state, { toolChoice: request.toolMode, maxOutputTokens: advertised.maxOutputTokens })(piModel(config.models[tier]), inferenceContext(request, config, tier), { signal });
      const redactor = new StreamRedactor(secrets);
      for await (const event of stream) {
        if (event.type === 'text_delta') {
          emitted ||= Boolean(event.delta);
          const delta = redactor.push(event.delta); if (delta) dependencies.onEvent?.({ type: 'text', text: delta });
        } else if (event.type === 'toolcall_start' || event.type === 'toolcall_delta') {
          emitted = true;
        } else if (event.type === 'toolcall_end') {
          emitted = true; dependencies.onEvent?.({ type: 'tool_call', id: event.toolCall.id, name: event.toolCall.name, arguments: JSON.parse(telemetry.redact(JSON.stringify(event.toolCall.arguments))) });
        }
      }
      const tail = redactor.push('', true); if (tail) dependencies.onEvent?.({ type: 'text', text: tail });
      const final = await stream.result();
      signal?.throwIfAborted();
      if (state.stop || ['error', 'aborted', 'pending'].includes(final.stopReason)) {
        if (request.model === 'auto' && !emitted && ['unsupported', 'provider_error'].includes(state.stop ?? '') && attempt < config.policy.escalation.maxEscalations) continue;
        throw new Error(`Inference stopped (${state.stop ?? final.stopReason}); partial responses are never replayed.`);
      }
      if (request.toolMode === 'required' && !final.content.some(p => p.type === 'toolCall')) throw new Error('Model did not honor required tool mode');
      const result = { requestId, status: final.stopReason === 'length' ? 'length' : 'completed', model: config.models[tier].id, tier, spentUsd: budget.spent().request, receipts };
      await telemetry.event('request_end', result);
      return result;
    }
    throw new Error('Inference escalation limit reached');
  } catch (error) {
    await telemetry.event('request_end', { requestId, status: signal?.aborted ? 'cancelled' : 'error', spentUsd: budget.spent().request });
    throw error;
  } finally { await unlock(); }
}
