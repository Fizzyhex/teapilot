import { afterEach, expect, it, vi } from 'vitest';
import { statusLimit, statusText, StatusPresence } from '../src/discord/presence.js';

afterEach(() => { vi.useRealTimers(); });

it('lists only the stats that are above zero, separated by bullets', () => {
  expect(statusText({ games: 0, requests: 0, gossips: 0 })).toBeUndefined();
  expect(statusText({ games: 2, requests: 7, gossips: 3 })).toBe('🍵 running 2 games • handled 7 requests • gossipped 3 times :3');
  expect(statusText({ games: 1, requests: 0, gossips: 1 })).toBe('🍵 running 1 game • gossipped 1 time :3');
  expect(statusText({ games: 0, requests: 4, gossips: 0 })).toBe('🍵 handled 4 requests');
});

it('shows each change, and holds back updates that would break the rate limit', async () => {
  vi.useFakeTimers();
  const sent: Array<string | undefined> = [];
  const presence = new StatusPresence({ set: async text => { sent.push(text); } });
  // Nothing is sent before the gateway is up, and a fresh connection already shows no status.
  presence.handled();
  expect(sent).toEqual([]);
  presence.start();
  expect(sent).toEqual(['🍵 handled 1 request']);

  presence.games(1);
  expect(sent).toEqual(['🍵 handled 1 request', '🍵 running 1 game • handled 1 request']);
  // The window is full: these three changes wait, and only the latest counts go out.
  presence.handled();
  presence.games(2);
  presence.gossipped();
  expect(sent).toHaveLength(2);
  await vi.advanceTimersByTimeAsync(statusLimit.windowMs);
  expect(sent).toEqual(['🍵 handled 1 request', '🍵 running 1 game • handled 1 request', '🍵 running 2 games • handled 2 requests • gossipped 1 time :3']);

  // Back to nothing to say: the status is cleared rather than left behind.
  presence.games(0);
  presence.handled();
  await vi.advanceTimersByTimeAsync(statusLimit.windowMs);
  presence.close();
  expect(sent.at(-1)).toBe('🍵 handled 3 requests • gossipped 1 time :3');
});

it('sends nothing while every count stays at zero, and stops once closed', async () => {
  vi.useFakeTimers();
  const sent: Array<string | undefined> = [];
  const presence = new StatusPresence({ set: async text => { sent.push(text); } });
  presence.start();
  presence.games(0);
  expect(sent).toEqual([]);
  presence.handled();
  presence.close();
  presence.handled();
  await vi.advanceTimersByTimeAsync(statusLimit.windowMs * 2);
  expect(sent).toEqual(['🍵 handled 1 request']);
});
