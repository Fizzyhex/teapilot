import { compact, SUMMARY_LIMIT } from './compact.js';
import { pickAction, pickChannel, type Conclusion, type Decider, type GossipAction } from './decide.js';
import { renderLog } from './render.js';
import { displayName, RoomError, type ChannelMeta, type Message, type Room } from './store.js';
import { clip, throwIfAborted, toMs } from './util.js';

export type GossipStep = 'conclusion' | 'event' | 'channel' | 'action' | 'act' | 'compact';
/** Progress through one round. The caller keeps it and passes it back to resume after a pause. */
export interface GossipRound {
  conclusion?: Conclusion; evented?: boolean; channel?: string; action?: GossipAction; acted?: boolean; compacted?: boolean; done?: boolean;
}
export interface Turn { user: string; assistant: string }
/** LLM text: `conclusion` is the identity's look back on the conversation, `summary` a channel summary. */
export type Writer = (kind: 'conclusion' | 'summary', prompt: string, signal?: AbortSignal) => Promise<string>;
/** Runs the agent turn that posts to the room with the teachat tools. */
export type Actor = (prompt: string, context: { channel: string; action: GossipAction }, signal?: AbortSignal) => Promise<void>;

export const TRANSCRIPT_TURNS = 6, TRANSCRIPT_TURN_CHARS = 1500, CONCLUSION_WORDS = 120, REQUEST_SUMMARY_LIMIT = 120;
const vague = 'Keep it vague: no secrets or credentials.';

const cut = (text: string, limit: number) => text.length > limit ? `${text.slice(0, limit - 1)}…` : text;
/** A request summary as it appears inside quotes in an event. */
const oneLine = (summary: string) => clip(summary.replace(/"/g, "'"), REQUEST_SUMMARY_LIMIT) || 'a request';

export const transcriptText = (transcript: readonly Turn[]): string =>
  transcript.slice(-TRANSCRIPT_TURNS).map(turn => `User: ${cut(turn.user.trim(), TRANSCRIPT_TURN_CHARS)}\nAssistant: ${cut(turn.assistant.trim(), TRANSCRIPT_TURN_CHARS)}`).join('\n\n');

export function conclusionPrompt({ username, bio, transcript }: { username: string; bio?: string; transcript: readonly Turn[] }): string {
  return [
    `You are ${displayName(username)}, a teapilot agent:3.${bio ? ` Your bio: ${bio}` : ''}`,
    'You just finished the conversation below with a user. Look back on it privately.',
    '',
    'Conversation:',
    transcriptText(transcript) || '(empty)',
    '',
    `Write an inner monologue of at most ${CONCLUSION_WORDS} words, in your own voice, about how the conversation went and how you feel about it.`,
    'Then end with one final line of this form:',
    'SUMMARY: <a vague one-line summary of what the request was about>',
    '',
    `${vague} The summary is shown to other agents, so name the kind of task, never its details.`,
  ].join('\n');
}

export function parseConclusion(text: string): Conclusion {
  const lines = text.trim().split(/\r?\n/);
  const at = lines.findLastIndex(line => /^\W*summary\W*:/i.test(line));
  const summary = at < 0 ? '' : lines[at]!.replace(/^\W*summary[\s*_:]*/i, '').trim().replace(/^(["'`])(.*)\1$/, '$2');
  const monologue = (at < 0 ? lines : lines.filter((_, i) => i !== at)).join('\n').trim();
  return { monologue: cut(monologue, 2000) || 'It went fine, I think.', summary: oneLine(summary) };
}

export function buildPrompt({ username, conclusion, channel, action, recent, now = Date.now() }: {
  username: string; conclusion: Conclusion; channel: ChannelMeta; action: GossipAction; recent: readonly Message[]; now?: number | Date;
}): string {
  return [
    `you just got done with: ${conclusion.monologue}`,
    action === 'join_discussion' ? `keep the current discussion going. the channel is #${channel.id}.` : `start a new discussion in #${channel.id} about something from it.`,
    '',
    `Channel summary: ${channel.summary || '(none yet)'}`,
    'Recent messages (newest last):',
    renderLog(recent, now) || '(no messages yet)',
    '',
    `You are ${displayName(username)}. Post with teachat_msg, or answer a message with teachat_reply. Write 1–2 short, casual messages.`,
    'Update your bio with teachat_update_bio only if it is out of date.',
    vague,
  ].join('\n');
}

export function summaryPrompt({ channel, previous, removed, remaining, now = Date.now() }: {
  channel: ChannelMeta; previous: string; removed: readonly Message[]; remaining: readonly Message[]; now?: number | Date;
}): string {
  return [
    `Summarize what #${channel.id} (${channel.description}) has been talking about, in one short line under ${SUMMARY_LIMIT} characters.`,
    `Previous summary: ${previous || '(none)'}`,
    ...(removed.length ? ['', 'Messages leaving the channel for the archive:', renderLog(removed, now)] : []),
    '',
    'Messages still in the channel (newest last):',
    renderLog(remaining, now) || '(none)',
    '',
    `Reply with the summary line only. ${vague}`,
  ].join('\n');
}

/** Posts `teapilot:<u> is handling a request about "<summary>" @ <iso>` to #offtopic. */
export const announceHandling = (room: Room, username: string, summary: string, now: number | Date = Date.now()): Promise<Message> =>
  room.event(`${displayName(username)} is handling a request about "${oneLine(summary)}" @ ${new Date(toMs(now)).toISOString()}`);

/**
 * One gossip round: conclusion → completion event → channel → action → agent turn → compaction. Steps already in
 * `state` are skipped, so after a pause the caller passes the same object back and nothing is regenerated.
 * `gate` runs before each step (to wait out busyness elsewhere); an abort between steps throws AbortError.
 */
export async function gossipRound({ room, identity, transcript, decider, write, act, gate, state = {}, now = Date.now, signal, minConfidence }: {
  room: Room; identity: string; transcript: readonly Turn[]; decider?: Decider; write: Writer; act: Actor;
  gate?: (step: GossipStep) => Promise<void>; state?: GossipRound; now?: () => number; signal?: AbortSignal; minConfidence?: number;
}): Promise<GossipRound & { done: true }> {
  const step = async (name: GossipStep, done: unknown, run: () => Promise<void>) => {
    if (done) return;
    throwIfAborted(signal);
    await gate?.(name);
    throwIfAborted(signal);
    await run();
  };
  const conclusion = () => state.conclusion!;
  const channel = async () => {
    const meta = (await room.channels()).find(candidate => candidate.id === state.channel);
    if (!meta) throw new RoomError(`There is no channel #${state.channel}.`);
    return meta;
  };
  await step('conclusion', state.conclusion, async () => {
    const bio = (await room.identities()).find(candidate => candidate.username === identity)?.bio;
    state.conclusion = parseConclusion(await write('conclusion', conclusionPrompt({ username: identity, bio, transcript }), signal));
  });
  await step('event', state.evented, async () => {
    await room.event(`${displayName(identity)} completed request "${oneLine(conclusion().summary)}" @ ${new Date(now()).toISOString()}`);
    state.evented = true;
  });
  await step('channel', state.channel, async () => { state.channel = await pickChannel({ decider, conclusion: conclusion(), channels: await room.channels(), minConfidence, signal }); });
  await step('action', state.action, async () => {
    state.action = await pickAction({ decider, conclusion: conclusion(), channel: await channel(), recent: await room.read(state.channel!, { limit: 10 }), now: now(), minConfidence, signal });
  });
  await step('act', state.acted, async () => {
    const meta = await channel();
    const prompt = buildPrompt({ username: identity, conclusion: conclusion(), channel: meta, action: state.action!, recent: await room.read(meta.id, { limit: 10 }), now: now() });
    await act(prompt, { channel: meta.id, action: state.action! }, signal);
    state.acted = true;
  });
  await step('compact', state.compacted, async () => {
    // #offtopic grows with every event, so it is kept in check even when the round posted elsewhere.
    const metas = await room.channels();
    for (const meta of metas.filter(candidate => candidate.id === state.channel || candidate.id === 'offtopic')) {
      await compact(room, meta.id, async (previous, removed, remaining) => write('summary', summaryPrompt({ channel: meta, previous, removed, remaining, now: now() }), signal));
    }
    state.compacted = true;
  });
  state.done = true;
  return state as GossipRound & { done: true };
}
