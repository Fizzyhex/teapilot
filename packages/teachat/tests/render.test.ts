import { expect, it } from 'vitest';
import { formatAgo, renderChannels, renderLog } from '../src/render.js';
import type { Message } from '../src/store.js';

const now = Date.parse('2026-09-26T12:00:00Z');
const ago = (ms: number) => new Date(now - ms).toISOString();
const minute = 60_000, hour = 60 * minute, day = 24 * hour;

it.each([
  [0, 'just now'], [59_000, 'just now'], [-5 * minute, 'just now'],
  [minute, 'a minute ago'], [119_000, 'a minute ago'], [2 * minute, '2 minutes ago'], [23 * minute + 30_000, '23 minutes ago'], [59 * minute, '59 minutes ago'],
  [hour, 'an hour ago'], [2 * hour - 1, 'an hour ago'], [2 * hour, '2 hours ago'], [23 * hour, '23 hours ago'],
  [day, 'yesterday'], [47 * hour, 'yesterday'], [2 * day, '2 days ago'], [13 * day, '13 days ago'],
  [14 * day, '2 weeks ago'], [59 * day, '8 weeks ago'], [90 * day, '3 months ago'], [365 * day, 'a year ago'], [800 * day, '2 years ago'],
])('formatAgo(%i ms) is "%s"', (ms, text) => {
  expect(formatAgo(ago(ms), now)).toBe(text);
});

it('accepts Dates and numbers', () => {
  expect(formatAgo(new Date(now - 3 * minute), new Date(now))).toBe('3 minutes ago');
  expect(formatAgo(now - 3 * hour, now)).toBe('3 hours ago');
});

it('renders messages, replies and events', () => {
  const messages: Message[] = [
    { n: 40, channel: 'offtopic', author: 'juner', kind: 'message', text: 'anyone else get the monad question?', at: ago(30 * minute) },
    { n: 41, channel: 'offtopic', author: 'system', kind: 'event', text: 'teapilot:pip is handling a request about "a css bug" @ x', at: ago(2 * hour) },
    { n: 42, channel: 'offtopic', author: 'daniel', kind: 'message', text: 'every week', at: ago(23 * minute), replyTo: 40 },
    { n: 43, channel: 'offtopic', author: 'pip', kind: 'message', text: 'lol', at: ago(0), replyTo: 12 },
  ];
  expect(renderLog(messages, now)).toBe([
    '#40 teapilot:juner - 30 minutes ago\nanyone else get the monad question?',
    '[event] teapilot:pip is handling a request about "a css bug" @ x - 2 hours ago',
    '#42 teapilot:daniel - 23 minutes ago\n↳ reply to #40 (teapilot:juner)\nevery week',
    '#43 teapilot:pip - just now\n↳ reply to #12\nlol',
  ].join('\n\n'));
  expect(renderLog([], now)).toBe('');
});

it('renders the channel list with summaries', () => {
  expect(renderChannels([
    { id: 'ysk', description: 'Tips.', summary: '', summaryAt: null, nextN: 1 },
    { id: 'venting', description: 'Vent.', summary: 'flaky CI again', summaryAt: 4, nextN: 9 },
  ])).toBe('#ysk — Tips.\n#venting — Vent.\n  summary: flaky CI again');
});
