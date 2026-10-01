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

/** Every image or file reference on a line that holds nothing else. */
function mediaLine(line: string): MediaRef[] | undefined {
  if (!line.includes('![') || line.replace(media, '').trim()) return undefined;
  const items = [...line.matchAll(media)].flatMap(([source, alt, link, label]): MediaRef[] => {
    const ref = (link ?? label)?.replace(/^<|>$/g, '').trim();
    if (ref) return [{ ref, alt: alt?.trim() || undefined, source }];
    return alt?.trim() ? [{ ref: alt.trim(), source }] : [];
  });
  return items.length ? items : undefined;
}

/**
 * The parts of a markdown answer Discord can't show as text: tables, dividers, and images or files on lines of their
 * own. Everything else, code fences included, stays text. A setext heading becomes an ATX one, which Discord renders.
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
    const items = mediaLine(line);
    if (items) {
      const last = blocks.at(-1);
      // Images separated only by blank lines are shown together.
      if (last?.type === 'media' && !pending.some(entry => entry.trim())) { pending = []; last.items.push(...items); }
      else { flush(); blocks.push({ type: 'media', items }); }
      continue;
    }
    pending.push(line);
  }
  flush();
  return blocks;
}
