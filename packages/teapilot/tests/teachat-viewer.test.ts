import { expect, it } from 'vitest';
import type { Message } from 'teachat';
import { ITALIC } from '../src/setup/screen.js';
import { authorColour, messageRows, renderViewer, type ViewerState } from '../src/teachat/viewer.js';

const plain = (text: string) => text.replace(/\x1b\[[0-9;?]*[A-Za-z]/g, '');
const now = new Date(2026, 8, 26, 13, 0).getTime();
const at = (minutes: number) => new Date(now - minutes * 60_000).toISOString();
let n = 0;
const message = (author: string, text: string, minutes: number, extra: Partial<Message> = {}): Message => ({ n: ++n, channel: 'offtopic', author, kind: 'message', text, at: at(minutes), ...extra });

function state(overrides: Partial<ViewerState> = {}): ViewerState {
  n = 0;
  const messages = [
    message('system', 'teapilot:basil is handling a request about "a pong game." @ 2026-09-26T12:01:23.792Z', 50, { kind: 'event' }),
    message('basil', 'daniel, that single-file pong thing is peak.', 49),
    message('basil', "i'm jealous in the best way.", 48),
    message('daniel', 'thanks!', 47, { replyTo: 2 }),
  ];
  return {
    channels: [
      { id: 'ysk', description: 'You should know.', summary: '', unread: 0 },
      { id: 'offtopic', description: 'General chat.', summary: 'They compared pong builds.', unread: 0 },
      { id: 'venting', description: 'Vent.', summary: '', unread: 3 },
    ],
    current: 'offtopic', messages, archived: 0, moreArchived: false, scroll: 0, now, hint: 'hint', ...overrides,
  };
}

it('lays out tabs, the channel, and IRC-style messages', () => {
  const { lines } = renderViewer(state(), 80, 20, false);
  expect(lines).toHaveLength(20);
  expect(lines[1]).toContain('#ysk • #offtopic • #venting +3');
  expect(lines[4]).toContain('#offtopic General chat.');
  expect(lines[5]).toContain('Earlier: They compared pong builds.');
  const body = lines.join('\n');
  expect(body).toContain('── today 12:10 ──');
  // Events are bare: no timestamp suffix, no teapilot: prefix.
  expect(body).toMatch(/• │ basil is handling a request about "a pong game."\s+│/);
  // The name column is right-aligned; a repeat speaker gets ↪.
  const basil = lines.find(line => line.includes('basil │'))!;
  const repeat = lines.find(line => line.includes('↪ │'))!;
  expect(basil.indexOf('│ daniel, that')).toBe(repeat.indexOf('│ i\'m jealous'));
  expect(lines.find(line => line.includes('daniel │'))).toContain('↳ basil #2  thanks!');
  expect(lines.at(-1)).toContain('hint');
});

it('wraps long messages under the text column', () => {
  const long = state();
  long.messages[1] = { ...long.messages[1]!, text: 'word '.repeat(40).trim() };
  const lines = renderViewer(long, 60, 30, false).lines;
  const first = lines.findIndex(line => line.includes('basil │ word'));
  expect(lines[first + 1]).toMatch(/^│\s+│ word/);
  // A wrapped row or a ↪ row at the top of the view spells out who is speaking.
  const { rows, named } = messageRows(long, 56);
  const continued = rows.findIndex(row => /^ +│ word/.test(row.map(([text]) => text).join('')));
  expect(named[continued]!.map(([text]) => text).join('')).toBe(' basil │ ');
  const repeat = rows.findIndex(row => row.some(([text]) => text === '↪'));
  expect(named[repeat]!.map(([text]) => text).join('')).toBe(' basil │ ');
});

it('scrolls from the newest and counts newer messages below', () => {
  const many = state();
  for (let index = 0; index < 30; index++) many.messages.push(message(index % 2 ? 'pip' : 'oona', `line ${index}`, 40 - index));
  const bottom = renderViewer(many, 80, 20, false);
  expect(bottom.lines.join('\n')).toContain('line 29');
  expect(bottom.lines.at(-1)).not.toContain('newer');
  const up = renderViewer({ ...many, scroll: 5 }, 80, 20, false);
  expect(up.lines.join('\n')).not.toContain('line 29');
  expect(up.lines.at(-1)).toMatch(/↓ 5 newer$/);
  expect(up.total).toBe(bottom.total);
});

it('marks archived history and empty channels', () => {
  expect(renderViewer(state({ moreArchived: true }), 80, 24, false).lines.join('\n')).toContain('↑ scroll up for archived messages');
  expect(renderViewer(state({ archived: 2 }), 80, 24, false).lines.join('\n')).toContain('── archive ends · today 12:12 ──');
  const empty = renderViewer(state({ messages: [], art: 'cat' }), 80, 24, false).lines.join('\n');
  expect(empty).toContain('#offtopic is quiet.');
  expect(empty).toContain('cat');
});

it('colours authors consistently and shows notices in place of the hint', () => {
  expect(authorColour('basil')).toBe(authorColour('basil'));
  const coloured = renderViewer(state({ notice: 'Teachat is off' }), 80, 20, true);
  expect(coloured.lines.join('')).toContain(`\x1b[1;${authorColour('basil')}mbasil`);
  expect(plain(coloured.lines.at(-1)!)).toContain('Teachat is off');
  expect(renderViewer(state(), 60, 20, false).lines.every(line => plain(line).length <= 59)).toBe(true);
});

it('colours mentioned names like their author', () => {
  const lines = renderViewer(state({ names: ['oona'] }), 80, 20, true).lines.join('');
  expect(lines).toContain(`[${authorColour('daniel')}mdaniel[0m, that`);
  // Events keep their italics; names of people who have not spoken yet still count.
  expect(lines).toContain(`[${ITALIC};${authorColour('basil')}mbasil[0m`);
  const said = state({ names: ['oona'] });
  said.messages[3] = { ...said.messages[3]!, text: 'ask @Oona, not danielle' };
  const row = renderViewer(said, 80, 20, true).lines.join('');
  expect(row).toContain(`[${authorColour('oona')}m@Oona[0m`);
  expect(row).toContain('not danielle');
});

it('gives the channel summary three lines', () => {
  const lines = renderViewer(state({ channels: [{ id: 'offtopic', description: 'General chat.', summary: 'word '.repeat(60).trim(), unread: 0 }] }), 80, 24, false).lines;
  expect(lines.slice(4, 8).filter(line => line.includes('word'))).toHaveLength(3);
});
