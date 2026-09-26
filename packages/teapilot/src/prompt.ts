import { readdir, realpath } from 'node:fs/promises';
import { resolve, relative, isAbsolute } from 'node:path';
import { emitKeypressEvents, type Key } from 'node:readline';
import { PassThrough } from 'node:stream';
import { StringDecoder } from 'node:string_decoder';
import { stripVTControlCharacters } from 'node:util';
import { cellWidth, composerFrame, graphemes, type ComposerContext } from './composer.js';
import { terminalColour } from './presentation.js';

export async function completeMention(text: string, cursor: number, cwd: string) {
  const match = /(?:^|\s)@("[^"\n]*|[^\s"@]*)$/.exec(text.slice(0, cursor));
  if (!match) return undefined;
  const token = match[1]!.replace(/^"/, '').replaceAll('\\', '/');
  const slash = token.lastIndexOf('/');
  const prefix = slash < 0 ? '' : token.slice(0, slash + 1);
  const name = token.slice(slash + 1);
  const root = await realpath(cwd);
  const directory = await realpath(resolve(root, prefix || '.')).catch(() => undefined);
  if (!directory) return { candidates: [] as string[] };
  const path = relative(root, directory);
  if (path === '..' || path.startsWith('../') || path.startsWith('..\\') || isAbsolute(path)) return { candidates: [] as string[] };
  const entries = await readdir(directory, { withFileTypes: true }).catch(() => []);
  const candidates = entries.filter(entry => !entry.isSymbolicLink() && (entry.isFile() || entry.isDirectory()) && entry.name.toLowerCase().startsWith(name.toLowerCase()) && !/[\x00-\x1f\x7f"]/.test(entry.name))
    .map(entry => prefix + entry.name + (entry.isDirectory() ? '/' : '')).sort();
  if (candidates.length !== 1) return { candidates };
  const candidate = candidates[0]!;
  const replacement = /\s/.test(candidate) ? `@"${candidate}${candidate.endsWith('/') ? '' : '"'}` : `@${candidate}`;
  const start = cursor - match[1]!.length - 1;
  return { candidates, text: text.slice(0, start) + replacement + text.slice(cursor), cursor: start + replacement.length };
}

export function isPromptSubmit(key: Key): boolean {
  return key.sequence === '\x1b[13;2u' || key.sequence === '\x1b[27;2;13~' || key.sequence === '\x1b\r' || Boolean(key.shift && key.name === 'return');
}

const COMPOSER_COLOUR = '\x1b[48;2;232;234;246m\x1b[38;2;35;38;52m';
const RESET_COLOUR = '\x1b[0m';

/** Build the editable prompt and its cursor position in terminal cells. */
export function promptFrame(label: string, text: string, cursor: number, width: number) {
  const columns = Math.max(1, width);
  if (!text.includes('\n')) {
    const prefix = label === '>' ? '> ' : `${label}: `;
    const before = prefix + text.slice(0, cursor);
    return {
      output: prefix + text,
      cursor: { rows: Math.floor(before.length / columns), cols: before.length % columns },
    };
  }

  // A multiline entry becomes a full-width composer. Explicitly paint every
  // cell so the background is consistent across short and wrapped lines.
  const physical: string[] = [];
  for (const line of text.split('\n')) {
    // Keep an empty physical row when the cursor lands exactly at the wrap.
    const count = Math.floor(line.length / columns) + 1;
    for (let index = 0; index < count; index++) physical.push(line.slice(index * columns, (index + 1) * columns).padEnd(columns));
  }
  const before = text.slice(0, cursor).split('\n');
  const cursorRow = 1 + before.slice(0, -1).reduce((total, line) => total + Math.floor(line.length / columns) + 1, 0)
    + Math.floor(before.at(-1)!.length / columns);
  const cursorCol = before.at(-1)!.length % columns;
  const blank = ' '.repeat(columns);
  return {
    output: [blank, ...physical, blank].map(line => COMPOSER_COLOUR + line + RESET_COLOUR).join('\r\n'),
    cursor: { rows: cursorRow, cols: cursorCol },
  };
}

/** Artwork above the composer, positioned relative to its live cursor. */
export interface ComposerArt {
  begin(cursor: () => { rows: number; cols: number }): void;
  end(submitted: boolean, occupiedRows: number): void;
}

/** A prompt editor owns raw input only while awaiting a user message. */
export async function promptInput(label: string, cwd: string, signal: AbortSignal, context?: ComposerContext, art?: ComposerArt): Promise<string> {
  signal.throwIfAborted();
  const input = new PassThrough();
  emitKeypressEvents(input);
  let text = '', cursor = 0, row = 0, finished = false, revision = 0;
  let pasted = false;
  let frameRows = 1;
  let cursorCols = 0;
  let activeNotice = '';
  let frameWidths: number[] = [];
  let frameColumns = process.stderr.columns || 80;
  const colour = terminalColour(process.stderr.isTTY) && !process.env.NODE_DISABLE_COLORS;
  const write = (value: string) => { process.stderr.write(value); };
  const render = (notice = '') => {
    activeNotice = notice;
    write('\r' + (row ? `\x1b[${row}A` : '') + '\x1b[J');
    if (context) {
      const frame = composerFrame(text, cursor, process.stderr.columns || 80, process.stderr.rows || 24, cwd, context, colour, notice);
      // Explicit physical rows avoid delayed autowrap at full-width edges.
      // Erase to the edge in the active background colour. Literal padding
      // spaces would reflow into extra blank lines when a terminal narrows.
      const physical = frame.output.split('\r\n').map(line => line.replace(/ +(\x1b\[0m)?$/, '\x1b[K$1'));
      frameWidths = physical.map(line => cellWidth(stripVTControlCharacters(line)));
      frameColumns = process.stderr.columns || 80;
      write(physical.join('\r\n'));
      frameRows = frame.rows;
      const distance = frame.rows - 1 - frame.cursor.rows;
      write('\r' + (distance > 0 ? `\x1b[${distance}A` : '') + (frame.cursor.cols ? `\x1b[${frame.cursor.cols}C` : ''));
      row = frame.cursor.rows; cursorCols = frame.cursor.cols;
      return;
    }
    const frame = promptFrame(label, text, cursor, process.stderr.columns || 80);
    const noticeText = notice ? '\r\n' + notice.replaceAll('\n', '\r\n') : '';
    write(frame.output.replaceAll(/(?<!\r)\n/g, '\r\n') + noticeText + ' ');
    const renderedRows = frame.output.split(/\r?\n/).length - 1 + (notice ? notice.split('\n').length : 0);
    const distance = renderedRows - frame.cursor.rows;
    write('\r' + (distance > 0 ? `\x1b[${distance}A` : '') + (frame.cursor.cols ? `\x1b[${frame.cursor.cols}C` : ''));
    row = frame.cursor.rows;
  };
  // While idle work runs the composer is off screen. Input keeps flowing in raw mode (handing stdin
  // back and forth races on Windows), is held, and is replayed once the work has stopped.
  let away: { stop: AbortController; held: Buffer[] } | undefined;
  const resize = () => {
    if (away) return;
    const columns = process.stderr.columns || 80;
    if (columns < frameColumns) {
      row = frameWidths.slice(0, row).reduce((total, width) => total + Math.max(1, Math.ceil(width / columns)), 0);
    }
    row = Math.min(row, Math.max(0, (process.stderr.rows || 24) - 1));
    render(activeNotice);
  };
  // The spacer row separates the composer from any artwork above it.
  const open = () => { if (context) { art?.begin(() => ({ rows: 1 + row, cols: cursorCols })); write('\r\n'); } };
  if (context) open();
  else write('\n\x1b[2mShift+Enter or Alt+Enter: send · Ctrl+D: exit\x1b[0m\n');
  // Kitty disambiguation and bracketed paste; pop the keyboard mode on exit.
  write('\x1b[>1u\x1b[?2004h');
  const raw = process.stdin.isRaw;
  process.stdin.setRawMode(true);
  render();
  if (context) process.stderr.on('resize', resize);
  try {
    return await new Promise<string>((done, reject) => {
      let idleTimer: NodeJS.Timeout | undefined;
      const finish = (error?: Error) => {
        if (finished) return;
        finished = true;
        clearTimeout(idleTimer);
        away?.stop.abort();
        process.stdin.removeListener('data', forward);
        process.stdin.removeListener('end', eof);
        signal.removeEventListener('abort', abort);
        cursor = text.length;
        render();
        if (context && frameRows - 1 > row) write(`\x1b[${frameRows - 1 - row}B`);
        write('\r\n');
        if (context) art?.end(!error, 1 + frameRows);
        if (error) reject(error); else done(text.trim());
      };
      const eof = () => { const error = new Error('Terminal closed'); error.name = 'TerminalClosedError'; finish(error); };
      const abort = () => finish(new DOMException('Cancelled', 'AbortError'));
      // Node's key decoder splits xterm's modifyOtherKeys sequence. Normalize
      // it before decoding, retaining partial sequences across input chunks.
      const decoder = new StringDecoder('utf8');
      const xtermEnter = '\x1b[27;2;13~';
      let pending = '';
      const forward = (chunk: Buffer) => {
        if (away) { away.held.push(chunk); away.stop.abort(); return; }
        pending += decoder.write(chunk);
        pending = pending.replaceAll(xtermEnter, '\x1b[13;2u');
        let held = Math.min(pending.length, xtermEnter.length - 1);
        while (held && !xtermEnter.startsWith(pending.slice(-held))) held--;
        const ready = pending.slice(0, pending.length - held);
        pending = pending.slice(pending.length - held);
        if (ready) input.write(ready);
      };
      const idle = context?.idle;
      const armIdle = () => {
        clearTimeout(idleTimer);
        if (!idle || text || away) return;
        idleTimer = setTimeout(() => {
          if (finished || text || away || !idle.pending()) return;
          // Nothing typed: take the composer and its spacer row off screen while the idle work runs.
          write('\r' + (row ? `\x1b[${row}A` : '') + '\x1b[J\x1b[1A\x1b[J');
          art?.end(false, 0);
          const current = away = { stop: new AbortController(), held: [] as Buffer[] };
          void idle.run(current.stop.signal).catch(() => {}).finally(() => {
            away = undefined;
            if (finished) return;
            row = 0; open(); render();
            for (const chunk of current.held) forward(chunk);
            if (!current.held.length) armIdle();
          });
        }, idle.ms);
      };
      armIdle();
      input.on('keypress', (value: string | undefined, key: Key) => {
        if (finished) return;
        clearTimeout(idleTimer);
        if (key.sequence === '\x1b[200~') { pasted = true; return; }
        if (key.sequence === '\x1b[201~') { pasted = false; return; }
        if (!pasted && isPromptSubmit(key)) { finish(); return; }
        if (!pasted && key.ctrl && key.name === 'c') { abort(); return; }
        if (!pasted && key.ctrl && key.name === 'd' && !text) { eof(); return; }
        if (!pasted && key.name === 'tab') {
          const version = revision;
          void completeMention(text, cursor, cwd).then(result => {
            if (finished || revision !== version || !result) return;
            if (result.text !== undefined) { text = result.text; cursor = result.cursor!; revision++; render(); }
            else render(result.candidates.length ? result.candidates.slice(0, 30).join('\n') + (result.candidates.length > 30 ? '\nMore matches; type a narrower path.' : '') : 'No matching files.');
          }).catch(() => { if (!finished && revision === version) render('Could not list files.'); });
          return;
        }
        revision++;
        const boundaries = graphemes(text).map(part => part.index);
        const previous = boundaries.findLast(index => index < cursor) ?? 0;
        const next = boundaries.find(index => index > cursor) ?? text.length;
        if (!pasted && key.name === 'left') cursor = previous;
        else if (!pasted && key.name === 'right') cursor = next;
        else if (!pasted && key.name === 'home') cursor = cursor ? text.lastIndexOf('\n', cursor - 1) + 1 : 0;
        else if (!pasted && key.name === 'end') { const end = text.indexOf('\n', cursor); cursor = end < 0 ? text.length : end; }
        else if (!pasted && key.name === 'backspace') { if (cursor) { text = text.slice(0, previous) + text.slice(cursor); cursor = previous; } }
        else if (!pasted && key.name === 'delete') text = text.slice(0, cursor) + text.slice(next);
        else {
          const inserted = key.name === 'return' || key.name === 'enter' ? '\n' : value && !key.ctrl && !key.meta ? stripVTControlCharacters(value).replace(/[\x00-\x1f\x7f]/g, '') : '';
          text = text.slice(0, cursor) + inserted + text.slice(cursor); cursor += inserted.length;
        }
        armIdle();
        render();
      });
      process.stdin.on('data', forward);
      process.stdin.once('end', eof);
      signal.addEventListener('abort', abort, { once: true });
      process.stdin.resume();
      if (signal.aborted) abort();
    });
  } finally {
    process.stderr.removeListener('resize', resize);
    write('\x1b[<u\x1b[?2004l');
    // Stop reading before leaving raw mode: on Windows, switching modes mid-read restarts it as a
    // line-mode console read that cannot be cancelled and swallows later keys as cooked input.
    process.stdin.pause();
    process.stdin.setRawMode(raw ?? false);
    input.destroy();
  }
}
