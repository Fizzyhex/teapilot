import { readdir, realpath } from 'node:fs/promises';
import { resolve, relative, isAbsolute } from 'node:path';
import { emitKeypressEvents, type Key } from 'node:readline';
import { PassThrough } from 'node:stream';
import { StringDecoder } from 'node:string_decoder';
import { stripVTControlCharacters } from 'node:util';

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

/** A prompt editor owns raw input only while awaiting a user message. */
export async function promptInput(label: string, cwd: string, signal: AbortSignal): Promise<string> {
  signal.throwIfAborted();
  const input = new PassThrough();
  emitKeypressEvents(input);
  let text = '', cursor = 0, row = 0, finished = false, revision = 0;
  let pasted = false;
  const write = (value: string) => { process.stderr.write(value); };
  const position = (value: string) => {
    let rows = 0, cols = 0;
    const width = process.stderr.columns || 80;
    for (const char of value) {
      if (char === '\n') { rows++; cols = 0; }
      else { cols++; if (cols >= width) { rows++; cols = 0; } }
    }
    return { rows, cols };
  };
  const render = (notice = '') => {
    write('\r' + (row ? `\x1b[${row}A` : '') + '\x1b[J');
    const prefix = label === '>' ? '> ' : `${label}: `;
    const full = prefix + text;
    const target = position(prefix + text.slice(0, cursor));
    write(full.replaceAll('\n', '\r\n') + (notice ? '\r\n' + notice.replaceAll('\n', '\r\n') : '') + ' ');
    const actualEnd = position(full + (notice ? '\n' + notice : '') + ' ');
    write('\r' + (actualEnd.rows > target.rows ? `\x1b[${actualEnd.rows - target.rows}A` : '') + (target.cols ? `\x1b[${target.cols}C` : ''));
    row = target.rows;
  };
  write('\n\x1b[2mShift+Enter: send · Ctrl+D: exit\x1b[0m\n');
  // Kitty disambiguation and bracketed paste; pop the keyboard mode on exit.
  write('\x1b[>1u\x1b[?2004h');
  const raw = process.stdin.isRaw;
  process.stdin.setRawMode(true);
  render();
  try {
    return await new Promise<string>((done, reject) => {
      const finish = (error?: Error) => {
        if (finished) return;
        finished = true;
        process.stdin.removeListener('data', forward);
        process.stdin.removeListener('end', eof);
        signal.removeEventListener('abort', abort);
        cursor = text.length;
        render();
        write('\r\n');
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
        pending += decoder.write(chunk);
        pending = pending.replaceAll(xtermEnter, '\x1b[13;2u');
        let held = Math.min(pending.length, xtermEnter.length - 1);
        while (held && !xtermEnter.startsWith(pending.slice(-held))) held--;
        const ready = pending.slice(0, pending.length - held);
        pending = pending.slice(pending.length - held);
        if (ready) input.write(ready);
      };
      input.on('keypress', (value: string | undefined, key: Key) => {
        if (finished) return;
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
        if (!pasted && key.name === 'left') cursor = Math.max(0, cursor - 1);
        else if (!pasted && key.name === 'right') cursor = Math.min(text.length, cursor + 1);
        else if (!pasted && key.name === 'home') cursor = text.lastIndexOf('\n', cursor - 1) + 1;
        else if (!pasted && key.name === 'end') { const end = text.indexOf('\n', cursor); cursor = end < 0 ? text.length : end; }
        else if (!pasted && key.name === 'backspace') { if (cursor) { text = text.slice(0, cursor - 1) + text.slice(cursor); cursor--; } }
        else if (!pasted && key.name === 'delete') text = text.slice(0, cursor) + text.slice(cursor + 1);
        else {
          const inserted = key.name === 'return' || key.name === 'enter' ? '\n' : value && !key.ctrl && !key.meta ? stripVTControlCharacters(value).replace(/[\x00-\x1f\x7f]/g, '') : '';
          text = text.slice(0, cursor) + inserted + text.slice(cursor); cursor += inserted.length;
        }
        render();
      });
      process.stdin.on('data', forward);
      process.stdin.once('end', eof);
      signal.addEventListener('abort', abort, { once: true });
      process.stdin.resume();
      if (signal.aborted) abort();
    });
  } finally {
    write('\x1b[<u\x1b[?2004l');
    process.stdin.setRawMode(raw ?? false);
    process.stdin.pause();
    input.destroy();
  }
}
