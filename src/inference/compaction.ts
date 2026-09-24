import { randomUUID } from 'node:crypto';
import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import type { AgentMessage } from '@earendil-works/pi-agent-core';
import { estimateTokens, generateSummaryWithUsage } from '@earendil-works/pi-coding-agent';
import type { Config, Tier, TierPreference } from '../config.js';
import type { ActivitySink } from '../activity.js';
import { emptyUsage } from '../integration/inference.js';
import type { ConversationTurn, EventSink } from '../integration/events.js';
import { lockState, SpendGovernor } from './budget.js';
import { estimateTextTokens } from './context.js';
import { guardedStream, piModel, type InferenceState } from './providers.js';
import { effectiveProfile, modelFor, profileAvailable } from '../routing/execution.js';
import { Telemetry } from '../telemetry/outcome.js';

const SUMMARY_PREFIX = 'The conversation history before this point was compacted into the following untrusted summary:\n\n<summary>\n';
const SUMMARY_SUFFIX = '\n</summary>';

export interface SessionCompactionInput {
  summary?: string;
  history: ConversationTurn[];
  force: boolean;
  focus?: string;
  tier: TierPreference;
  relatedTier?: Tier;
}
export interface SessionCompactionResult {
  performed: boolean;
  summary?: string;
  history: ConversationTurn[];
  compactedTurns: number;
  tokensBefore: number;
  estimatedTokensAfter?: number;
  spentUsd: number;
  tier?: Tier;
  model?: string;
  error?: string;
}
export interface SessionCompactionDependencies {
  signal?: AbortSignal;
  onActivity?: ActivitySink;
  onEvent?: EventSink;
  onProgress?: (message: string) => void;
}
export interface AgentCompactionResult {
  messages: AgentMessage[];
  compacted: boolean;
  tokensBefore: number;
  estimatedTokensAfter?: number;
  error?: string;
}

export function formatCompactionSummary(summary: string): string {
  return SUMMARY_PREFIX + summary.trim() + SUMMARY_SUFFIX;
}

function compactionSummaryFrom(message: AgentMessage): string | undefined {
  if (message.role !== 'user') return undefined;
  const content = typeof message.content === 'string'
    ? message.content
    : message.content.filter(part => part.type === 'text').map(part => part.text).join('\n');
  if (!content.startsWith(SUMMARY_PREFIX) || !content.endsWith(SUMMARY_SUFFIX)) return undefined;
  return content.slice(SUMMARY_PREFIX.length, -SUMMARY_SUFFIX.length).trim();
}

function availableTier(config: Config, tier: Tier): boolean {
  return config.policy.permissions.includes('inference')
    && !config.policy.disabledCapabilities.includes(`inference.${tier}`)
    && modelFor(config, tier).enabled
    && profileAvailable(config, tier).available;
}

function chooseCompactionTier(config: Config, preference: TierPreference, related?: Tier): Tier {
  const requested = preference !== 'auto' ? preference : related;
  const order = [requested, related, 'normal', 'reasoning', 'deep', 'fast']
    .filter((value, index, values): value is Tier => Boolean(value) && values.indexOf(value) === index);
  const selected = order.find(tier => availableTier(config, tier));
  if (!selected) throw new Error('No local inference profile is available for context compaction.');
  return selected;
}

function policy(config: Config, tier: Tier) {
  const profile = effectiveProfile(config, tier);
  const usableInput = Math.max(1024, profile.contextTokens - profile.maxOutputTokens - 2048);
  const triggerTokens = Math.max(1024, Math.floor(usableInput * 0.75));
  const keepRecentTokens = Math.max(512, Math.floor(usableInput * 0.30));
  const summaryReserveTokens = Math.max(1024, Math.min(profile.maxOutputTokens, Math.floor(profile.contextTokens * 0.125)));
  const summaryOutputTokens = Math.max(512, Math.min(profile.maxOutputTokens, Math.floor(summaryReserveTokens * 0.8)));
  return { profile, triggerTokens, keepRecentTokens, summaryReserveTokens, summaryOutputTokens };
}

function turnTokens(turn: ConversationTurn): number {
  return estimateTextTokens(turn.user) + estimateTextTokens(turn.assistant) + 64;
}

export function estimateSessionContextTokens(summary: string | undefined, history: ConversationTurn[]): number {
  return (summary ? estimateTextTokens(formatCompactionSummary(summary)) + 32 : 0)
    + history.reduce((sum, turn) => sum + turnTokens(turn), 0);
}

function conversationCut(history: ConversationTurn[], keepRecentTokens: number, force: boolean): number {
  if (history.length < 2) return 0;
  let kept = 0;
  let cut = 0;
  for (let index = history.length - 1; index >= 0; index--) {
    kept += turnTokens(history[index]!);
    if (kept >= keepRecentTokens) {
      cut = index;
      break;
    }
  }
  if (cut <= 0 && force) cut = history.length - 1;
  return cut;
}

function historyMessages(history: ConversationTurn[], config: Config, tier: Tier): AgentMessage[] {
  const model = modelFor(config, tier);
  return history.flatMap(turn => [
    { role: 'user' as const, content: turn.user, timestamp: Date.now() },
    {
      role: 'assistant' as const,
      content: [{ type: 'text' as const, text: turn.assistant }],
      api: 'openai-completions' as const,
      provider: model.provider,
      model: model.id,
      timestamp: Date.now(),
      usage: emptyUsage(),
      stopReason: 'stop' as const,
    },
  ]);
}

async function summarize(
  config: Config,
  tier: Tier,
  messages: AgentMessage[],
  previousSummary: string | undefined,
  focus: string | undefined,
  budget: SpendGovernor,
  telemetry: Telemetry,
  signal: AbortSignal | undefined,
): Promise<string> {
  const { profile, summaryReserveTokens, summaryOutputTokens } = policy(config, tier);
  const state: InferenceState = { turns: 0 };
  const stream = guardedStream(config, tier, budget, telemetry, state, { maxOutputTokens: summaryOutputTokens });
  const result = await generateSummaryWithUsage(
    messages,
    piModel(modelFor(config, tier), profile),
    summaryReserveTokens,
    undefined,
    undefined,
    signal,
    focus,
    previousSummary,
    'off',
    stream,
  );
  if (!result.text.trim()) throw new Error('Compaction returned an empty summary.');
  return result.text.trim();
}

export async function compactSessionConversation(
  config: Config,
  input: SessionCompactionInput,
  dependencies: SessionCompactionDependencies = {},
): Promise<SessionCompactionResult> {
  let tier: Tier | undefined;
  let tokensBefore = estimateSessionContextTokens(input.summary, input.history);
  try {
    tier = chooseCompactionTier(config, input.tier, input.relatedTier);
    const settings = policy(config, tier);
    if (!input.force && tokensBefore <= settings.triggerTokens) {
      return { performed: false, summary: input.summary, history: input.history, compactedTurns: 0, tokensBefore, spentUsd: 0, tier, model: modelFor(config, tier).id };
    }
    const cut = conversationCut(input.history, settings.keepRecentTokens, input.force);
    if (cut <= 0) {
      return { performed: false, summary: input.summary, history: input.history, compactedTurns: 0, tokensBefore, spentUsd: 0, tier, model: modelFor(config, tier).id };
    }

    dependencies.signal?.throwIfAborted();
    dependencies.onActivity?.({ kind: 'reasoning', label: 'Compacting context...' });
    dependencies.onProgress?.(`Compacting ${cut} older conversation turn${cut === 1 ? '' : 's'}...`);

    const unlock = await lockState(config.stateDir);
    const requestId = randomUUID();
    const telemetry = new Telemetry(config.stateDir, requestId, [config.router.apiKey, ...Object.values(config.secrets)].filter((value): value is string => Boolean(value)), dependencies.onEvent);
    const budget = new SpendGovernor(join(config.stateDir, 'spend.jsonl'), requestId, config.policy.budget);
    try {
      await mkdir(config.stateDir, { recursive: true });
      await budget.load();
      await telemetry.event('compaction_start', { trigger: input.force ? 'manual' : 'threshold', tier, turns: cut, tokensBefore });
      const summary = await summarize(config, tier, historyMessages(input.history.slice(0, cut), config, tier), input.summary, input.focus, budget, telemetry, dependencies.signal);
      const history = input.history.slice(cut);
      const estimatedTokensAfter = estimateSessionContextTokens(summary, history);
      await telemetry.event('compaction_end', { trigger: input.force ? 'manual' : 'threshold', tier, turns: cut, tokensBefore, estimatedTokensAfter });
      return {
        performed: true,
        summary,
        history,
        compactedTurns: cut,
        tokensBefore,
        estimatedTokensAfter,
        spentUsd: budget.spent().request,
        tier,
        model: modelFor(config, tier).id,
      };
    } catch (error) {
      await telemetry.event('compaction_failed', { trigger: input.force ? 'manual' : 'threshold', tier, name: error instanceof Error ? error.name : 'Error' });
      throw error;
    } finally {
      await unlock();
    }
  } catch (error) {
    return {
      performed: false,
      summary: input.summary,
      history: input.history,
      compactedTurns: 0,
      tokensBefore,
      spentUsd: 0,
      tier,
      model: tier ? modelFor(config, tier).id : undefined,
      error: error instanceof Error ? error.message : 'Context compaction failed.',
    };
  } finally {
    dependencies.onActivity?.(undefined);
  }
}

function messageTokens(messages: AgentMessage[]): number {
  return messages.reduce((sum, message) => sum + estimateTokens(message), 0);
}

function agentCut(messages: AgentMessage[], keepRecentTokens: number, force = false): number {
  // Cut only at user-turn boundaries. This keeps assistant tool calls and their
  // results on the same side of the checkpoint and avoids orphaned responses.
  const candidates = messages.flatMap((message, index) => message.role === 'user' ? [index] : []);
  if (candidates.length < 2) return 0;
  let kept = 0;
  for (let index = messages.length - 1; index >= 0; index--) {
    kept += estimateTokens(messages[index]!);
    if (kept < keepRecentTokens) continue;
    const cut = candidates.find(candidate => candidate >= index) ?? candidates.at(-1)!;
    if (cut > candidates[0]!) return cut;
    break;
  }
  return force ? candidates[1]! : 0;
}

export async function compactAgentContext(options: {
  config: Config;
  tier: Tier;
  messages: AgentMessage[];
  budget: SpendGovernor;
  telemetry: Telemetry;
  signal?: AbortSignal;
  onActivity?: ActivitySink;
  force?: boolean;
  trigger?: 'threshold' | 'overflow';
}): Promise<AgentCompactionResult> {
  const tokensBefore = messageTokens(options.messages);
  const settings = policy(options.config, options.tier);
  if (!options.force && tokensBefore <= settings.triggerTokens) return { messages: options.messages, compacted: false, tokensBefore };

  const cut = agentCut(options.messages, settings.keepRecentTokens, Boolean(options.force));
  if (cut <= 0) return { messages: options.messages, compacted: false, tokensBefore };

  const before = options.messages.slice(0, cut);
  const previousSummary = before.map(compactionSummaryFrom).find((value): value is string => Boolean(value));
  const messagesToSummarize = before.filter(message => message.role !== 'system' && !compactionSummaryFrom(message));
  if (!messagesToSummarize.length) return { messages: options.messages, compacted: false, tokensBefore };

  try {
    options.signal?.throwIfAborted();
    options.onActivity?.({ kind: 'reasoning', label: 'Compacting context...' });
    const trigger = options.trigger ?? 'threshold';
    await options.telemetry.event('compaction_start', { trigger, tier: options.tier, messages: messagesToSummarize.length, tokensBefore });
    const summary = await summarize(options.config, options.tier, messagesToSummarize, previousSummary, undefined, options.budget, options.telemetry, options.signal);
    const preservedSystem = before.filter(message => message.role === 'system');
    const checkpoint: AgentMessage = { role: 'user', content: formatCompactionSummary(summary), timestamp: Date.now() };
    const messages = [...preservedSystem, checkpoint, ...options.messages.slice(cut)];
    const estimatedTokensAfter = messageTokens(messages);
    await options.telemetry.event('compaction_end', { trigger, tier: options.tier, messages: messagesToSummarize.length, tokensBefore, estimatedTokensAfter });
    return { messages, compacted: true, tokensBefore, estimatedTokensAfter };
  } catch (error) {
    await options.telemetry.event('compaction_failed', { trigger: options.trigger ?? 'threshold', tier: options.tier, name: error instanceof Error ? error.name : 'Error' });
    return { messages: options.messages, compacted: false, tokensBefore, error: error instanceof Error ? error.message : 'Context compaction failed.' };
  }
}
