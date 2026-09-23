import { afterEach, expect, it, vi } from 'vitest';
import { MarkdownOutput, TerminalPresentation, terminalColour } from '../src/presentation.js';

const ttyDescriptors = [process.stdout, process.stderr].map(stream => Object.getOwnPropertyDescriptor(stream, 'isTTY'));
afterEach(() => {
  vi.restoreAllMocks(); vi.unstubAllEnvs(); vi.useRealTimers();
  [process.stdout, process.stderr].forEach((stream, index) => {
    if (ttyDescriptors[index]) Object.defineProperty(stream, 'isTTY', ttyDescriptors[index]!);
    else Reflect.deleteProperty(stream, 'isTTY');
  });
});
const strip = (text: string) => text.replace(/\x1b\[[0-9;]*m/g, '');
it('styles chunked Markdown while preserving literal characters, code, and URLs', () => {
  let output = '';
  const markdown = new MarkdownOutput(text => output += text, true);
  const source = '# Heading\n**bold** and *italic* https://example.com/a_b_c\n```js\n  **literal**\n```\n    **indented**\n`**inline**`';
  for (const character of source) markdown.push(character);
  markdown.finish();
  expect(strip(output)).toBe(source);
  expect(output).toContain('\x1b[1m**bold**');
  expect(output).toContain('\n  **literal**\n');
  expect(output).toContain('\n    **indented**\n');
  expect(output).toContain('`**inline**`');
  expect(output).toContain('https://example.com/a_b_c');
});
it('keeps redirected, no-colour, and dumb terminal formatting plain', () => {
  expect(terminalColour(false, {})).toBe(false);
  expect(terminalColour(true, { NO_COLOR: '' })).toBe(false);
  expect(terminalColour(true, { TERM: 'dumb' })).toBe(false);
  let output = '';
  const markdown = new MarkdownOutput(text => output += text, false);
  markdown.push('**bold**'); markdown.finish(); expect(output).toBe('**bold**');
});
it('clears activity for approvals and cancellation and honours no-motion and JSON', () => {
  vi.useFakeTimers();
  vi.stubEnv('TERM', 'xterm');
  vi.stubEnv('TEAPILOT_NO_MOTION', undefined);
  Object.defineProperty(process.stdout, 'isTTY', { configurable: true, value: true });
  Object.defineProperty(process.stderr, 'isTTY', { configurable: true, value: true });
  const write = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
  const presentation = new TerminalPresentation(false, false);
  presentation.start(); vi.advanceTimersByTime(400);
  expect(write).toHaveBeenCalled();
  presentation.approval('Run npm test?');
  const count = write.mock.calls.length; vi.advanceTimersByTime(1000);
  expect(write.mock.calls.length).toBe(count);
  presentation.start(); vi.advanceTimersByTime(200); presentation.close();
  expect(vi.getTimerCount()).toBe(0);
  new TerminalPresentation(false, true).start(); new TerminalPresentation(true, false).start();
  expect(vi.getTimerCount()).toBe(0);
});
