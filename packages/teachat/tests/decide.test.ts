import { describe, expect, it, vi } from 'vitest';
import { decideSafely, identityCandidates, pickAction, pickChannel, pickIdentity, sample, type Decider, type Decision } from '../src/decide.js';
import type { ChannelMeta, Identity, Message } from '../src/store.js';
import { AbortError } from '../src/util.js';
import { seeded } from './helpers.js';

const now = Date.parse('2026-09-26T12:00:00Z');
const identity = (username: string, lease?: Identity['lease']): Identity => ({ username, bio: `${username} bio`, updatedAt: new Date(now).toISOString(), ...(lease && { lease }) });
const people = ['juner', 'daniel', 'marlow', 'pip', 'oona', 'basil'].map(name => identity(name));
/** A decider that answers every question with `answer(options)`, recording what it was asked. */
function fake(answer: (options: Record<string, string>) => Omit<Decision<string>, 'choice'> & { choice: string }): Decider & { asked: Array<{ state: unknown; instructions: string; options: Record<string, string> }> } {
  const asked: Array<{ state: unknown; instructions: string; options: Record<string, string> }> = [];
  return { asked, choose: async <K extends string>(q: { state: unknown; instructions: string; options: Record<K, string> }) => { asked.push(q); return answer(q.options) as unknown as Decision<K>; } };
}
const conclusion = { monologue: 'that went well', summary: 'a css bug' };

describe('sample', () => {
  it('follows the probabilities with a seeded rng', () => {
    expect(sample({ a: 0.7, b: 0.3 }, { rng: () => 0.1 })).toBe('a');
    expect(sample({ a: 0.7, b: 0.3 }, { rng: () => 0.8 })).toBe('b');
    const rng = seeded(42);
    const draws = Array.from({ length: 4000 }, () => sample({ a: 0.7, b: 0.3 }, { rng }));
    expect(draws.filter(d => d === 'a').length / draws.length).toBeCloseTo(0.7, 1);
  });

  it('sharpens at low temperature, flattens at high, and falls back to the argmax', () => {
    expect(sample({ a: 0.7, b: 0.3 }, { temperature: 0.1, rng: () => 0.99 })).toBe('a');
    const rng = seeded(7);
    const hot = Array.from({ length: 4000 }, () => sample({ a: 0.9, b: 0.1 }, { temperature: 100, rng }));
    expect(hot.filter(d => d === 'b').length / hot.length).toBeGreaterThan(0.4);
    expect(sample({ a: 0.2, b: 0.8 }, { temperature: 0 })).toBe('b');
    expect(sample({ a: 0, b: 0 })).toBe('a');
    expect(sample({ a: Number.NaN, b: 0.5 }, { rng: () => 0.99 })).toBe('b');
    expect(() => sample({})).toThrow();
  });
});

describe('pickIdentity', () => {
  it('sometimes picks uniformly at random (epsilon)', async () => {
    const decider = fake(() => ({ choice: 'pip', probabilities: { pip: 1 }, confidence: 1 }));
    expect(await pickIdentity({ decider, request: 'x', identities: people, holder: 'h', now, rng: () => 0 })).toEqual({ username: 'juner', how: 'epsilon' });
    expect(decider.asked).toHaveLength(0);
  });

  it('samples from Jev and never offers identities leased by someone else', async () => {
    const until = new Date(now + 60_000).toISOString();
    const identities = [identity('juner', { holder: 'other', until }), identity('daniel', { holder: 'me', until }), identity('pip', { holder: 'other', until: new Date(now - 1).toISOString() }), identity('oona')];
    const decider = fake(() => ({ choice: 'oona', probabilities: { juner: 0.9, pip: 0.1 }, confidence: 0.9 }));
    const pick = await pickIdentity({ decider, request: 'fix my css', identities, holder: 'me', now, epsilon: 0, rng: seeded(1) });
    expect(pick).toEqual({ username: 'pip', how: 'jev' });
    expect(Object.keys(decider.asked[0]!.options)).toEqual(['daniel', 'pip', 'oona']);
    expect(decider.asked[0]!.options.pip).toBe('pip bio');
    expect(decider.asked[0]!.state).toEqual({ request: 'fix my css' });
    expect(await pickIdentity({ request: 'x', identities: [identity('juner', { holder: 'other', until })], holder: 'me', now })).toBeUndefined();
  });

  it('falls back to uniform on low confidence, errors or no decider, and rethrows aborts', async () => {
    const low = fake(() => ({ choice: 'pip', probabilities: { pip: 1 }, confidence: 0.1 }));
    expect((await pickIdentity({ decider: low, request: 'x', identities: people, holder: 'h', now, epsilon: 0 }))?.how).toBe('random');
    const broken: Decider = { choose: async () => { throw new Error('rate limited'); } };
    expect((await pickIdentity({ decider: broken, request: 'x', identities: people, holder: 'h', now, epsilon: 0 }))?.how).toBe('random');
    expect((await pickIdentity({ request: 'x', identities: people, holder: 'h', now, epsilon: 0 }))?.how).toBe('random');
    const aborting: Decider = { choose: async () => { throw new AbortError(); } };
    await expect(pickIdentity({ decider: aborting, request: 'x', identities: people, holder: 'h', now, epsilon: 0 })).rejects.toMatchObject({ name: 'AbortError' });
    const controller = new AbortController();
    const cancelled: Decider = { choose: async () => { controller.abort(); throw new Error('socket closed'); } };
    await expect(pickIdentity({ decider: cancelled, request: 'x', identities: people, holder: 'h', now, epsilon: 0, signal: controller.signal })).rejects.toMatchObject({ name: 'AbortError' });
  });

  it('uses a precomputed answer from the router without asking again', async () => {
    const decider = fake(() => ({ choice: 'pip', probabilities: { pip: 1 }, confidence: 1 }));
    const pick = await pickIdentity({ decider, request: 'x', identities: people, holder: 'h', now, epsilon: 0, answer: { probabilities: { basil: 1, ghost: 5 }, confidence: 0.8 } });
    expect(pick).toEqual({ username: 'basil', how: 'jev' });
    expect(decider.asked).toHaveLength(0);
    expect((await pickIdentity({ request: 'x', identities: people, holder: 'h', now, epsilon: 0, answer: { probabilities: { basil: 1 }, confidence: 0.1 } }))?.how).toBe('random');
  });

  it('offers at most eight candidates', async () => {
    const many = Array.from({ length: 12 }, (_, i) => identity(`agent${i}`));
    const decider = fake(options => ({ choice: Object.keys(options)[0]!, probabilities: {}, confidence: 1 }));
    const pick = await pickIdentity({ decider, request: 'x', identities: many, holder: 'h', now, epsilon: 0, rng: seeded(3) });
    expect(Object.keys(decider.asked[0]!.options)).toHaveLength(8);
    expect(pick).toEqual({ username: Object.keys(decider.asked[0]!.options)[0], how: 'jev' });
    expect(new Set(identityCandidates(many, { holder: 'h', rng: seeded(3) }).map(i => i.username)).size).toBe(8);
  });
});

describe('channel and action', () => {
  const channels: ChannelMeta[] = [
    { id: 'ysk', description: 'Tips.', summary: '', summaryAt: null, nextN: 1 },
    { id: 'venting', description: 'Vent.', summary: 'flaky CI', summaryAt: 3, nextN: 5 },
    { id: 'offtopic', description: 'General.', summary: '', summaryAt: null, nextN: 1 },
  ];
  const message = (n: number, minutesAgo: number, kind: Message['kind'] = 'message'): Message =>
    ({ n, channel: 'venting', author: kind === 'event' ? 'system' : 'pip', kind, text: `m${n}`, at: new Date(now - minutesAgo * 60_000).toISOString() });

  it('picks a channel from descriptions and summaries, falling back to #offtopic', async () => {
    const decider = fake(() => ({ choice: 'venting', probabilities: { venting: 0.8 }, confidence: 0.8 }));
    expect(await pickChannel({ decider, conclusion, channels })).toBe('venting');
    expect(decider.asked[0]!.options).toEqual({ ysk: 'Tips.', venting: 'Vent. Current topic: flaky CI', offtopic: 'General.' });
    expect(await pickChannel({ decider: fake(() => ({ choice: 'venting', probabilities: {}, confidence: 0.2 })), conclusion, channels })).toBe('offtopic');
    expect(await pickChannel({ decider: fake(() => ({ choice: 'nowhere', probabilities: {}, confidence: 1 })), conclusion, channels })).toBe('offtopic');
    expect(await pickChannel({ conclusion, channels })).toBe('offtopic');
  });

  it('picks an action, falling back on the age of the newest message', async () => {
    const venting = channels[1]!;
    const decider = fake(() => ({ choice: 'change_topic', probabilities: {}, confidence: 0.9 }));
    expect(await pickAction({ decider, conclusion, channel: venting, recent: [message(1, 5)], now })).toBe('change_topic');
    expect(decider.asked[0]!.state).toMatchObject({ conclusion: 'that went well', channel: '#venting', summary: 'flaky CI', newestMessage: '5 minutes ago' });
    expect((decider.asked[0]!.state as { recent: string }).recent).toContain('#1 teapilot:pip - 5 minutes ago');
    expect(await pickAction({ conclusion, channel: venting, recent: [message(1, 90), message(2, 10)], now })).toBe('join_discussion');
    expect(await pickAction({ conclusion, channel: venting, recent: [message(1, 120)], now })).toBe('change_topic');
    expect(await pickAction({ conclusion, channel: venting, recent: [message(1, 120), message(2, 1, 'event')], now })).toBe('change_topic');
    expect(await pickAction({ conclusion, channel: venting, recent: [], now })).toBe('change_topic');
  });

  it('decideSafely returns undefined for the caller to fall back', async () => {
    const question = { state: {}, instructions: 'pick', options: { a: 'A', b: 'B' } };
    expect(await decideSafely(undefined, question)).toBeUndefined();
    expect(await decideSafely({ choose: vi.fn(async () => { throw new Error('down'); }) }, question)).toBeUndefined();
    expect(await decideSafely(fake(() => ({ choice: 'b', probabilities: { b: 1 }, confidence: 0.5 })), question, { minConfidence: 0.6 })).toBeUndefined();
    expect((await decideSafely(fake(() => ({ choice: 'b', probabilities: { b: 1 }, confidence: 0.5 })), question))?.choice).toBe('b');
  });
});
