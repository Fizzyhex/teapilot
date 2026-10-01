import { fences } from './chunk.js';

/** A GFM table. Cells keep their markdown, escapes included; every row is as wide as the header. */
export interface Table { header: string[]; rows: string[][]; source: string }
/** `![alt](ref)`, `![alt][ref]` or `![ref]`, and the markdown it was written as. */
export interface MediaRef { ref: string; alt?: string; source: string }
export type Block =
  | { type: 'text'; text: string }
  | { type: 'table'; table: Table }
  | { type: 'divider' }
  | { type: 'media'; items: MediaRef[] };

const thematic = /^ {0,3}(?:(?:-[ \t]*){3,}|(?:\*[ \t]*){3,}|(?:_[ \t]*){3,})$/;
const dashes = /^ {0,3}-+[ \t]*$/;
const equals = /^ {0,3}=+[ \t]*$/;
const delimiter = /^\s*\|?\s*:?-+:?\s*(?:\|\s*:?-+:?\s*)*\|?\s*$/;
const pipe = /(?<!\\)\|/;
const media = /!\[([^\]]*)\](?:\(\s*(<[^>]*>|[^\s)]+)(?:\s+(?:"[^"]*"|'[^']*'))?\s*\)|\[([^\]]+)\])?/g;

/** A line a setext underline would turn into a heading: plain paragraph text, not a list, quote, heading or fence. */
const paragraph = (line: string | undefined): line is string =>
  !!line?.trim() && !/^\s*(?:[-+*]\s|\d+[.)]\s|#|>|```|~~~|\|)/.test(line);

/** A table row's cells, without the outer pipes. */
export function cells(line: string): string[] {
  let row = line.trim();
  if (row.startsWith('|')) row = row.slice(1);
  if (row.endsWith('|') && !row.endsWith('\\|')) row = row.slice(0, -1);
  return row.split(pipe).map(cell => cell.trim());
}

/** Image and file references outside inline code and escaped markdown. */
function mediaParts(line: string): { start: number; end: number; item: MediaRef }[] {
  const code: { start: number; end: number }[] = [];
  const ticks = [...line.matchAll(/`+/g)];
  for (let at = 0; at < ticks.length; at++) {
    const opener = ticks[at]!;
    const close = ticks.findIndex((tick, index) => index > at && tick[0].length === opener[0].length);
    if (close < 0) continue;
    code.push({ start: opener.index, end: ticks[close]!.index + ticks[close]![0].length });
    at = close;
  }
  return [...line.matchAll(media)].flatMap(match => {
    const [source, alt, link, label] = match;
    const start = match.index;
    const end = start + source.length;
    if (code.some(span => start < span.end && end > span.start)
      || (line.slice(0, start).match(/\\+$/)?.[0].length ?? 0) % 2) return [];
    const ref = (link ?? label)?.replace(/^<|>$/g, '').trim();
    const item = ref ? { ref, alt: alt?.trim() || undefined, source }
      : alt?.trim() ? { ref: alt.trim(), source } : undefined;
    return item ? [{ start, end, item }] : [];
  });
}

/**
 * The parts of a markdown answer Discord can't show as text: tables, dividers, and images or files.
 * Everything else, code included, stays text. A setext heading becomes an ATX one, which Discord renders.
 */
export function parse(text: string): Block[] {
  const lines = text.split('\n');
  const blocks: Block[] = [];
  const fenced = fences();
  let pending: string[] = [];
  const flush = () => {
    while (pending.length && !pending[0]!.trim()) pending.shift();
    while (pending.length && !pending.at(-1)!.trim()) pending.pop();
    if (pending.length) blocks.push({ type: 'text', text: pending.join('\n') });
    pending = [];
  };
  for (let index = 0; index < lines.length; index++) {
    const line = lines[index]!;
    if (fenced.step(line)) { pending.push(line); continue; }
    const next = lines[index + 1];
    if (next !== undefined && pipe.test(line) && pipe.test(next) && delimiter.test(next)) {
      const header = cells(line);
      if (header.length === cells(next).length) {
        let end = index + 2;
        while (end < lines.length && lines[end]!.trim() && pipe.test(lines[end]!)) end++;
        const rows = lines.slice(index + 2, end).map(row => header.map((_, column) => cells(row)[column] ?? ''));
        flush();
        blocks.push({ type: 'table', table: { header, rows, source: lines.slice(index, end).join('\n') } });
        index = end - 1;
        continue;
      }
    }
    const previous = pending.at(-1);
    if ((dashes.test(line) || equals.test(line)) && paragraph(previous)) {
      pending[pending.length - 1] = `${equals.test(line) ? '#' : '##'} ${previous.trim()}`;
      continue;
    }
    if (thematic.test(line)) { flush(); blocks.push({ type: 'divider' }); continue; }
    const parts = mediaParts(line);
    if (parts.length) {
      let cursor = 0;
      for (const { start, end, item } of parts) {
        const before = line.slice(cursor, start);
        if (before.trim()) pending.push(before);
        const last = blocks.at(-1);
        // References separated only by whitespace are shown together.
        if (last?.type === 'media' && !pending.some(entry => entry.trim())) { pending = []; last.items.push(item); }
        else { flush(); blocks.push({ type: 'media', items: [item] }); }
        cursor = end;
      }
      const after = line.slice(cursor);
      if (after.trim()) pending.push(after);
      continue;
    }
    pending.push(line);
  }
  flush();
  return blocks;
}
