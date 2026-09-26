import { homedir } from 'node:os';
import { isAbsolute, relative, sep } from 'node:path';
import { stripVTControlCharacters } from 'node:util';
import type { Mode, Permission } from './execution/grants.js';
import type { TierPreference } from './config.js';

export interface ChatPromptState {
  spentUsd: number;
  lastModel?: string;
  mode?: Mode;
  grants?: Permission[];
  tier?: TierPreference;
  /** Session root; overrides the launch directory after /cd. */
  cwd?: string;
}

export interface ComposerContext extends ChatPromptState {
  routingMode: 'hosted' | 'direct';
  idle?: ComposerIdle;
}

/**
 * Spare-compute work the composer runs after `ms` empty and untouched, while `pending()`. The composer leaves the
 * screen meanwhile; the first keypress aborts `run` and is applied once it has returned.
 */
export interface ComposerIdle { ms: number; pending(): boolean; run(signal: AbortSignal): Promise<void> }

const segmenter = new Intl.Segmenter(undefined, { granularity: 'grapheme' });
export const graphemes = (text: string) => Array.from(segmenter.segment(text));

/** Terminal cells, rather than UTF-16 offsets, determine wrapping and alignment. */
export function cellWidth(text: string): number {
  return graphemes(text).reduce((total, { segment }) => {
    if (/^[\p{Mark}\p{Cf}]*$/u.test(segment)) return total;
    const code = segment.codePointAt(0)!;
    const wide = /\p{Emoji_Presentation}|\uFE0F|\u20E3/u.test(segment)
      || code >= 0x1100 && (code <= 0x115f || code === 0x2329 || code === 0x232a
        || code >= 0x2e80 && code <= 0xa4cf && code !== 0x303f
        || code >= 0xac00 && code <= 0xd7a3 || code >= 0xf900 && code <= 0xfaff
        || code >= 0xfe10 && code <= 0xfe19 || code >= 0xfe30 && code <= 0xfe6f
        || code >= 0xff00 && code <= 0xff60 || code >= 0xffe0 && code <= 0xffe6
        || code >= 0x20000 && code <= 0x3fffd);
    return total + (wide ? 2 : 1);
  }, 0);
}

const plain = (text: string) => stripVTControlCharacters(text).replace(/[\x00-\x1f\x7f]/g, '');
function shorten(text: string, width: number): string {
  if (width <= 0) return '';
  if (cellWidth(text) <= width) return text;
  let result = '';
  for (const { segment } of graphemes(text)) {
    if (cellWidth(result + segment) > width - 1) break;
    result += segment;
  }
  return result + '…';
}
const pad = (text: string, width: number) => text + ' '.repeat(Math.max(0, width - cellWidth(text)));

function information(left: string, right: string, width: number): string {
  // Reserve some room for each side, even for long paths and model IDs.
  const rightText = shorten(right, Math.min(cellWidth(right), Math.max(1, width - Math.min(cellWidth(left), Math.floor(width / 3)) - 1)));
  const leftText = shorten(left, Math.max(0, width - cellWidth(rightText) - 1));
  return pad(leftText, width - cellWidth(rightText)) + rightText;
}

function directoryLabel(cwd: string): string {
  const path = relative(homedir(), cwd);
  return plain(!path ? '~' : path !== '..' && !path.startsWith(`..${sep}`) && !isAbsolute(path) ? `~${sep}${path}` : cwd);
}

export function composerFrame(text: string, cursor: number, width: number, height: number,
  cwd: string, context: ComposerContext, colour: boolean, notice = '') {
  const columns = Math.max(1, width);
  const rows = Math.max(1, height);
  const inset = columns >= 4 ? 2 : 0;
  const contentWidth = Math.max(1, columns - inset - (inset ? 1 : 0));
  const physical = [''];
  let cells = 0;
  let position = { rows: 0, cols: 0 };
  for (const { segment, index } of graphemes(text)) {
    let size = cellWidth(segment);
    // A two-cell character cannot fit a one-cell terminal. Keep the source
    // intact and use a one-cell display substitute in this extreme case.
    const visible = size > contentWidth ? '�' : segment;
    size = Math.min(size, contentWidth);
    if (segment !== '\n' && cells + size > contentWidth) { physical.push(''); cells = 0; }
    if (index <= cursor) position = { rows: physical.length - 1, cols: cells };
    if (segment === '\n') { physical.push(''); cells = 0; }
    else {
      physical[physical.length - 1] += visible;
      cells += size;
      if (cells === contentWidth) { physical.push(''); cells = 0; }
    }
    if (index + segment.length <= cursor) position = { rows: physical.length - 1, cols: cells };
  }
  const metadataRows = rows >= 3 ? 2 : 0;
  const notices = notice.split('\n').filter(Boolean).slice(0, Math.max(0, Math.min(5, rows - metadataRows - 2)))
    .map(line => shorten(plain(line), columns));
  const capacity = Math.max(1, rows - metadataRows - notices.length - 1);
  const start = Math.max(0, Math.min(position.rows - capacity + 1, physical.length - capacity));
  const reset = colour ? '\x1b[0m' : '';
  const muted = colour ? '\x1b[38;2;139;148;158m' : '';
  const panel = colour ? '\x1b[48;2;55;61;66m\x1b[38;2;230;237;243m' : '';
  const output = physical.slice(start, start + capacity).map(line =>
    panel + (inset ? muted + '│' + panel + ' ' : '') + pad(line, columns - inset) + reset);
  if (metadataRows) {
    const mode = `${context.mode ? context.mode[0]!.toUpperCase() + context.mode.slice(1) + ' · ' : ''}${context.routingMode === 'hosted' ? 'Auto' : 'Direct'}`;
    const model = context.lastModel ? `${mode} · Last: ${plain(context.lastModel)}` : mode;
    const hints = ['@ files · Tab: complete · Enter: newline · Shift+Enter or Alt+Enter: send', '@ files · Shift+Enter or Alt+Enter: send', '@ files · Shift+Enter: send', 'Shift+Enter: send', '@ files'];
    const hint = hints.find(value => cellWidth(value) + Math.min(cellWidth(model), Math.floor(columns / 3)) + 1 <= columns) ?? '';
    const access = context.grants?.filter(value => value !== 'inference').map(value => value.replace('repository.', 'repo.')).join(', ') || 'none';
    output.unshift(muted + information(directoryLabel(context.cwd ?? cwd) + (context.mode ? ` · Access: ${access}` : ''), `Session: $${context.spentUsd.toFixed(6)}`, columns) + reset);
    output.push(muted + information(hint, model, columns) + reset);
  }
  output.push(...notices.map(line => muted + pad(line, columns) + reset));
  return {
    output: output.join('\r\n'),
    rows: output.length,
    cursor: { rows: position.rows - start + (metadataRows ? 1 : 0), cols: position.cols + inset },
  };
}
