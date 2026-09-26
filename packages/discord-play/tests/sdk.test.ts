import { expect, it } from 'vitest';
import { after, app, button, cancel, consult, embed, ephemeral, field, finish, grid, meter, modal, row, select, spoiler, step, text } from '../src/index.js';

it('builds plain data that survives JSON', () => {
  const view = {
    content: text('Round 1', false, 'Pick one'),
    embeds: [embed({ title: 'Board', color: 'green', description: grid([[0, 1], [1, 0]], { 0: '⬛', 1: '🟥' }) })],
    rows: [
      row(button('a', 'A', { style: 'primary' }), button('guess', 'Guess', { opens: modal('answer', 'Your answer', [field('word', 'Word', { max: 20 })]) })),
      row(select('pick', ['red', { value: 'blue', label: 'Blue', emoji: '🟦' }], { placeholder: 'Colour' })),
    ],
  };
  expect(JSON.parse(JSON.stringify(view))).toEqual(view);
  expect(view.content).toBe('Round 1\nPick one');
  expect(view.embeds[0]!.description).toBe('⬛🟥\n🟥⬛');
  expect(view.rows[1]!.controls[0]).toEqual({ type: 'select', id: 'pick', placeholder: 'Colour', options: [{ value: 'red', label: 'red' }, { value: 'blue', label: 'Blue', emoji: '🟦' }] });
});

it('describes effects and steps', () => {
  expect(step({ n: 1 }, ephemeral('hi'), after(1000, 'tick'), cancel('tick'), consult('judge', 'is it right?'), finish('done'))).toEqual({
    type: 'step', state: { n: 1 },
    effects: [{ type: 'ephemeral', content: 'hi' }, { type: 'after', id: 'tick', ms: 1000 }, { type: 'cancel', id: 'tick' }, { type: 'consult', id: 'judge', prompt: 'is it right?' }, { type: 'finish', summary: 'done' }],
  });
  expect(finish()).toEqual({ type: 'finish' });
});

it('renders meters and spoilers', () => {
  expect(meter(3, 10, 5)).toBe('🟩🟩⬛⬛⬛');
  expect(meter(20, 10, 3)).toBe('🟩🟩🟩');
  expect(meter(1, 0, 2)).toBe('⬛⬛');
  expect(spoiler('a||b')).toBe('||a| |b||');
});

it('returns the app definition unchanged', () => {
  const definition = { init: () => 0, update: (state: number) => state + 1, view: (state: number) => ({ content: String(state) }) };
  expect(app(definition)).toBe(definition);
});
