import { expect, it } from 'vitest';
import { parse } from '../src/index.js';

it('finds tables, dividers and media, and leaves code fences alone', () => {
  const text = [
    'intro',
    '',
    '| a | b \\| c |',
    '|---|:-:|',
    '| 1 | `x` |',
    '| 2 |',
    '',
    '---',
    '![chart](chart.png)',
    '',
    '![script.py] ![b][b.png]',
    '```',
    '| x | y |',
    '|---|---|',
    '---',
    '![no](no.png)',
    '```',
  ].join('\n');
  expect(parse(text)).toEqual([
    { type: 'text', text: 'intro' },
    { type: 'table', table: { header: ['a', 'b \\| c'], rows: [['1', '`x`'], ['2', '']], source: '| a | b \\| c |\n|---|:-:|\n| 1 | `x` |\n| 2 |' } },
    { type: 'divider' },
    { type: 'media', items: [
      { ref: 'chart.png', alt: 'chart', source: '![chart](chart.png)' },
      { ref: 'script.py', source: '![script.py]' },
      { ref: 'b.png', alt: 'b', source: '![b][b.png]' },
    ] },
    { type: 'text', text: '```\n| x | y |\n|---|---|\n---\n![no](no.png)\n```' },
  ]);
});

it('reads a dashed line under a paragraph as a heading, as GFM does', () => {
  expect(parse('Title\n---\nbody')).toEqual([{ type: 'text', text: '## Title\nbody' }]);
  expect(parse('Title\n===')).toEqual([{ type: 'text', text: '# Title' }]);
  expect(parse('one\n\n---\n\ntwo')).toEqual([{ type: 'text', text: 'one' }, { type: 'divider' }, { type: 'text', text: 'two' }]);
  expect(parse('- item\n***')).toEqual([{ type: 'text', text: '- item' }, { type: 'divider' }]);
});

it('extracts inline images and files while keeping surrounding text in order', () => {
  expect(parse('see ![a][a.png] ![script.py] here')).toEqual([
    { type: 'text', text: 'see ' },
    { type: 'media', items: [{ ref: 'a.png', alt: 'a', source: '![a][a.png]' }, { ref: 'script.py', source: '![script.py]' }] },
    { type: 'text', text: ' here' },
  ]);
});

it('leaves inline code and escaped media as text', () => {
  const text = 'see `![a](a.png)` and `` ` ![script.py] `` and \\![b][b.png]';
  expect(parse(text)).toEqual([{ type: 'text', text }]);
});
