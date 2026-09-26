import { CHANNEL_LIMIT, COMPACT_TARGET, RoomError, type Message, type Room } from './store.js';
import { clip } from './util.js';

/** Roughly what the `#42 teapilot:daniel - 23 minutes ago` header adds to each message. */
export const MESSAGE_OVERHEAD = 32;
export const SUMMARY_LIMIT = 300;
/** The summary is refreshed once this many messages have arrived since it was written. */
export const SUMMARY_EVERY = 10;

export const channelSize = (messages: readonly Message[]): number => messages.reduce((total, message) => total + message.text.length + MESSAGE_OVERHEAD, 0);

export type Summarizer = (previous: string, removed: Message[], remaining: Message[]) => Promise<string>;

/**
 * Keeps a channel's live log under CHANNEL_LIMIT: past it, the oldest messages move to the archive until the log is
 * at most COMPACT_TARGET. With a summarizer, the channel summary is refreshed after archiving and every
 * SUMMARY_EVERY messages; without one, it only archives.
 */
export async function compact(room: Room, channel: string, summarize?: Summarizer): Promise<{ archived: number; summarized: boolean }> {
  const live = await room.read(channel);
  let removed: Message[] = [];
  let size = channelSize(live);
  if (size > CHANNEL_LIMIT) {
    let count = 0;
    while (count < live.length && size > COMPACT_TARGET) size -= live[count++]!.text.length + MESSAGE_OVERHEAD;
    removed = await room.archive(channel, count);
  }
  if (!summarize) return { archived: removed.length, summarized: false };
  const meta = (await room.channels()).find(candidate => candidate.id === channel);
  if (!meta) throw new RoomError(`There is no channel #${channel}.`);
  const remaining = removed.length ? await room.read(channel) : live;
  const since = remaining.filter(message => message.n > (meta.summaryAt ?? 0)).length;
  if (!removed.length && since < SUMMARY_EVERY) return { archived: 0, summarized: false };
  const summary = clip(await summarize(meta.summary, removed, remaining), SUMMARY_LIMIT);
  if (!summary) return { archived: removed.length, summarized: false };
  const newest = remaining.at(-1)?.n ?? removed.at(-1)?.n ?? meta.summaryAt;
  await room.setSummary(channel, summary, newest);
  return { archived: removed.length, summarized: true };
}
