import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { PassThrough } from 'node:stream';
import { Terminal } from '@xterm/headless';
import { loadClips, parseClip, Playback } from '../src/art/playback.js';
import * as assets from '../src/art/playback.js';
import { TerminalPresentation } from '../src/presentation.js';
import { terminalUI } from '../src/setup/terminal.js';
import { during, terminalHandoff } from '../src/activity.js';

const originals = new Map<object, Map<string, PropertyDescriptor | undefined>>();
function property(object: object, key: string, value: unknown) {
  if (!originals.has(object)) originals.set(object, new Map());
  const saved = originals.get(object)!;
  if (!saved.has(key)) saved.set(key, Object.getOwnPropertyDescriptor(object, key));
  Object.defineProperty(object, key, { configurable: true, value });
}
let chunks: string[];
let output: string[];
let input: PassThrough;
let presentations: TerminalPresentation[];
let uis: Array<ReturnType<typeof terminalUI>>;
const present = (json = false, noMotion = false) => {
  const presentation = new TerminalPresentation(json, noMotion); presentations.push(presentation); return presentation;
};
beforeEach(() => {
  vi.useFakeTimers(); vi.stubEnv('TERM', 'xterm'); vi.stubEnv('CI', undefined); vi.stubEnv('NO_COLOR', '1');
  vi.stubEnv('TEAPILOT_NO_MOTION', undefined);
  chunks = []; output = []; presentations = []; uis = [];
  input = new PassThrough();
  Object.assign(input, { isTTY: true, isRaw: false, setRawMode: vi.fn((raw: boolean) => { Object.assign(input, { isRaw: raw }); return input; }) });
  property(process, 'stdin', input);
  for (const stream of [process.stdout, process.stderr]) {
    property(stream, 'isTTY', true); property(stream, 'columns', 80); property(stream, 'rows', 40);
    vi.spyOn(stream, 'write').mockImplementation((data: any) => {
      chunks.push(String(data)); if (stream === process.stdout) output.push(String(data)); return true;
    });
  }
});
afterEach(() => {
  for (const ui of uis) ui.close();
  for (const presentation of presentations) presentation.close();
  input.destroy();
  vi.restoreAllMocks(); vi.unstubAllEnvs(); vi.useRealTimers();
  for (const [object, keys] of originals) for (const [key, value] of keys) {
    if (value) Object.defineProperty(object, key, value); else Reflect.deleteProperty(object, key);
  }
  originals.clear();
});
async function screen(data = chunks.join(''), columns = 80, rows = 40): Promise<string> {
  // Feed a real VT parser. Assert the resulting screen/scrollback, not escapes.
  const terminal = new Terminal({ cols: columns, rows, convertEol: true, allowProposedApi: true, scrollback: 2000 });
  const written = new Promise<void>(resolve => terminal.write(data, resolve));
  await vi.advanceTimersByTimeAsync(50); await written;
  const buffer = terminal.buffer.active;
  const text = Array.from({ length: buffer.length }, (_, index) => buffer.getLine(index)?.translateToString(true) ?? '').join('\n');
  terminal.dispose(); return text;
}

it('validates supplied assets and removes only their shared blank top rows', () => {
  const clips = loadClips()!;
  for (const [name, clip] of Object.entries(clips)) {
    const raw = readFileSync(new URL(`../src/art/ascii-${name}.json`, import.meta.url), 'utf8');
    const source = JSON.parse(raw);
    expect(clip.frames[0]).toBe(source.frames[0].rows.slice(2).join('\n'));
    expect(clip.frames.every(frame => frame.split('\n').length === 17)).toBe(true);
    source.frames[0].rows[0] = 'x'.repeat(60);
    expect(() => parseClip(JSON.stringify(source), source.frameCount)).toThrow();
    expect(() => parseClip('{', source.frameCount)).toThrow();
  }
});

it('loops typing and holds coffee and paw endpoints with no timer', () => {
  const clips = loadClips()!;
  const draw = vi.fn(); const player = new Playback(draw);
  player.play(clips.typing, undefined, true);
  expect(player.frame).toBe(clips.typing.frames[0]);
  vi.advanceTimersByTime(584);
  expect(player.frame).toBe(clips.typing.frames[0]);
  player.play(clips['coffee-break']); vi.advanceTimersByTime(1100);
  expect(player.frame).toBe(clips['coffee-break'].frames[12]); expect(vi.getTimerCount()).toBe(0);
  player.play(clips.pawing, [2, 3]); vi.advanceTimersByTime(100);
  expect(player.frame).toBe(clips.pawing.frames[3]); expect(vi.getTimerCount()).toBe(0);
  player.play(clips.pawing, [4, 5, 6]); vi.advanceTimersByTime(200);
  expect(player.frame).toBe(clips.pawing.frames[6]); expect(vi.getTimerCount()).toBe(0);
});

it('delays short operations and changes waiting labels without replaying coffee', () => {
  const p = present(); const end = p.activity({ kind: 'waiting', label: 'Quick check' });
  vi.advanceTimersByTime(100); end(); expect(chunks).toEqual([]);
  p.setActivity({ kind: 'waiting', label: 'Routing' }); vi.advanceTimersByTime(1500);
  expect(vi.getTimerCount()).toBe(0);
  p.setActivity({ kind: 'waiting', label: 'Searching' });
  expect(chunks.join('')).toContain('Searching'); expect(vi.getTimerCount()).toBe(0);
  p.setActivity({ kind: 'composing', label: 'Composing response' }); vi.advanceTimersByTime(300);
  expect(vi.getTimerCount()).toBe(1); p.close(); expect(vi.getTimerCount()).toBe(0);
});

it('preserves wrapped streaming Markdown, progress and final answer deduplication in the terminal', async () => {
  const p = present(); p.setActivity({ kind: 'composing', label: 'Composing response' });
  vi.advanceTimersByTime(300);
  const source = '# Heading\n**bold** and `code`\n```js\n  const x = 1;\n```\n' + 'word '.repeat(35) + '\nfinal tail';
  for (const part of source.match(/.{1,7}|\n/g)!) {
    p.event({ type: 'text', text: part }); vi.advanceTimersByTime(15);
  }
  p.log('Progress stays separate'); p.event({ type: 'message_end' }); p.answer(source); p.close();
  const visible = await screen();
  expect(visible).toContain('# Heading\n**bold** and `code`\n```js\n  const x = 1;\n```');
  expect(visible.match(/final tail/g)).toHaveLength(1);
  expect(visible.match(/Response/g)).toHaveLength(1);
  expect(visible).toContain('final tail\nProgress stays separate');
  expect(visible).not.toContain('Composing response');
  expect(visible).not.toContain('@@@@');
});

it('streams an unfinished line immediately and keeps the display below it', async () => {
  const p = present(); p.setActivity({ kind: 'composing', label: 'Composing response' });
  p.event({ type: 'text', text: 'Already visible' });
  expect(output.join('')).toContain('Already visible');
  vi.advanceTimersByTime(400);
  expect(await screen()).toContain('Already visible');
  p.event({ type: 'text', text: ' without a newline' }); p.answer('Already visible without a newline'); p.close();
  const visible = await screen();
  expect(visible.match(/Already visible without a newline/g)).toHaveLength(1);
});

it.each(['x'.repeat(5000), '\u4e2d\u6587\ud83d\ude00', '\tindented'])('streams difficult cell layouts without losing text', async text => {
  const p = present(); p.setActivity({ kind: 'composing', label: 'Composing response' });
  vi.advanceTimersByTime(300); p.event({ type: 'text', text }); p.answer(text); p.close();
  expect(output.join('')).toContain(text);
  expect(vi.getTimerCount()).toBe(0);
  const visible = await screen(); expect(visible).not.toContain('Composing response');
});

it('does not keep queueing frames behind slow terminal output', () => {
  const p = present(); p.start(); vi.advanceTimersByTime(300);
  property(process.stderr, 'writableNeedDrain', true);
  const count = chunks.length; vi.advanceTimersByTime(1000); expect(chunks).toHaveLength(count);
  property(process.stderr, 'writableNeedDrain', false); process.stderr.emit('drain');
  expect(chunks.length).toBeGreaterThan(count); expect(vi.getTimerCount()).toBe(0);
});

it('suspends for subprocesses and never restores an expired activity scope', async () => {
  const p = present(); const outer = p.activity({ kind: 'waiting', label: 'Outer' });
  const inner = p.activity({ kind: 'waiting', label: 'Inner' }); outer();
  vi.advanceTimersByTime(300);
  await terminalHandoff(p, async () => {
    const count = chunks.length; vi.advanceTimersByTime(1000); expect(chunks).toHaveLength(count);
    inner();
  });
  expect(vi.getTimerCount()).toBe(0);
  await expect(during(p, 'Failure', async () => { throw new Error('expected'); })).rejects.toThrow('expected');
  expect(vi.getTimerCount()).toBe(0);
});

it.each(['short', 'narrow', 'unknown', 'json', 'no-motion', 'env', 'ci', 'pipe', 'dumb', 'missing-assets'])('uses a clean fallback for %s', mode => {
  if (mode === 'short') property(process.stderr, 'rows', 24);
  if (mode === 'narrow') property(process.stderr, 'columns', 60);
  if (mode === 'unknown') property(process.stderr, 'rows', undefined);
  if (mode === 'env') vi.stubEnv('TEAPILOT_NO_MOTION', '');
  if (mode === 'ci') vi.stubEnv('CI', 'true');
  if (mode === 'pipe') property(process.stdout, 'isTTY', false);
  if (mode === 'dumb') vi.stubEnv('TERM', 'dumb');
  if (mode === 'missing-assets') vi.spyOn(assets, 'loadClips').mockReturnValue(undefined);
  const p = present(mode === 'json', mode === 'no-motion'); p.start(); vi.advanceTimersByTime(2000); p.close();
  expect(chunks.join('')).not.toContain('\x1b'); expect(vi.getTimerCount()).toBe(0);
  if (mode === 'json') expect(chunks).toEqual([]);
});

it('abandons old coordinates after resize and resumes art for a new question', () => {
  const p = present(); p.start(); vi.advanceTimersByTime(300);
  property(process.stderr, 'columns', 65); process.stderr.emit('resize');
  chunks = []; vi.advanceTimersByTime(500); p.log('Still readable');
  expect(chunks.join('')).not.toContain('\x1b');
  p.beginPrompt('Next: ', () => ({ rows: 0, cols: 6 }));
  expect(chunks.join('')).toContain('Waiting for your input');
  p.touchPrompt(); p.endPrompt(false, Number.MAX_SAFE_INTEGER); p.close();
});

it('opens paws without delaying input, freezes on a keystroke, and preserves wrapped answers', async () => {
  const p = present(); const ui = terminalUI(new AbortController().signal, p); uis.push(ui);
  const question = ui.input('Question');
  expect(chunks.join('')).toContain('Question: ');
  input.emit('data', Buffer.from('a'.repeat(100)));
  const count = chunks.length; vi.advanceTimersByTime(500); expect(chunks).toHaveLength(count);
  input.emit('data', Buffer.from('\r')); expect(await question).toBe('a'.repeat(100));
  p.close();
  const visible = await screen();
  expect(visible).toContain('Question: ' + 'a'.repeat(70) + '\n' + 'a'.repeat(30));
  expect(visible).not.toContain('Waiting for your input');
});

it('keeps secrets hidden and respects invalid-answer retries', async () => {
  const p = present(); const ui = terminalUI(new AbortController().signal, p); uis.push(ui);
  const secret = ui.input('API key', undefined, true);
  input.emit('data', Buffer.from('private-token\r')); expect(await secret).toBe('private-token');
  expect(chunks.join('')).not.toContain('private-token');
  const choice = ui.choose('Pick', ['One', 'Two']);
  input.emit('data', Buffer.from('9\r')); await Promise.resolve(); await Promise.resolve();
  expect(chunks.join('')).toContain('Enter a number from 1 to 2.');
  input.emit('data', Buffer.from('2\r')); expect(await choice).toBe(1);
});

it('suppresses artwork for long approvals and cancels a prompt without leaving timers', async () => {
  const p = present(); p.approval('Important detail\n'.repeat(30));
  const controller = new AbortController(); const ui = terminalUI(controller.signal, p); uis.push(ui);
  const question = ui.confirm('Approve?');
  expect(chunks.join('')).not.toContain('Waiting for your input');
  controller.abort(); expect(await question).toBe(false);
  p.close(); expect(vi.getTimerCount()).toBe(0);
});
