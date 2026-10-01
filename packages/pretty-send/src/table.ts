import type { Table } from './parse.js';

export interface EmbedField { name: string; value: string; inline?: boolean }
/** The part of a Discord embed a table uses; a discord.js `Embed#toJSON()` fits it. */
export interface Embed { description?: string; fields?: EmbedField[] }
/** `columns`: a field per column, cells stacked. `rows`: a field per row, as a card of `**header**: cell` lines. */
export type TableLayout = 'columns' | 'rows';

export const defaultViewSourcePrefix = 'pretty-send:table:';
/** Discord drops empty field names and values; a zero-width space stands in for an empty cell. */
const blank = '​';
const show = (cell: string) => cell || blank;
const hide = (text: string) => text === blank ? '' : text;
/** Separates the headers a row layout lists in its description. */
const between = ' · ';
const limits = { fields: 25, name: 256, value: 1024, description: 4096, total: 6000 };
/** Side by side, embed fields fit three to a line. */
const inlinePerLine = 3;

function columns({ header, rows }: Pick<Table, 'header' | 'rows'>): Embed {
  return { fields: header.map((name, column) => ({ name: show(name), value: rows.map(row => show(row[column]!)).join('\n'), inline: true })) };
}
function cards({ header, rows }: Pick<Table, 'header' | 'rows'>): Embed {
  const [, ...rest] = header;
  return {
    description: `-# ${header.map(show).join(between)}`,
    fields: rows.map(([first, ...cells]) => ({
      name: show(first!), inline: true,
      value: rest.map((name, index) => `**${show(name)}**:${cells[index] ? ` ${cells[index]}` : ''}`).join('\n') || blank,
    })),
  };
}

function fits(embed: Embed): boolean {
  const fields = embed.fields ?? [];
  const description = embed.description?.length ?? 0;
  const total = description + fields.reduce((sum, field) => sum + field.name.length + field.value.length, 0);
  return fields.length > 0 && fields.length <= limits.fields && description <= limits.description && total <= limits.total
    && fields.every(field => field.name.length <= limits.name && field.value.length <= limits.value);
}

/** The table an embed shows, read back from its fields. */
function rebuild(embed: Embed, layout: TableLayout): Pick<Table, 'header' | 'rows'> | undefined {
  const fields = embed.fields ?? [];
  if (!fields.length) return undefined;
  if (layout === 'columns') {
    const stacks = fields.map(field => field.value.split('\n').map(hide));
    if (stacks.some(stack => stack.length !== stacks[0]!.length)) return undefined;
    return { header: fields.map(field => hide(field.name)), rows: stacks[0]!.map((_, row) => stacks.map(stack => stack[row]!)) };
  }
  const header = embed.description?.replace(/^-# /, '').split(between).map(hide);
  if (!header?.length) return undefined;
  const rows: string[][] = [];
  for (const field of fields) {
    const lines = header.length > 1 ? field.value.split('\n') : [];
    if (lines.length !== header.length - 1) return undefined;
    const cells = lines.map(line => line.match(/^\*\*(.*?)\*\*:(?: (.*))?$/));
    if (cells.some(match => !match)) return undefined;
    rows.push([hide(field.name), ...cells.map(match => match![2] ?? '')]);
  }
  return { header, rows };
}

const same = (a: Pick<Table, 'header' | 'rows'>, b: Pick<Table, 'header' | 'rows'> | undefined) => JSON.stringify([a.header, a.rows]) === JSON.stringify(b && [b.header, b.rows]);

/**
 * A table as embed fields: one per column when its columns fit side by side, otherwise one card per row. Undefined
 * when Discord would cut it short, or the embed could not be read back into the same table for "view source".
 */
export function tableEmbed(table: Table): { embed: Embed; layout: TableLayout } | undefined {
  if (!table.rows.length) return undefined;
  const choices: TableLayout[] = table.header.length <= inlinePerLine ? ['columns', 'rows'] : ['rows'];
  for (const layout of choices) {
    // A header holding the markup a card is read back by would be misread.
    if (layout === 'rows' && table.header.some(cell => cell.includes('**') || cell.includes(between.trim()))) continue;
    const embed = layout === 'columns' ? columns(table) : cards(table);
    if (fits(embed) && same(table, rebuild(embed, layout))) return { embed, layout };
  }
  return undefined;
}

/** A table as GFM markdown. Alignment isn't kept, so every column is left as written. */
export function markdownTable({ header, rows }: Pick<Table, 'header' | 'rows'>): string {
  const line = (row: string[]) => `| ${row.join(' | ')} |`;
  return [line(header), line(header.map(() => '---')), ...rows.map(line)].join('\n');
}

/** A table that can't be an embed, as a code block with its columns lined up. */
export function codeTable({ header, rows }: Pick<Table, 'header' | 'rows'>): string {
  const plain = [header, ...rows].map(row => row.map(cell => cell.replace(/\\\|/g, '|')));
  const widths = header.map((_, column) => Math.max(...plain.map(row => [...row[column]!].length)));
  const line = (row: string[]) => row.map((cell, column) => cell + ' '.repeat(widths[column]! - [...cell].length)).join(' | ').trimEnd();
  const body = [line(plain[0]!), widths.map(width => '-'.repeat(Math.max(1, width))).join('-|-'), ...plain.slice(1).map(line)].join('\n');
  const ticks = '`'.repeat(Math.max(3, ...[...body.matchAll(/`+/g)].map(match => match[0].length + 1)));
  return `${ticks}\n${body}\n${ticks}`;
}

/** The "view source" button under a table embed, as a raw action row. */
export function viewSourceRow(layout: TableLayout, prefix = defaultViewSourcePrefix) {
  return { type: 1, components: [{ type: 2, style: 2, label: 'view source', custom_id: `${prefix}${layout}` }] };
}

/** The markdown behind a pressed "view source" button; undefined if the button isn't one of these, or the embed no longer reads as a table. */
export function viewSource(customId: string, embed: Embed | undefined, prefix = defaultViewSourcePrefix): string | undefined {
  if (!customId.startsWith(prefix) || !embed) return undefined;
  const layout = customId.slice(prefix.length);
  if (layout !== 'columns' && layout !== 'rows') return undefined;
  const table = rebuild(embed, layout);
  return table && markdownTable(table);
}
