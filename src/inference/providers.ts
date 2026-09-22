import { type AssistantMessage, type Model } from '@earendil-works/pi-ai';
import { AssistantMessageEventStream } from '@earendil-works/pi-ai/utils/event-stream';
import { stream as openAIStream } from '@earendil-works/pi-ai/api/openai-completions';
import type { StreamFn } from '@earendil-works/pi-agent-core';
import { createSdkProvider, type JevProvider } from 'jevrouter';
import type { Config, ModelConfig, Tier } from '../config.js';
import { BudgetError, callCeiling, type SpendGovernor } from './budget.js';
import type { Telemetry } from '../telemetry/outcome.js';

export function piModel(config: ModelConfig): Model<'openai-completions'> {
  return {
    id: config.id, name: config.id, api: 'openai-completions', provider: config.provider,
    baseUrl: config.baseUrl, reasoning: false, input: ['text'],
    contextWindow: config.contextTokens, maxTokens: config.maxOutputTokens,
    cost: { input: config.inputUsdPerMillion, output: config.outputUsdPerMillion, cacheRead: config.inputUsdPerMillion, cacheWrite: config.inputUsdPerMillion },
    compat: { supportsDeveloperRole: config.supportsDeveloperRole, supportsUsageInStreaming: config.supportsUsage, maxTokensField: 'max_tokens' },
  };
}

export async function localAvailable(config: Config): Promise<boolean> {
  if (!config.models.local.enabled) return false;
  try {
    const response = await fetch(`${config.models.local.baseUrl.replace(/\/$/, '')}/models`, {
      headers: config.secrets.local ? { Authorization: `Bearer ${config.secrets.local}` } : {},
      signal: AbortSignal.timeout(3000), redirect: 'error',
    });
    return response.ok;
  } catch { return false; }
}

export function budgetedJev(config: Config, governor: SpendGovernor, telemetry: Telemetry, provider?: JevProvider): JevProvider {
  const inner = provider ?? createSdkProvider({ ...config.router, cache: false });
  return {
    name: inner.name,
    async decide(request) {
      if (Buffer.byteLength(JSON.stringify(request)) > 32000) throw new Error('Routing input is too large');
      const reservation = await governor.reserve(config.router.maxCallUsd, 'jev');
      let cost: number | undefined;
      let usage: Record<string, unknown> | undefined;
      try {
        const result = await inner.decide(request);
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

export interface InferenceState { turns: number; stop?: 'budget' | 'turn_limit' | 'unsupported' | 'provider_error' | 'timeout' }

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
): StreamFn {
  const spec = config.models[tier];
  const model = piModel(spec);
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
          apiKey: config.secrets[tier] || 'local-no-key',
          signal, maxTokens: spec.maxOutputTokens, maxRetries: 0,
          temperature: spec.temperature,
          timeoutMs: config.policy.limits.requestTimeoutMs,
          onPayload: payload => spec.provider === 'openrouter' ? {
            ...(payload as Record<string, unknown>),
            provider: { require_parameters: true, max_price: { prompt: spec.inputUsdPerMillion, completion: spec.outputUsdPerMillion, request: 0 } },
          } : spec.provider === 'ollama' ? {
            ...(payload as Record<string, unknown>), reasoning_effort: 'none',
          } : undefined,
          fetch: async (input, init) => {
            // A UTF-8 byte bound plus 2048 framing tokens is deliberately more
            // conservative than a chars/4 estimate. Text-only requests only.
            const body = typeof init?.body === 'string' ? init.body : '';
            if (!body || Buffer.byteLength(body) + 2048 > spec.contextTokens - spec.maxOutputTokens) {
              state.stop = 'unsupported'; throw new Error('Context exceeds configured input ceiling');
            }
            if (sent) throw new Error('Unexpected provider retry blocked');
            try { reservation = await governor.reserve(callCeiling(spec), `${tier}:${spec.id}`); }
            catch (error) { if (error instanceof BudgetError) state.stop = 'budget'; throw error; }
            sent = true;
            const response = await fetch(input, { ...init, redirect: 'error', signal });
            if (response.status === 400 || response.status === 404 || response.status === 422) state.stop = 'unsupported';
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
          const reported = complete ? observed.cost : undefined;
          const cost = tier === 'local' ? 0 : reported ?? (validUsage ? usage.cost.total : undefined);
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
