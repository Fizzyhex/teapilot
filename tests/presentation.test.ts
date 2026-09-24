import { afterEach, expect, it, vi } from 'vitest';
import { describeTool, MarkdownOutput, TerminalPresentation, terminalColour } from '../src/presentation.js';

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
it('describes a completed tool call for the progress trail', () => {
  expect(describeTool({ type: 'tool_execution_end', tool: 'write', path: 'index.html', size: 13312 })).toBe('write index.html (13 KB)');
  expect(describeTool({ type: 'tool_execution_end', tool: 'edit', path: 'index.html', size: 200 })).toBe('edit index.html (200 B)');
  expect(describeTool({ type: 'tool_execution_end', tool: 'read', path: 'index.html' })).toBe('read index.html');
  expect(describeTool({ type: 'tool_execution_end', tool: 'powershell', command: 'mkdir x', isError: true })).toBe('shell: mkdir x — failed');
  expect(describeTool({ type: 'tool_execution_end', tool: 'bash', command: 'npm test' })).toBe('shell: npm test');
  expect(describeTool({ type: 'tool_execution_end', tool: 'repo_list' })).toBe('repo_list');
});
it('prints one progress line per finished tool call, plain without colour, none under --json', () => {
  Object.defineProperty(process.stdout, 'isTTY', { configurable: true, value: true });
  Object.defineProperty(process.stderr, 'isTTY', { configurable: true, value: true });
  const write = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
  new TerminalPresentation(false, true).event({ type: 'tool_execution_end', tool: 'write', path: 'index.html', size: 13312 });
  expect(strip(write.mock.calls.map(call => String(call[0])).join(''))).toContain('write index.html (13 KB)\n');
  expect(write.mock.calls.some(call => String(call[0]).includes('\x1b['))).toBe(true);
  write.mockClear();
  vi.stubEnv('NO_COLOR', '');
  new TerminalPresentation(false, true).event({ type: 'tool_execution_end', tool: 'read', path: 'input.txt' });
  expect(write.mock.calls.join('')).toBe('read input.txt\n');
  write.mockClear();
  new TerminalPresentation(true, true).event({ type: 'tool_execution_end', tool: 'write', path: 'index.html', size: 13312 });
  expect(write).not.toHaveBeenCalled();
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
