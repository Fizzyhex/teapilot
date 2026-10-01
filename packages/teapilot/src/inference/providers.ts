import { type AssistantMessage, type Model } from '@earendil-works/pi-ai';
import { AssistantMessageEventStream } from '@earendil-works/pi-ai/utils/event-stream';
import { stream as openAIStream } from '@earendil-works/pi-ai/api/openai-completions';
import type { StreamFn } from '@earendil-works/pi-agent-core';
import { createSdkProvider, type JevProvider } from 'jevrouter';
import type { Config, ModelConfig, Tier, PhysicalModel } from '../config.js';
import { effectiveProfile, modelFor, profileFor, type ExecutionProfile, type ThinkingLevel } from '../routing/execution.js';
import { BudgetError, callCeiling, type SpendGovernor } from './budget.js';
import type { Telemetry } from '../telemetry/outcome.js';
import { calibratedTokens, estimateInputTokens, estimatePayloadTokens, imageBytes, MAX_IMAGE_PAYLOAD_BYTES, MAX_PAYLOAD_BYTES, replyRoom, wellFormedText } from './context.js';
import { reasoningFields, samplingFor } from './reasoning.js';

export function piModel(config: ModelConfig, profile?: ExecutionProfile): Model<'openai-completions'> {
  return {
    id: config.id, name: config.id, api: 'openai-completions', provider: config.provider,
    baseUrl: config.baseUrl, reasoning: false, input: config.vision ? ['text', 'image'] : ['text'],
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
      let rate = false;
      let usage: Record<string, unknown> | undefined;
      try {
        const result = await decideUntilCancelled(inner, request, signal);
        usage = result.usage;
        if (typeof usage?.cost === 'number' && usage.cost >= 0) cost = usage.cost;
        // The SDK reports no cost; with a configured token rate, charge the tokens actually used instead of the ceiling.
        else if (config.router.usdPerMillionTokens !== undefined && typeof usage?.input_tokens === 'number' && typeof usage?.output_tokens === 'number') {
          cost = (usage.input_tokens + usage.output_tokens) * config.router.usdPerMillionTokens / 1e6; rate = true;
        }
        return result;
      } finally {
        const charged = await governor.settle(reservation, cost, rate ? 'configured-rate' : 'provider-reported');
        await telemetry.event('usage', { stage: 'routing', chargedUsd: charged, basis: cost === undefined ? 'reserved-maximum' : rate ? 'configured-rate' : 'provider-reported', inputTokens: usage?.input_tokens, outputTokens: usage?.output_tokens });
      }
    },
  };
}

export interface InferenceState {
  turns: number; stop?: 'budget' | 'turn_limit' | 'context_limit' | 'payload_limit' | 'unsupported' | 'provider_error' | 'timeout';
  /** Lexical estimate and provider-reported prompt tokens from the latest completed call. */
  calibration?: { estimated: number; reported: number };
  /** Server-side failure text, kept only when it matches a known load/runtime signature. */
  providerDetail?: string;
}

// Provider error bodies may reflect request content, so only messages that
// describe the server itself (model load, memory, crashed runner) are kept.
const serverFailure = /error loading model|llama-server process has terminated|model runner has unexpectedly stopped|requires more system memory|unable to allocate|out of memory|model ["']?[^"'\s]+["']? not found/i;
export async function providerFailureDetail(response: Response): Promise<string | undefined> {
  const body = await response.clone().text().catch(() => '');
  let message = body;
  try { const parsed = JSON.parse(body) as { error?: string | { message?: string } }; message = typeof parsed.error === 'string' ? parsed.error : parsed.error?.message ?? ''; } catch { /* plain text */ }
  const match = serverFailure.exec(message);
  if (!match) return undefined;
  const line = message.split('\n').find(part => serverFailure.test(part)) ?? match[0];
  return line.trim().slice(0, 300);
}

function errorMessage(model: Model<'openai-completions'>, message: string): AssistantMessage {
  return {
    role: 'assistant', content: [], api: model.api, provider: model.provider, model: model.id,
    stopReason: 'error', errorMessage: message, timestamp: Date.now(),
    usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
  };
}

// Observe just provider billing metadata while pi parses the model/tool stream.
// Forward the original bytes without retaining text, prompts, or tool arguments.
interface Observed { cost?: number; model?: string; completeUsage?: boolean; sent?: number; firstChoice?: number; lastChoice?: number }

/** Decode speed, and the wait for the first token (mostly prompt reading), from when stream chunks arrived. */
export function streamSpeed(observed: Observed, outputTokens: number | undefined): { firstTokenMs?: number; outputTokensPerSecond?: number } {
  const { sent, firstChoice, lastChoice } = observed;
  if (sent === undefined || firstChoice === undefined || lastChoice === undefined) return {};
  const decoding = (lastChoice - firstChoice) / 1000;
  // The first token opens the interval; the rest were decoded within it.
  const rate = outputTokens && outputTokens > 1 && decoding > 0 ? Math.round((outputTokens - 1) / decoding * 10) / 10 : undefined;
  return { firstTokenMs: Math.round(firstChoice - sent), ...rate === undefined ? {} : { outputTokensPerSecond: rate } };
}

function observeBilling(response: Response, observed: Observed): Response {
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
          const value = JSON.parse(line.slice(5)) as { model?: unknown; choices?: unknown; usage?: { cost?: unknown; prompt_tokens?: unknown; completion_tokens?: unknown } };
          if (typeof value.model === 'string') observed.model = value.model;
          if (Array.isArray(value.choices) && value.choices.length) { observed.lastChoice = performance.now(); observed.firstChoice ??= observed.lastChoice; }
          if (typeof value.usage?.cost === 'number' && Number.isFinite(value.usage.cost) && value.usage.cost >= 0) observed.cost = value.usage.cost;
          if (value.usage) observed.completeUsage = [value.usage.prompt_tokens, value.usage.completion_tokens].every(value => typeof value === 'number' && Number.isFinite(value) && value >= 0);
        } catch { /* pi owns protocol parsing; [DONE] is not JSON. */ }
      }
      controller.enqueue(chunk);
    },
  }));
  return new Response(stream, { status: response.status, statusText: response.statusText, headers: response.headers });
}

/**
 * `value` with every string made well-formed UTF-16. Text cut to length can end in half an emoji, and some model
 * servers fail the whole request on a lone surrogate (a tokenizer that needs valid UTF-8, say).
 */
export function wellFormed(value: unknown): unknown {
  // A picture's data URL is base64, which cannot hold a lone surrogate.
  if (typeof value === 'string') return value.startsWith('data:image/') ? value : wellFormedText(value);
  if (Array.isArray(value)) return value.map(wellFormed);
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, wellFormed(item)]));
  return value;
}

export function guardedStream(
  config: Config, tier: Tier, governor: SpendGovernor, telemetry: Telemetry, state: InferenceState,
  controls?: { toolChoice?: 'auto' | 'required' | 'none'; maxOutputTokens?: number; /** Replaces the tier's reply length, within the model's own limit. */ outputTokens?: number;
    /** Replaces the tier's reasoning level, as for summaries, which gain nothing from thinking. */ thinking?: ThinkingLevel },
): StreamFn {
  const profile = effectiveProfile(config, tier);
  const spec = modelFor(config, tier);
  const model = piModel(spec, profile);
  const cap = controls?.outputTokens !== undefined ? Math.min(controls.outputTokens, spec.maxOutputTokens)
    : Math.min(controls?.maxOutputTokens ?? profile.maxOutputTokens, profile.maxOutputTokens);
  // A call is admitted while its input leaves this much room; the reply may then use all the room there is, up to `cap`.
  const floor = replyRoom({ contextTokens: profile.contextTokens, maxOutputTokens: cap });
  const thinking = controls?.thinking ?? profile.thinking;
  // Temperature travels as its own option; the other settings join the reasoning fields.
  const { temperature, ...sampling } = samplingFor(spec, thinking);
  const fields = { ...sampling, ...reasoningFields(spec, thinking) };
  return (_model, context, options) => {
    const output = new AssistantMessageEventStream();
    const run = async (): Promise<void> => {
      if (state.stop) throw new Error('Attempt already stopped');
      if (++state.turns > config.policy.limits.maxTurns) { state.stop = 'turn_limit'; throw new Error('Turn limit reached'); }
      let reservation: string | undefined;
      let completed: AssistantMessage | undefined;
      let sent = false;
      let lexicalTokens: number | undefined;
      let maxTokens = cap;
      const observed: Observed = {};
      // requestTimeoutMs bounds a stall, not a whole stream: long local generations keep
      // producing tokens, and attemptTimeoutMs already bounds the attempt overall.
      const stalled = new AbortController();
      let stallTimer: NodeJS.Timeout | undefined;
      const progress = () => {
        clearTimeout(stallTimer);
        stallTimer = setTimeout(() => stalled.abort(new DOMException('Provider stream stalled', 'TimeoutError')), config.policy.limits.requestTimeoutMs);
      };
      progress();
      const signal = AbortSignal.any([options?.signal ?? new AbortController().signal, stalled.signal]);
      try {
        const stream = openAIStream(model, context, {
          apiKey: config.secrets[profile.model] || 'local-no-key',
          signal, maxTokens: cap, maxRetries: 0,
          toolChoice: controls?.toolChoice,
          temperature,
          timeoutMs: config.policy.limits.requestTimeoutMs,
          onPayload: raw => {
            const payload = wellFormed(raw) as Record<string, unknown>;
            // By the same estimate as the admission check, so a reply never asks for more than the context has left.
            try { maxTokens = Math.max(floor, Math.min(cap, profile.contextTokens - calibratedTokens(estimatePayloadTokens(payload), state.calibration))); }
            catch { maxTokens = cap; }
            const sized = { ...payload, max_tokens: maxTokens };
            return spec.provider === 'openrouter' ? {
              ...sized,
              provider: { require_parameters: true, max_price: { prompt: spec.inputUsdPerMillion, completion: spec.outputUsdPerMillion, request: 0 } },
            } : { ...sized, ...fields };
          },
          fetch: async (input, init) => {
            const body = typeof init?.body === 'string' ? init.body : '';
            // Pictures are bytes in the request but a few hundred tokens to the model, so they have a ceiling of their own.
            const pictureBytes = imageBytes(body);
            const payloadBytes = Buffer.byteLength(body) - pictureBytes;
            lexicalTokens = body && payloadBytes <= MAX_PAYLOAD_BYTES && pictureBytes <= MAX_IMAGE_PAYLOAD_BYTES ? estimateInputTokens(body) : undefined;
            const calibration = state.calibration;
            const estimatedInputTokens = lexicalTokens === undefined ? undefined : calibratedTokens(lexicalTokens, calibration);
            const rejection = payloadBytes > MAX_PAYLOAD_BYTES || pictureBytes > MAX_IMAGE_PAYLOAD_BYTES ? 'payload_limit'
              : estimatedInputTokens !== undefined && estimatedInputTokens + floor > profile.contextTokens ? 'context_limit' : undefined;
            await telemetry.event('context_admission', { tier, model: spec.id, payloadBytes, estimatedInputTokens, lexicalTokens,
              contextTokens: profile.contextTokens, reservedOutputTokens: floor, maxOutputTokens: maxTokens, method: calibration ? 'calibrated-lexical' : 'conservative-lexical', rejection });
            if (rejection) {
              state.stop = rejection; throw new Error('Request exceeds configured admission ceiling');
            }
            if (!body) throw new Error('Missing serialized request');
            if (sent) throw new Error('Unexpected provider retry blocked');
            try { reservation = await governor.reserve(callCeiling(spec), `${tier}:${spec.id}`); }
            catch (error) { if (error instanceof BudgetError) state.stop = 'budget'; throw error; }
            sent = true;
            observed.sent = performance.now();
            const response = await fetch(input, { ...init, redirect: 'error', signal });
            if (response.status === 400 || response.status === 404 || response.status === 422) state.stop = 'unsupported';
            if (!response.ok) {
              state.providerDetail = await providerFailureDetail(response);
              await telemetry.event('provider_http_error', { tier, model: spec.id, status: response.status, detail: state.providerDetail });
            }
            return observeBilling(response, observed);
          },
        });
        for await (const event of stream) {
          progress();
          if (event.type === 'done' || event.type === 'error') {
            completed = event.type === 'done' ? event.message : event.error;
          } else output.push(event);
        }
        completed ??= await stream.result();
      } finally {
        clearTimeout(stallTimer);
        if (reservation) {
          const usage = completed?.usage;
          const complete = completed && !['error', 'aborted', 'pending'].includes(completed.stopReason);
          const validUsage = complete && observed.completeUsage && usage;
          const reportedInput = validUsage ? usage.input + usage.cacheRead + usage.cacheWrite : 0;
          if (lexicalTokens && reportedInput > 0) state.calibration = { estimated: lexicalTokens, reported: reportedInput };
          // pi's usage.cost is calculated from configured rates, not the invoice.
          // Execution backends are local-only. Some OpenAI-compatible servers
          // emit synthetic cost fields; they cannot turn a zero-cost local
          // deployment into a billed execution candidate.
          const reported = complete && callCeiling(spec) > 0 ? observed.cost : undefined;
          const cost = reported !== undefined ? reported : 0;
          const basis = reported !== undefined ? 'provider-reported' : validUsage ? 'configured-rates' : 'reserved-maximum';
          const charged = await governor.settle(reservation, cost, basis);
          await telemetry.event('usage', { stage: 'inference', tier, model: spec.id, providerModel: observed.model, usage, chargedUsd: charged, basis, ...complete ? streamSpeed(observed, usage?.output) : {} });
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
