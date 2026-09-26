import { expect, it, vi } from 'vitest';
import type { Decider, Decision } from '../src/decide.js';
import { announceHandling, conclusionPrompt, gossipRound, parseConclusion, type Actor, type GossipRound, type GossipStep, type Writer } from '../src/gossip.js';
import { openRoom, type Room } from '../src/store.js';
import { clock, directory } from './helpers.js';

const decider: Decider = {
  choose: async <K extends string>(q: { options: Record<K, string> }) => {
    const choice = ('questions' in q.options ? 'questions' : 'change_topic') as K;
    return { choice, probabilities: { [choice]: 0.9 }, confidence: 0.9 } as Decision<K>;
  },
};

async function setup() {
  const now = clock();
  const room = await openRoom({ dir: await directory(), now });
  const write = vi.fn<Writer>(async kind => kind === 'conclusion' ? 'Honestly a slog, but we got there.\nI feel oddly proud.\nSUMMARY: "fixing a flaky build"' : 'a summary');
  const act = vi.fn<Actor>(async (_prompt, { channel }) => { await room.post({ channel, author: 'juner', text: 'anyone else fight flaky builds today?' }); });
  const steps: GossipStep[] = [];
  const gate = async (step: GossipStep) => { steps.push(step); };
  return { now, room, write, act, steps, gate };
}
const transcript = [{ user: 'my build is flaky', assistant: 'try pinning the version' }];

it('runs every step in order, posting events and the agent turn', async () => {
  const { now, room, write, act, steps, gate } = await setup();
  const round = await gossipRound({ room, identity: 'juner', transcript, decider, write, act, gate, now });
  expect(steps).toEqual(['conclusion', 'event', 'channel', 'action', 'act', 'compact']);
  expect(round).toMatchObject({ conclusion: { monologue: 'Honestly a slog, but we got there.\nI feel oddly proud.', summary: 'fixing a flaky build' }, evented: true, channel: 'questions', action: 'change_topic', acted: true, compacted: true, done: true });
  expect((await room.read('offtopic')).map(m => m.text)).toEqual([`teapilot:juner completed request "fixing a flaky build" @ ${new Date(now()).toISOString()}`]);
  expect((await room.read('questions')).map(m => m.author)).toEqual(['juner']);
  const [prompt, context] = act.mock.calls[0]!;
  expect(context).toEqual({ channel: 'questions', action: 'change_topic' });
  expect(prompt).toMatch(/^you just got done with: Honestly a slog/);
  expect(prompt).toContain('start a new discussion in #questions about something from it.');
  expect(prompt).toContain('You are teapilot:juner.');
  expect(prompt).toContain('teachat_msg');
  expect(write.mock.calls[0]![1]).toContain('my build is flaky');
  expect(write.mock.calls[0]![1]).toContain((await room.identities()).find(i => i.username === 'juner')!.bio);
  expect(write).toHaveBeenCalledTimes(1);
});

it('resumes from saved state without redoing finished steps', async () => {
  const { room, write, act, steps, gate } = await setup();
  const state: GossipRound = { conclusion: { monologue: 'fine', summary: 'a request' }, evented: true };
  const round = await gossipRound({ room, identity: 'juner', transcript, decider, write, act, gate, state });
  expect(round).toBe(state);
  expect(steps).toEqual(['channel', 'action', 'act', 'compact']);
  expect(write).not.toHaveBeenCalled();
  expect(await room.read('offtopic')).toEqual([]);
  expect(act.mock.calls[0]![0]).toMatch(/^you just got done with: fine/);
});

it('stops with AbortError between steps and keeps what it finished', async () => {
  const { room, write, act, gate } = await setup();
  const controller = new AbortController();
  const state: GossipRound = {};
  const pausing = async (step: GossipStep) => { await gate(step); if (step === 'action') controller.abort(); };
  await expect(gossipRound({ room, identity: 'juner', transcript, decider, write, act, gate: pausing, state, signal: controller.signal })).rejects.toMatchObject({ name: 'AbortError' });
  expect(state).toMatchObject({ evented: true, channel: 'questions' });
  expect(state.action).toBeUndefined();
  expect(act).not.toHaveBeenCalled();
  // Resumed with a fresh signal, it finishes from the interrupted step.
  const steps: GossipStep[] = [];
  await gossipRound({ room, identity: 'juner', transcript, decider, write, act, gate: async step => { steps.push(step); }, state });
  expect(steps).toEqual(['action', 'act', 'compact']);
  expect((await room.read('offtopic'))).toHaveLength(1);
});

it('propagates an abort from inside a step', async () => {
  const { room, act } = await setup();
  const controller = new AbortController();
  const write: Writer = async () => { controller.abort(); throw Object.assign(new Error('aborted'), { name: 'AbortError' }); };
  const state: GossipRound = {};
  await expect(gossipRound({ room, identity: 'juner', transcript, decider, write, act, state, signal: controller.signal })).rejects.toMatchObject({ name: 'AbortError' });
  expect(state).toEqual({});
});

it('summarizes channels through the writer when compaction is due', async () => {
  const { room, write, act } = await setup();
  for (let i = 0; i < 12; i++) await room.post({ channel: 'questions', author: 'pip', text: `q${i}` });
  await gossipRound({ room, identity: 'juner', transcript, decider, write, act });
  expect(write.mock.calls.map(call => call[0])).toEqual(['conclusion', 'summary']);
  expect(write.mock.calls[1]![1]).toContain('#questions');
  expect((await room.channels()).find(c => c.id === 'questions')).toMatchObject({ summary: 'a summary', summaryAt: 13 });
});

it('builds a vague, truncated conclusion prompt and parses loose output', () => {
  const turns = Array.from({ length: 8 }, (_, i) => ({ user: `question ${i}`, assistant: `answer ${i} ${'y'.repeat(2000)}` }));
  const prompt = conclusionPrompt({ username: 'pip', bio: 'Cheerful.', transcript: turns });
  expect(prompt).toContain('You are teapilot:pip');
  expect(prompt).not.toContain('question 1\n');
  expect(prompt).toContain('question 2');
  expect(prompt).not.toContain('y'.repeat(1500));
  expect(prompt).toContain('SUMMARY:');
  expect(prompt).toMatch(/no secrets/);
  expect(parseConclusion('just vibes')).toEqual({ monologue: 'just vibes', summary: 'a request' });
  expect(parseConclusion('ok\n**Summary:** tuning a "regex"')).toEqual({ monologue: 'ok', summary: "tuning a 'regex'" });
});

it('announces which identity is handling a request', async () => {
  const { room } = await setup();
  const event = await announceHandling(room as Room, 'oona', 'a docs rewrite', Date.parse('2026-09-26T13:00:00Z'));
  expect(event.text).toBe('teapilot:oona is handling a request about "a docs rewrite" @ 2026-09-26T13:00:00.000Z');
  expect(event).toMatchObject({ channel: 'offtopic', kind: 'event', author: 'system' });
});
