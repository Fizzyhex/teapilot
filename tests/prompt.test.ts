import { afterEach, expect, it, vi } from 'vitest';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { completeMention, isPromptSubmit, promptInput } from '../src/prompt.js';

const cleanup: Array<() => Promise<void>> = [];
afterEach(async () => { vi.restoreAllMocks(); for (const run of cleanup.splice(0)) await run(); });

function mockTerminal() {
  const original = Object.getOwnPropertyDescriptor(process.stdin, 'setRawMode');
  const raw = vi.fn();
  Object.defineProperty(process.stdin, 'setRawMode', { configurable: true, value: raw });
  cleanup.push(async () => { if (original) Object.defineProperty(process.stdin, 'setRawMode', original); else Reflect.deleteProperty(process.stdin, 'setRawMode'); });
  const write = vi.spyOn(process.stderr, 'write').mockReturnValue(true);
  vi.spyOn(process.stdin, 'resume').mockReturnValue(process.stdin);
  vi.spyOn(process.stdin, 'pause').mockReturnValue(process.stdin);
  return { raw, write };
}

it('completes unique paths, lists ambiguity, quotes spaces, and blocks traversal', async () => {
  const cwd = await mkdtemp(join(tmpdir(), 'teapilot-completion-'));
  cleanup.push(() => rm(cwd, { recursive: true, force: true }));
  await mkdir(join(cwd, 'src'));
  await writeFile(join(cwd, 'src', 'one.ts'), '');
  await writeFile(join(cwd, 'src', 'other.ts'), '');
  await writeFile(join(cwd, 'my file.txt'), '');
  expect(await completeMention('Read @sr', 8, cwd)).toMatchObject({ text: 'Read @src/', cursor: 10 });
  expect(await completeMention('@src/o', 6, cwd)).toEqual({ candidates: ['src/one.ts', 'src/other.ts'] });
  expect(await completeMention('@src/on', 7, cwd)).toMatchObject({ text: '@src/one.ts' });
  expect(await completeMention('@my', 3, cwd)).toMatchObject({ text: '@"my file.txt"' });
  expect(await completeMention('@../', 4, cwd)).toEqual({ candidates: [] });
  expect(await completeMention('email@sr', 8, cwd)).toBeUndefined();
});

it('only treats modified Enter as submission', () => {
  expect(isPromptSubmit({ name: 'return', sequence: '\r' })).toBe(false);
  for (const sequence of ['\x1b[13;2u', '\x1b[27;2;13~', '\x1b\r']) expect(isPromptSubmit({ sequence })).toBe(true);
});

it.each([
  ['first\rsecond\x1b[13;2u', 'first\nsecond'],
  ['first\rsecond\x1b[27;2;13~', 'first\nsecond'],
  ['first\rsecond\x1b\r', 'first\nsecond'],
  ['\x1b[200~first\rsecond\x1b[13;2u\x1b[201~\x1b[13;2u', 'first\nsecond'],
])('edits multiline input and restores terminal modes (%j)', async (keys, expected) => {
  const { raw, write } = mockTerminal();
  const pending = promptInput('You', '.', new AbortController().signal);
  for (const byte of Buffer.from(keys)) process.stdin.emit('data', Buffer.from([byte]));
  expect(await pending).toBe(expected);
  expect(raw).toHaveBeenCalledWith(true);
  expect(raw).toHaveBeenLastCalledWith(false);
  expect(write.mock.calls.map(call => call[0]).join('')).toContain('\x1b[<u\x1b[?2004l');
});

it.each([['\x03', 'AbortError'], ['\x04', 'TerminalClosedError']])('cleans up on cancellation or EOF (%j)', async (key, name) => {
  const { raw } = mockTerminal();
  const listeners = process.stdin.listenerCount('data');
  const pending = promptInput('You', '.', new AbortController().signal);
  process.stdin.emit('data', Buffer.from(key));
  await expect(pending).rejects.toMatchObject({ name });
  expect(raw).toHaveBeenLastCalledWith(false);
  expect(process.stdin.listenerCount('data')).toBe(listeners);
});
