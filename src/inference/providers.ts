import { type AssistantMessage, type Model } from '@earendil-works/pi-ai';
import { AssistantMessageEventStream } from '@earendil-works/pi-ai/utils/event-stream';
import { stream as openAIStream } from '@earendil-works/pi-ai/api/openai-completions';
import type { StreamFn } from '@earendil-works/pi-agent-core';
import { createSdkProvider, type JevProvider } from 'jevrouter';
import type { Config, ModelConfig, Tier, PhysicalModel } from '../config.js';
import { effectiveProfile, modelFor, profileFor, type ExecutionProfile } from '../routing/execution.js';
import { BudgetError, callCeiling, type SpendGovernor } from './budget.js';
import type { Telemetry } from '../telemetry/outcome.js';
import { estimateInputTokens, MAX_PAYLOAD_BYTES } from './context.js';

export function piModel(config: ModelConfig, profile?: ExecutionProfile): Model<'openai-completions'> {
  return {
    id: config.id, name: config.id, api: 'openai-completions', provider: config.provider,
    baseUrl: config.baseUrl, reasoning: false, input: ['text'],
    contextWindow: config.contextTokens, maxTokens: profile?.maxOutputTokens ?? config.maxOutputTokens,
    cost: { input: config.inputUsdPerMillion, output: config.outputUsdPerMillion, cacheRead: config.inputUsdPerMillion, cacheWrite: config.inputUsdPerMillion },
    compat: { supportsDeveloperRole: config.supportsDeveloperRole, supportsUsageInStreaming: config.supportsUsage, maxTokensField: 'max_tokens' },
  };
}

export async function localAvailable(config: Config, physical?: PhysicalModel): Promise<boolean> {
  const selected = physical ? config.models[physical] : config.models.fast.enabled ? config.models.fast : config.models.capable;
  if (!selected.enabled) return false;
  try {
    const secret = config.secrets[selected.apiKeyEnv === config.models.fast.apiKeyEnv ? 'fast' : 'capable'];
    const response = await fetch(`${selected.baseUrl.replace(/\/$/, '')}/models`, {
      headers: secret ? { Authorization: `Bearer ${secret}` } : {},
      signal: AbortSignal.timeout(3000), redirect: 'error',
    });
    return response.ok;
  } catch { return false; }
}

/** Probe native reasoning metadata without guessing from a model name. */
export async function discoverNativeReasoning(config: Config, physical: PhysicalModel, signal?: AbortSignal): Promise<readonly ('off' | 'medium' | 'xhigh')[]> {
  const model = config.models[physical];
  if (!model.enabled) return [];
  const base = model.baseUrl.replace(/\/v1\/?$/, '');
  try {
    const response = await fetch(`${base}/api/show`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ model: model.id }), signal: AbortSignal.any([signal ?? new AbortController().signal, AbortSignal.timeout(5000)]), redirect: 'error' });
    if (!response.ok) return model.reasoningEfforts;
    const body = await response.json() as { thinking?: { values?: unknown[]; default?: unknown } };
    const values = body.thinking?.values;
    if (!Array.isArray(values)) return model.reasoningEfforts;
    const discovered = values.flatMap(value => {
      if (value === false || value === 'none' || value === 'off') return ['off' as const];
      if (value === 'medium') return ['medium' as const];
      if (value === 'xhigh') return ['xhigh' as const];
      return [];
    });
    if (discovered.length) model.reasoningEfforts = [...new Set(discovered)];
    return model.reasoningEfforts;
  } catch { signal?.throwIfAborted(); return model.reasoningEfforts; }
}

// The SDK does not accept a signal. Custom providers may opt in; racing also
// releases the host promptly for SDK calls without touching their late results.
export interface CancellableJevProvider extends JevProvider {
  decide(request: Parameters<JevProvider['decide']>[0], signal?: AbortSignal): ReturnType<JevProvider['decide']>;
}

async function decideUntilCancelled(provider: CancellableJevProvider, request: Parameters<JevProvider['decide']>[0], signal?: AbortSignal) {
  signal?.throwIfAborted();
  let cancel: (() => void) | undefined;
  try {
    return await new Promise<Awaited<ReturnType<JevProvider['decide']>>>((resolve, reject) => {
      cancel = () => reject(signal!.reason);
      signal?.addEventListener('abort', cancel, { once: true });
      provider.decide(request, signal).then(resolve, reject);
    });
  } finally {
    if (cancel) signal?.removeEventListener('abort', cancel);
  }
}

export function budgetedJev(config: Config, governor: SpendGovernor, telemetry: Telemetry, provider?: CancellableJevProvider, signal?: AbortSignal): JevProvider {
  const inner = provider ?? createSdkProvider({ ...config.router, cache: false });
  return {
    name: inner.name,
    async decide(request) {
      signal?.throwIfAborted();
      // Fit whole recent turns against the actual SDK request, including its
      // candidate metadata and questions. Never truncate the current request.
      request = structuredClone(request);
      const state = request.state as { context?: { history?: unknown[] } };
      const history = state?.context?.history;
      while (Array.isArray(history) && history.length && Buffer.byteLength(JSON.stringify(request)) > 32000) history.shift();
      if (Buffer.byteLength(JSON.stringify(request)) > 32000) throw new Error('Routing input is too large');
      const reservation = await governor.reserve(config.router.maxCallUsd, 'jev');
      let cost: number | undefined;
      let usage: Record<string, unknown> | undefined;
      try {
        const result = await decideUntilCancelled(inner, request, signal);
        usage = result.usage;
        if (typeof usage?.cost === 'number' && usage.cost >= 0) cost = usage.cost;
        return result;
      } finally {
        const charged = await governor.settle(reservation, cost, 'provider-reported');
        await telemetry.event('usage', { stage: 'routing', chargedUsd: charged, basis: cost === undefined ? 'reserved-maximum' : 'provider-reported', inputTokens: usage?.input_tokens, outputTokens: usage?.output_tokens });
      }
    },
  };
}

export interface InferenceState { turns: number; stop?: 'budget' | 'turn_limit' | 'context_limit' | 'payload_limit' | 'unsupported' | 'provider_error' | 'timeout' }

function errorMessage(model: Model<'openai-completions'>, message: string): AssistantMessage {
  return {
    role: 'assistant', content: [], api: model.api, provider: model.provider, model: model.id,
    stopReason: 'error', errorMessage: message, timestamp: Date.now(),
    usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
  };
}

// Observe just provider billing metadata while pi parses the model/tool stream.
// Forward the original bytes without retaining text, prompts, or tool arguments.
function observeBilling(response: Response, observed: { cost?: number; model?: string; completeUsage?: boolean }): Response {
  if (!response.body || !response.ok) return response;
  const decoder = new TextDecoder();
  let pending = '';
  const stream = response.body.pipeThrough(new TransformStream<Uint8Array, Uint8Array>({
    transform(chunk, controller) {
      pending += decoder.decode(chunk, { stream: true });
      const lines = pending.split('\n');
      pending = lines.pop() ?? '';
      if (pending.length > 2_000_000) throw new Error('Provider stream line exceeded limit');
      for (const line of lines) {
        if (!line.startsWith('data:')) continue;
        try {
          const value = JSON.parse(line.slice(5)) as { model?: unknown; usage?: { cost?: unknown; prompt_tokens?: unknown; completion_tokens?: unknown } };
          if (typeof value.model === 'string') observed.model = value.model;
          if (typeof value.usage?.cost === 'number' && Number.isFinite(value.usage.cost) && value.usage.cost >= 0) observed.cost = value.usage.cost;
          if (value.usage) observed.completeUsage = [value.usage.prompt_tokens, value.usage.completion_tokens].every(value => typeof value === 'number' && Number.isFinite(value) && value >= 0);
        } catch { /* pi owns protocol parsing; [DONE] is not JSON. */ }
      }
      controller.enqueue(chunk);
    },
  }));
  return new Response(stream, { status: response.status, statusText: response.statusText, headers: response.headers });
}

export function guardedStream(
  config: Config, tier: Tier, governor: SpendGovernor, telemetry: Telemetry, state: InferenceState,
  controls?: { toolChoice?: 'auto' | 'required' | 'none'; maxOutputTokens?: number },
): StreamFn {
  const profile = effectiveProfile(config, tier);
  const spec = modelFor(config, tier);
  const model = piModel(spec, profile);
  const reservedOutputTokens = Math.min(controls?.maxOutputTokens ?? profile.maxOutputTokens, profile.maxOutputTokens);
  return (_model, context, options) => {
    const output = new AssistantMessageEventStream();
    const run = async (): Promise<void> => {
      if (state.stop) throw new Error('Attempt already stopped');
      if (++state.turns > config.policy.limits.maxTurns) { state.stop = 'turn_limit'; throw new Error('Turn limit reached'); }
      let reservation: string | undefined;
      let completed: AssistantMessage | undefined;
      let sent = false;
      const observed: { cost?: number; model?: string; completeUsage?: boolean } = {};
      const signal = AbortSignal.any([options?.signal ?? new AbortController().signal, AbortSignal.timeout(config.policy.limits.requestTimeoutMs)]);
      try {
        const stream = openAIStream(model, context, {
          apiKey: config.secrets[profile.model] || 'local-no-key',
          signal, maxTokens: reservedOutputTokens, maxRetries: 0,
          toolChoice: controls?.toolChoice,
          temperature: spec.temperature,
          timeoutMs: config.policy.limits.requestTimeoutMs,
          onPayload: payload => spec.provider === 'openrouter' ? {
            ...(payload as Record<string, unknown>),
            provider: { require_parameters: true, max_price: { prompt: spec.inputUsdPerMillion, completion: spec.outputUsdPerMillion, request: 0 } },
          } : spec.provider === 'ollama' ? {
            ...(payload as Record<string, unknown>), reasoning_effort: profile.effort,
          } : undefined,
          fetch: async (input, init) => {
            const body = typeof init?.body === 'string' ? init.body : '';
            const payloadBytes = Buffer.byteLength(body);
            const estimatedInputTokens = body && payloadBytes <= MAX_PAYLOAD_BYTES ? estimateInputTokens(body) : undefined;
            const rejection = payloadBytes > MAX_PAYLOAD_BYTES ? 'payload_limit'
              : estimatedInputTokens !== undefined && estimatedInputTokens + reservedOutputTokens > profile.contextTokens ? 'context_limit' : undefined;
            await telemetry.event('context_admission', { tier, model: spec.id, payloadBytes, estimatedInputTokens,
              contextTokens: profile.contextTokens, reservedOutputTokens, method: 'conservative-lexical', rejection });
            if (rejection) {
              state.stop = rejection; throw new Error('Request exceeds configured admission ceiling');
            }
            if (!body) throw new Error('Missing serialized request');
            if (sent) throw new Error('Unexpected provider retry blocked');
            try { reservation = await governor.reserve(callCeiling(spec), `${tier}:${spec.id}`); }
            catch (error) { if (error instanceof BudgetError) state.stop = 'budget'; throw error; }
            sent = true;
            const response = await fetch(input, { ...init, redirect: 'error', signal });
            if (response.status === 400 || response.status === 404 || response.status === 422) state.stop = 'unsupported';
            if (!response.ok) await telemetry.event('provider_http_error', { tier, model: spec.id, status: response.status });
            return observeBilling(response, observed);
          },
        });
        for await (const event of stream) {
          if (event.type === 'done' || event.type === 'error') {
            completed = event.type === 'done' ? event.message : event.error;
          } else output.push(event);
        }
        completed ??= await stream.result();
      } finally {
        if (reservation) {
          const usage = completed?.usage;
          const complete = completed && !['error', 'aborted', 'pending'].includes(completed.stopReason);
          const validUsage = complete && observed.completeUsage && usage;
          // pi's usage.cost is calculated from configured rates, not the invoice.
          // Execution backends are local-only. Some OpenAI-compatible servers
          // emit synthetic cost fields; they cannot turn a zero-cost local
          // deployment into a billed execution candidate.
          const reported = complete && callCeiling(spec) > 0 ? observed.cost : undefined;
          const cost = reported !== undefined ? reported : 0;
          const basis = reported !== undefined ? 'provider-reported' : validUsage ? 'configured-rates' : 'reserved-maximum';
          const charged = await governor.settle(reservation, cost, basis);
          await telemetry.event('usage', { stage: 'inference', tier, model: spec.id, providerModel: observed.model, usage, chargedUsd: charged, basis });
        }
      }
      if (!completed) throw new Error('Provider returned no final response');
      if (completed.stopReason === 'error' || completed.stopReason === 'aborted') {
        state.stop ??= signal.aborted ? 'timeout' : 'provider_error';
        // Do not echo provider error bodies, which may reflect request content.
        completed.errorMessage = `Inference stopped (${state.stop})`;
        output.push({ type: 'error', reason: completed.stopReason, error: completed });
      } else if (completed.stopReason === 'pending') throw new Error('Incomplete provider response');
      else output.push({ type: 'done', reason: completed.stopReason, message: completed });
      output.end();
    };
    void run().catch(error => {
      state.stop ??= error instanceof BudgetError ? 'budget' : 'provider_error';
      output.push({ type: 'error', reason: 'error', error: errorMessage(model, `Inference stopped (${state.stop})`) });
      output.end();
    });
    return output;
  };
}
