import { afterEach, expect, it, vi } from 'vitest';
import { PassThrough } from 'node:stream';
import { homedir } from 'node:os';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { stripVTControlCharacters } from 'node:util';
import { Terminal } from '@xterm/headless';
import { cellWidth, composerFrame, type ComposerContext } from '../src/composer.js';
import { promptInput } from '../src/prompt.js';

const context: ComposerContext = { spentUsd: 0, routingMode: 'hosted' };
const frame = (text = '', cursor = text.length, width = 100, height = 24, notice = '') =>
  composerFrame(text, cursor, width, height, homedir(), context, true, notice);
const lines = (output: string) => stripVTControlCharacters(output).split('\r\n');
const cleanup: Array<() => void | Promise<void>> = [];
afterEach(async () => { for (const run of cleanup.splice(0).reverse()) await run(); vi.restoreAllMocks(); vi.unstubAllEnvs(); });

function property(object: object, key: string, value: unknown) {
  const original = Object.getOwnPropertyDescriptor(object, key);
  Object.defineProperty(object, key, { configurable: true, value });
  cleanup.push(() => { if (original) Object.defineProperty(object, key, original); else Reflect.deleteProperty(object, key); });
}

async function editor(columns = 100, rows = 24, cwd = homedir(), noColour = false) {
  const terminal = new Terminal({ cols: columns, rows, allowProposedApi: true, scrollback: 1000 });
  const input = new PassThrough();
  const raw = vi.fn();
  Object.assign(input, { isTTY: true, isRaw: false, setRawMode: raw });
  property(process, 'stdin', input);
  property(process.stderr, 'isTTY', true);
  property(process.stderr, 'columns', columns);
  property(process.stderr, 'rows', rows);
  vi.stubEnv('TERM', 'xterm-256color');
  vi.stubEnv('NO_COLOR', noColour ? '1' : undefined);
  vi.stubEnv('NODE_DISABLE_COLORS', undefined);
  let chunks = '';
  vi.spyOn(process.stderr, 'write').mockImplementation(data => { chunks += String(data); return true; });
  const controller = new AbortController();
  const resizeListeners = process.stderr.listenerCount('resize');
  const result = promptInput('>', cwd, controller.signal, { ...context, lastModel: 'test-model' });
  cleanup.push(async () => { controller.abort(); await result.catch(() => {}); input.destroy(); terminal.dispose(); });
  const flush = async () => {
    const data = chunks; chunks = '';
    await new Promise<void>(done => terminal.write(data, done));
    return Array.from({ length: terminal.buffer.active.length }, (_, index) => terminal.buffer.active.getLine(index)?.translateToString(true) ?? '').join('\n');
  };
  return {
    terminal, input, raw, result, flush, resizeListeners,
    keys: (keys: string) => input.write(Buffer.from(keys)),
    resize: async (cols: number, height: number) => {
      await flush();
      terminal.resize(cols, height);
      property(process.stderr, 'columns', cols); property(process.stderr, 'rows', height);
      process.stderr.emit('resize');
      return flush();
    },
  };
}

it('shows the dark panel immediately and matches the three-line reference layout', () => {
  expect(frame().rows).toBe(3);
  expect(frame().cursor).toEqual({ rows: 1, cols: 2 });
  const text = 'Hello,\nHow are we doing today?\nThis is a multi-line text entry.';
  const rendered = frame(text);
  const screen = lines(rendered.output);
  expect(screen).toHaveLength(5);
  expect(screen[0]!.trim()).toMatch(/^~ +Session: \$0\.000000$/);
  expect(screen.slice(1, 4).map(line => line.trimEnd())).toEqual(text.split('\n').map(line => `│ ${line}`));
  expect(screen[4]).toContain('@ files · Tab: complete · Enter: newline · Shift+Enter: send');
  expect(screen[4]!.trimEnd()).toMatch(/Auto$/);
  expect(rendered.output).toContain('\x1b[48;2;55;61;66m');
  expect(screen.every(line => cellWidth(line) === 100)).toBe(true);
});

it('wraps at content-cell boundaries and tracks wide and combining characters', () => {
  const rendered = frame('a界e\u0301🙂z', 'a界e\u0301🙂'.length, 10);
  expect(rendered.cursor).toEqual({ rows: 1, cols: 8 });
  expect(frame('1234567', 7, 10).cursor).toEqual({ rows: 2, cols: 2 });
  expect(frame('123456界', 6, 10).cursor).toEqual({ rows: 2, cols: 2 });
  expect(lines(rendered.output).every(line => cellWidth(line) === 10)).toBe(true);
  expect(cellWidth('👩‍💻e\u0301界')).toBe(5);
});

it('keeps long input and notices bounded with the cursor and footer visible', () => {
  const text = Array.from({ length: 40 }, (_, index) => `line ${index}`).join('\n');
  const bottom = frame(text, text.length, 80, 10);
  expect(bottom.rows).toBe(9);
  expect(bottom.cursor.rows).toBe(7);
  expect(bottom.output).toContain('line 39');
  expect(bottom.output).not.toContain('line 0');
  expect(frame(text, 0, 80, 10).cursor.rows).toBe(1);
  const notice = frame(text, text.length, 80, 10, Array(30).fill('candidate').join('\n'));
  expect(notice.rows).toBe(9);
  expect(lines(notice.output).at(-1)!.trim()).toBe('candidate');
  expect(notice.output.indexOf('Auto')).toBeLessThan(notice.output.indexOf('candidate'));
});

it.each([1, 2, 3, 10, 30, 60, 120])('fits metadata and content within %i columns', width => {
  const result = composerFrame('界🙂hello', 9, width, 20, join(homedir(), 'a-very-long-directory-name'),
    { spentUsd: 1.25, routingMode: 'direct', lastModel: 'very-long-model-'.repeat(10) }, false);
  expect(result.output).not.toContain('\x1b');
  expect(lines(result.output).every(line => cellWidth(line) === width)).toBe(true);
  expect(result.cursor.cols).toBeLessThan(width);
});

it('grows, shrinks, and leaves the following answer below the footer', async () => {
  const ui = await editor();
  ui.keys('Hello,\rHow are we doing today?\rThis is a multi-line text entry.');
  let screen = await ui.flush();
  expect(screen).toContain('│ Hello,');
  expect(screen).toContain('│ How are we doing today?');
  expect(screen).toContain('│ This is a multi-line text entry.');
  const buffer = ui.terminal.buffer.active;
  const cell = buffer.getLine(buffer.baseY + buffer.cursorY)?.getCell(2);
  expect(cell?.getBgColor()).toBe(0x373d42);
  ui.keys('\x7f'.repeat('This is a multi-line text entry.'.length + 1));
  screen = await ui.flush();
  expect(screen).not.toContain('This is');
  expect(screen.match(/Session:/g), screen).toHaveLength(1);
  ui.keys('\x1b[13;2u');
  expect(await ui.result).toBe('Hello,\nHow are we doing today?');
  process.stderr.write('ANSWER\r\n');
  screen = await ui.flush();
  expect(screen.indexOf('ANSWER')).toBeGreaterThan(screen.indexOf('Last: test-model'));
  expect(screen).toMatch(/Last: test-model\nANSWER/);
  expect(ui.raw).toHaveBeenLastCalledWith(false);
  expect(process.stderr.listenerCount('resize')).toBe(ui.resizeListeners);
});

it('redraws on resize, scrolls long input, and handles Unicode editing', async () => {
  const ui = await editor(60, 12);
  ui.keys('界e\u0301🙂');
  await ui.flush();
  expect(ui.terminal.buffer.active.cursorX).toBe(7);
  ui.keys('\x1b[D\x7f'); // Remove the complete combining cluster before the emoji.
  expect(await ui.flush()).toContain('│ 界🙂');
  ui.keys('\x1b[F' + '\rnext'.repeat(20));
  let screen = await ui.resize(30, 10);
  expect(screen.match(/Session:/g), screen).toHaveLength(1);
  expect(ui.terminal.buffer.active.cursorY).toBeLessThan(10);
  screen = await ui.resize(100, 20);
  expect(screen.match(/Session:/g)).toHaveLength(1);
  expect(screen).toContain('Last: test-model');
  ui.keys('\x1b[13;2u');
  expect(await ui.result).toBe('界🙂' + '\nnext'.repeat(20));
});

it.each(['\x03', '\x04'])('cleans up the Chat composer on %j', async key => {
  const ui = await editor();
  const rejection = expect(ui.result).rejects.toMatchObject({ name: key === '\x03' ? 'AbortError' : 'TerminalClosedError' });
  ui.keys(key);
  await rejection;
  expect(process.stderr.listenerCount('resize')).toBe(ui.resizeListeners);
  expect(ui.input.listenerCount('data')).toBe(0);
  expect(ui.raw).toHaveBeenLastCalledWith(false);
  await ui.flush();
});

it('honours disabled colour in the interactive Chat renderer', async () => {
  const ui = await editor(100, 24, homedir(), true);
  ui.keys('plain');
  await ui.flush();
  const buffer = ui.terminal.buffer.active;
  const cell = buffer.getLine(buffer.cursorY)?.getCell(2);
  expect(cell?.isBgDefault()).toBe(true);
  expect(cell?.isFgDefault()).toBe(true);
  ui.keys('\x1b[13;2u');
  expect(await ui.result).toBe('plain');
});

it('handles exact-width wrapping, bracketed paste, and a mid-line cursor', async () => {
  const ui = await editor(20);
  ui.keys('\x1b[200~12345678901234567\rsecond\x1b[201~');
  await ui.flush();
  ui.keys('\x1b[H\x1b[D'); // Start of second line, then before its newline.
  let screen = await ui.flush();
  expect(ui.terminal.buffer.active.cursorX).toBe(2);
  expect(screen).toContain('│ 12345678901234567');
  ui.keys('\x7f');
  screen = await ui.flush();
  expect(screen).toContain('│ 1234567890123456');
  ui.keys('\x1b[13;2u');
  expect(await ui.result).toBe('1234567890123456\nsecond');
});

it('shows completion candidates beneath the footer and clears them after editing', async () => {
  const cwd = await mkdtemp(join(tmpdir(), 'teapilot-composer-'));
  cleanup.push(() => rm(cwd, { recursive: true, force: true }));
  await writeFile(join(cwd, 'alpha.ts'), '');
  await writeFile(join(cwd, 'alpine.ts'), '');
  const ui = await editor(100, 24, cwd);
  ui.keys('@al\t');
  let screen = '';
  await vi.waitFor(async () => { screen = await ui.flush(); expect(screen).toContain('alpine.ts'); });
  expect(screen.indexOf('alpha.ts')).toBeGreaterThan(screen.indexOf('Last: test-model'));
  ui.keys('ph\t');
  await vi.waitFor(async () => { screen = await ui.flush(); expect(screen).toContain('│ @alpha.ts'); });
  expect(screen).not.toContain('alpine.ts');
  ui.keys('\x1b[13;2u');
  expect(await ui.result).toBe('@alpha.ts');
});
