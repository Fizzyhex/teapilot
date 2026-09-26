import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { expect, it, vi } from 'vitest';
import { channelSize, compact, MESSAGE_OVERHEAD, SUMMARY_LIMIT, type Summarizer } from '../src/compact.js';
import { CHANNEL_LIMIT, COMPACT_TARGET, openRoom, type Room } from '../src/store.js';
import { directory } from './helpers.js';

const fill = async (room: Room, channel: string, count: number, length: number) => {
  for (let i = 0; i < count; i++) await room.post({ channel, author: 'marlow', text: `${i}`.padEnd(length, 'x') });
};
const meta = async (room: Room, id: string) => (await room.channels()).find(c => c.id === id)!;

it('leaves a channel under the limit alone', async () => {
  const room = await openRoom({ dir: await directory() });
  await fill(room, 'venting', 8, 900);
  expect(channelSize(await room.read('venting'))).toBe(8 * (900 + MESSAGE_OVERHEAD));
  expect(channelSize(await room.read('venting'))).toBeLessThanOrEqual(CHANNEL_LIMIT);
  const summarize = vi.fn<Summarizer>(async () => 'unused');
  expect(await compact(room, 'venting', summarize)).toEqual({ archived: 0, summarized: false });
  expect(summarize).not.toHaveBeenCalled();
});

it('archives the oldest messages down to the target without a summarizer', async () => {
  const dir = await directory();
  const room = await openRoom({ dir });
  await fill(room, 'venting', 9, 950);
  expect(await compact(room, 'venting')).toEqual({ archived: 3, summarized: false });
  const live = await room.read('venting');
  expect(live.map(m => m.n)).toEqual([4, 5, 6, 7, 8, 9]);
  expect(channelSize(live)).toBeLessThanOrEqual(COMPACT_TARGET);
  const archive = (await readFile(join(dir, 'channels', 'venting.archive.jsonl'), 'utf8')).trim().split('\n').map(line => JSON.parse(line).n);
  expect(archive).toEqual([1, 2, 3]);
  expect((await meta(room, 'venting')).summary).toBe('');
});

it('folds archived messages into a clipped summary', async () => {
  const room = await openRoom({ dir: await directory() });
  await room.setSummary('venting', 'older gripes', 0);
  await fill(room, 'venting', 9, 950);
  const summarize = vi.fn<Summarizer>(async () => `${'long summary words '.repeat(40)}`);
  expect(await compact(room, 'venting', summarize)).toEqual({ archived: 3, summarized: true });
  const [previous, removed, remaining] = summarize.mock.calls[0]!;
  expect(previous).toBe('older gripes');
  expect(removed.map(m => m.n)).toEqual([1, 2, 3]);
  expect(remaining.map(m => m.n)).toEqual([4, 5, 6, 7, 8, 9]);
  const after = await meta(room, 'venting');
  expect(after.summary.length).toBeLessThanOrEqual(SUMMARY_LIMIT);
  expect(after.summary.endsWith('…')).toBe(true);
  expect(after.summaryAt).toBe(9);
});

it('refreshes the summary every ten messages', async () => {
  const room = await openRoom({ dir: await directory() });
  const summarize = vi.fn<Summarizer>(async (_previous, _removed, remaining) => `about ${remaining.length} messages`);
  await fill(room, 'ysk', 9, 20);
  expect(await compact(room, 'ysk', summarize)).toEqual({ archived: 0, summarized: false });
  await fill(room, 'ysk', 1, 20);
  expect(await compact(room, 'ysk', summarize)).toEqual({ archived: 0, summarized: true });
  expect(await meta(room, 'ysk')).toMatchObject({ summary: 'about 10 messages', summaryAt: 10 });
  await fill(room, 'ysk', 9, 20);
  expect((await compact(room, 'ysk', summarize)).summarized).toBe(false);
  await fill(room, 'ysk', 1, 20);
  expect((await compact(room, 'ysk', summarize)).summarized).toBe(true);
  expect((await meta(room, 'ysk')).summaryAt).toBe(20);
  expect(summarize).toHaveBeenCalledTimes(2);
});
