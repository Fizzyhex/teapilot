import { button, embed, field, modal, row, select } from '@teapilot/discord-play';
import { expect, it } from 'vitest';
import { describe as preview, findControl, parseCustomId, renderModal, renderView } from '../src/discord/play/render.js';
import { checkMessage, checkModal } from '../scripts/discord-sim/validate.js';

it('renders a view as Discord API JSON with namespaced custom ids', () => {
  const payload = renderView('abc123', {
    content: 'hi',
    embeds: [embed({ title: 'Board', color: 'red', fields: [{ name: 'Turn', value: 'X', inline: true }], footer: 'round 1' })],
    rows: [row(button('go', 'Go', { style: 'success', emoji: '<:tea:123456789012345678>' }), button('docs', 'Docs', { url: 'https://example.com' })), row(select('pick', ['a', 'b'], { max: 2 }))],
  });
  expect(payload).toEqual({
    content: 'hi', allowedMentions: { parse: [] },
    embeds: [{ title: 'Board', color: 0xed4245, fields: [{ name: 'Turn', value: 'X', inline: true }], footer: { text: 'round 1' } }],
    components: [
      { type: 1, components: [
        { type: 2, style: 3, label: 'Go', emoji: { id: '123456789012345678', name: 'tea', animated: false }, custom_id: 'play:abc123:go' },
        { type: 2, style: 5, label: 'Docs', url: 'https://example.com' },
      ] },
      { type: 1, components: [{ type: 3, custom_id: 'play:abc123:pick', options: [{ value: 'a', label: 'a' }, { value: 'b', label: 'b' }], min_values: 1, max_values: 2 }] },
    ],
  });
  expect(() => checkMessage(payload)).not.toThrow();
  expect(parseCustomId('play:abc123:go')).toEqual({ playId: 'abc123', id: 'go' });
  expect(parseCustomId('teapilot:nonce:approve')).toBeUndefined();
});

it('sends emoji-only buttons without a blank label', () => {
  const payload = renderView('a1', { rows: [row(button('c0', ' ', { emoji: '⬛' }), button('c1', ' ', { emoji: '1️⃣' }), button('c2', ' ', { emoji: '❤' }))] });
  expect(payload.components[0]!.components[0]).toEqual({ type: 2, style: 2, emoji: { name: '⬛' }, custom_id: 'play:a1:c0' });
  expect(() => checkMessage(payload)).not.toThrow();
});

it('refuses emoji Discord would refuse, such as a shortcode or a name', () => {
  for (const emoji of [':tea:', 'tea', '🍵🍵']) expect(() => renderView('a1', { rows: [row(button('c0', 'Go', { emoji }))] })).toThrow(/not one Unicode emoji/);
});

it('disables every control for a finished app, but keeps link buttons', () => {
  const payload = renderView('a1', { rows: [row(button('x', 'X'), button('site', 'Site', { url: 'https://example.com' }))] }, true);
  expect(payload.components[0]!.components).toEqual([
    { type: 2, style: 2, label: 'X', custom_id: 'play:a1:x', disabled: true },
    { type: 2, style: 5, label: 'Site', url: 'https://example.com' },
  ]);
});

it.each([
  ['too many rows', { rows: Array.from({ length: 6 }, (_, i) => row(button(`b${i}`, 'B'))) }, /rows has 6 entries/],
  ['too many buttons', { rows: [row(...Array.from({ length: 6 }, (_, i) => button(`b${i}`, 'B')))] }, /Row 1 has 6 entries/],
  ['a select sharing a row', { rows: [row(select('s', ['a']), button('b', 'B'))] }, /must be alone/],
  ['a duplicate id', { rows: [row(button('b', 'B'), button('b', 'C'))] }, /used twice/],
  ['a bad id', { rows: [row(button('has space', 'B'))] }, /letters, digits/],
  ['long content', { content: 'x'.repeat(2001) }, /Discord allows 2000/],
  ['a long label', { rows: [row(button('b', 'x'.repeat(81)))] }, /Discord allows 80/],
  ['an unlabeled button', { rows: [row(button('b', ' '))] }, /label or an emoji/],
  ['an empty view', {}, /nothing to show/],
  ['too much embed text', { embeds: [embed({ description: 'x'.repeat(4000) }), embed({ description: 'x'.repeat(2500) })] }, /6000/],
  ['a bad colour', { embeds: [embed({ title: 't', color: 'mauve' })] }, /Embed color/],
  ['a raw object', { rows: [{ controls: [] }] }, /built with row/],
])('refuses %s', (_name, view, error) => {
  expect(() => renderView('p1', view)).toThrow(error);
});

it('renders modals and checks their fields', () => {
  expect(() => checkModal(renderModal('p1', modal('guess', 'Your guess', [field('word', 'Word', { max: 5, required: false })])))).not.toThrow();
  expect(renderModal('p1', modal('guess', 'Your guess', [field('word', 'Word', { max: 5, required: false }), field('why', 'Why', { style: 'paragraph' })]))).toEqual({
    custom_id: 'play:p1:guess', title: 'Your guess',
    components: [
      { type: 1, components: [{ type: 4, custom_id: 'word', label: 'Word', style: 1, required: false, max_length: 5 }] },
      { type: 1, components: [{ type: 4, custom_id: 'why', label: 'Why', style: 2 }] },
    ],
  });
  expect(() => renderModal('p1', modal('m', 'x'.repeat(46), [field('a', 'A')]))).toThrow(/Discord allows 45/);
  expect(() => renderModal('p1', modal('m', 'M', []))).toThrow(/at least one field/);
  // A modal behind a button is checked when the view renders, not only when someone clicks.
  expect(() => renderView('p1', { rows: [row(button('open', 'Open', { opens: modal('m', 'M', []) }))] })).toThrow(/at least one field/);
});

it('finds controls and previews a view as text', () => {
  const view = { content: 'Pick', rows: [row(button('a', 'A', { opens: modal('m', 'M', [field('f', 'F')]) }), button('site', 'Site', { url: 'https://example.com' })), row(select('s', ['x', 'y']))] };
  expect(findControl(view, 'a')?.type).toBe('button');
  expect(findControl(view, 's')?.type).toBe('select');
  expect(findControl(view, 'missing')).toBeUndefined();
  expect(preview(view)).toBe('Pick\n[A](a → modal m) [Site](https://example.com)\n<select s: x|y>');
});
