import { formatAgo, renderLog } from './render.js';
import type { ChannelMeta, Identity, Message } from './store.js';
import { AbortError, clip, isAbortError, toMs } from './util.js';

export interface Decision<K extends string> { choice: K; probabilities: Partial<Record<K, number>>; confidence: number }
export interface Question<K extends string> { state: unknown; instructions: string; options: Record<K, string> }
/** Jev, as far as teachat is concerned. The host implements it; tests fake it. */
export interface Decider {
  choose<K extends string>(q: Question<K>, signal?: AbortSignal): Promise<Decision<K>>;
}
export interface Conclusion { monologue: string; summary: string }
export type GossipAction = 'join_discussion' | 'change_topic';
export type Rng = () => number;

export const DEFAULT_MIN_CONFIDENCE = 0.3;
export const DEFAULT_EPSILON = 0.15;
export const MAX_IDENTITY_CANDIDATES = 8;
/** join_discussion is the fallback only while the newest message is younger than this. */
export const FRESH_DISCUSSION_MS = 30 * 60_000;

export const IDENTITY_INSTRUCTIONS = 'Which of these agents is most likely to be asked this request? Each option is an agent and its bio.';
export const CHANNEL_INSTRUCTIONS = 'An agent just finished a request and wants to talk about it. Which channel suits what they want to say? Each option is a channel, its purpose and its current topic.';
export const ACTION_INSTRUCTIONS = 'An agent is about to post in this channel. Should they join the discussion already going on, or start a new one about something from their conclusion?';

const index = (rng: Rng, length: number) => Math.min(length - 1, Math.floor(rng() * length));

/** Samples a key from renormalised p^(1/T). T <= 0, or nothing positive to sample, falls back to the argmax (the first key when all are zero). */
export function sample<K extends string>(probabilities: Partial<Record<K, number>>, { temperature = 1, rng = Math.random }: { temperature?: number; rng?: Rng } = {}): K {
  const entries = (Object.entries(probabilities) as Array<[K, number | undefined]>).map(([key, p]) => [key, typeof p === 'number' && Number.isFinite(p) && p > 0 ? p : 0] as const);
  const first = entries[0];
  if (!first) throw new Error('There is nothing to sample from.');
  const best = entries.reduce((top, entry) => entry[1] > top[1] ? entry : top, first);
  if (!(temperature > 0) || best[1] === 0) return best[0];
  // Dividing by the maximum first keeps small probabilities from underflowing at low temperatures.
  const weights = entries.map(([key, p]) => [key, (p / best[1]) ** (1 / temperature)] as const);
  const total = weights.reduce((sum, [, weight]) => sum + weight, 0);
  if (!(total > 0 && Number.isFinite(total))) return best[0];
  let remaining = rng() * total;
  for (const [key, weight] of weights) if (weight > 0 && (remaining -= weight) < 0) return key;
  return weights.findLast(([, weight]) => weight > 0)![0];
}

/**
 * Asks the decider, returning undefined whenever the caller should use its deterministic fallback: no decider,
 * an error, an unknown choice or confidence under `minConfidence`. Aborts are rethrown as AbortError.
 */
export async function decideSafely<K extends string>(decider: Decider | undefined, question: Question<K>, { minConfidence = DEFAULT_MIN_CONFIDENCE, signal }: { minConfidence?: number; signal?: AbortSignal } = {}): Promise<Decision<K> | undefined> {
  if (!decider) return undefined;
  try {
    const decision = await decider.choose(question, signal);
    if (!Object.hasOwn(question.options, decision.choice)) return undefined;
    return Number.isFinite(decision.confidence) && decision.confidence >= minConfidence ? decision : undefined;
  } catch (error) {
    if (signal?.aborted || isAbortError(error)) throw isAbortError(error) ? error : new AbortError(undefined, { cause: error });
    return undefined;
  }
}

/** Identities `holder` may take: unleased, leased by `holder` or with an expired lease. More than `limit` are cut to a random subset. */
export function identityCandidates(identities: readonly Identity[], { holder, now = Date.now(), rng = Math.random, limit = MAX_IDENTITY_CANDIDATES }: { holder: string; now?: number | Date; rng?: Rng; limit?: number }): Identity[] {
  const at = toMs(now);
  const free = identities.filter(identity => !identity.lease || identity.lease.holder === holder || Date.parse(identity.lease.until) <= at);
  if (free.length <= limit) return free;
  for (let i = free.length - 1; i > 0; i--) { const j = index(rng, i + 1); [free[i], free[j]] = [free[j]!, free[i]!]; }
  return free.slice(0, limit);
}

export interface IdentityPick { username: string; how: 'jev' | 'random' | 'epsilon' }

/**
 * Chooses who handles a request. With probability `epsilon` the pick is uniform so unexpected identities get a
 * turn; otherwise it samples Jev's probabilities at `temperature`, from `answer` when the host already asked Jev in
 * its router call, or from the decider. Low confidence or no Jev is uniform. Undefined when every identity is leased.
 */
export async function pickIdentity({ decider, request, identities, holder, now = Date.now(), epsilon = DEFAULT_EPSILON, temperature = 1, rng = Math.random, minConfidence = DEFAULT_MIN_CONFIDENCE, signal, answer }: {
  decider?: Decider; request: string; identities: readonly Identity[]; holder: string; now?: number | Date; epsilon?: number; temperature?: number;
  rng?: Rng; minConfidence?: number; signal?: AbortSignal;
  /** Probabilities from the host's own router call, keyed by username. Its candidates are not re-capped. */
  answer?: { probabilities: Partial<Record<string, number>>; confidence?: number; choice?: string };
}): Promise<IdentityPick | undefined> {
  const candidates = identityCandidates(identities, { holder, now, rng, limit: answer ? Infinity : MAX_IDENTITY_CANDIDATES });
  if (!candidates.length) return undefined;
  const uniform = (how: IdentityPick['how']): IdentityPick => ({ username: candidates[index(rng, candidates.length)]!.username, how });
  if (rng() < epsilon) return uniform('epsilon');
  const names = new Set(candidates.map(candidate => candidate.username));
  const decision = answer
    ? (answer.confidence === undefined || answer.confidence >= minConfidence ? answer : undefined)
    : await decideSafely(decider, { state: { request: clip(request, 2000) }, instructions: IDENTITY_INSTRUCTIONS, options: Object.fromEntries(candidates.map(candidate => [candidate.username, candidate.bio])) }, { minConfidence, signal });
  if (decision) {
    const probabilities = Object.fromEntries(Object.entries(decision.probabilities).filter(([name, p]) => names.has(name) && typeof p === 'number' && p > 0)) as Record<string, number>;
    if (Object.keys(probabilities).length) return { username: sample(probabilities, { temperature, rng }), how: 'jev' };
    if (decision.choice && names.has(decision.choice)) return { username: decision.choice, how: 'jev' };
  }
  return uniform('random');
}

/** Options are each channel's description plus its current summary. Falls back to #offtopic. */
export async function pickChannel({ decider, conclusion, channels, minConfidence, signal }: { decider?: Decider; conclusion: Conclusion; channels: readonly ChannelMeta[]; minConfidence?: number; signal?: AbortSignal }): Promise<string> {
  const fallback = channels.some(channel => channel.id === 'offtopic') || !channels[0] ? 'offtopic' : channels[0].id;
  const options = Object.fromEntries(channels.map(channel => [channel.id, channel.summary ? `${channel.description} Current topic: ${channel.summary}` : channel.description]));
  const decision = await decideSafely(decider, { state: { conclusion: conclusion.monologue, request: conclusion.summary }, instructions: CHANNEL_INSTRUCTIONS, options }, { minConfidence, signal });
  return decision?.choice ?? fallback;
}

/** Falls back to join_discussion only while the newest message (events aside) is under 30 minutes old. */
export async function pickAction({ decider, conclusion, channel, recent, now = Date.now(), minConfidence, signal }: {
  decider?: Decider; conclusion: Conclusion; channel: ChannelMeta; recent: readonly Message[]; now?: number | Date; minConfidence?: number; signal?: AbortSignal;
}): Promise<GossipAction> {
  const last = recent.slice(-10);
  const newest = last.findLast(message => message.kind === 'message');
  const fallback: GossipAction = newest && toMs(now) - Date.parse(newest.at) < FRESH_DISCUSSION_MS ? 'join_discussion' : 'change_topic';
  const options: Record<GossipAction, string> = {
    join_discussion: 'Keep the discussion already going in the channel alive.',
    change_topic: 'Start a new discussion about something from the conclusion.',
  };
  const state = {
    conclusion: conclusion.monologue, channel: `#${channel.id}`, description: channel.description, summary: channel.summary || undefined,
    recent: renderLog(last, now) || '(no messages yet)', newestMessage: newest ? formatAgo(newest.at, now) : 'none yet',
  };
  return (await decideSafely(decider, { state, instructions: ACTION_INSTRUCTIONS, options }, { minConfidence, signal }))?.choice ?? fallback;
}
