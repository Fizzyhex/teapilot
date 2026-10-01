import { expect, it } from 'vitest';
import { codeTable, markdownTable, tableEmbed, viewSource, type Table } from '../src/index.js';

const table = (header: string[], rows: string[][]): Table => ({ header, rows, source: markdownTable({ header, rows }) });

it('shows a narrow table as a field per column, and reads it back', () => {
  const narrow = table(['name', 'price'], [['tea', '**£2**'], ['', '\\| piped']]);
  const shown = tableEmbed(narrow)!;
  expect(shown.layout).toBe('columns');
  expect(shown.embed.fields).toEqual([
    { name: 'name', value: 'tea\n​', inline: true },
    { name: 'price', value: '**£2**\n\\| piped', inline: true },
  ]);
  expect(viewSource('pretty-send:table:columns', shown.embed)).toBe(narrow.source);
});

it('shows a wide table as a card per row, and reads it back', () => {
  const wide = table(['item', 'a', 'b', 'c'], [['tea', '1', '', '3'], ['', 'x', 'y', 'z']]);
  const shown = tableEmbed(wide)!;
  expect(shown.layout).toBe('rows');
  expect(shown.embed).toEqual({
    description: '-# item · a · b · c',
    fields: [{ name: 'tea', value: '**a**: 1\n**b**:\n**c**: 3', inline: true }, { name: '​', value: '**a**: x\n**b**: y\n**c**: z', inline: true }],
  });
  expect(viewSource('pretty-send:table:rows', shown.embed)).toBe(wide.source);
  expect(viewSource('other:rows', shown.embed)).toBeUndefined();
  expect(viewSource('pretty-send:table:sideways', shown.embed)).toBeUndefined();
});

it('falls back from columns to rows, and to nothing when Discord would cut the table short', () => {
  // 30 rows of long cells overflow a column's 1024 characters, and are more cards than an embed's 25 fields.
  const long = table(['a', 'b'], Array.from({ length: 30 }, (_, row) => [`row ${row} ${'x'.repeat(40)}`, 'y']));
  expect(tableEmbed(long)).toBeUndefined();
  const tall = table(['a', 'b'], Array.from({ length: 20 }, (_, row) => [`row ${row} ${'x'.repeat(60)}`, 'y']));
  expect(tableEmbed(tall)?.layout).toBe('rows');
  // A header the cards are read back by can't be a card.
  expect(tableEmbed(table(['**a**', 'b', 'c', 'd'], [['1', '2', '3', '4']]))).toBeUndefined();
  expect(tableEmbed(table(['a'], []))).toBeUndefined();
});

it('lines a table up in a code block', () => {
  expect(codeTable(table(['name', 'n'], [['tea', '10'], ['a\\|b', '']]))).toBe('```\nname | n\n-----|---\ntea  | 10\na|b  |\n```');
});
