import { expect, it } from 'vitest';
import { chunk } from '../src/index.js';

it('splits long answers within the message limit and keeps code fences balanced', () => {
  expect(chunk('short answer')).toEqual(['short answer']);
  expect(chunk('')).toEqual([]);
  const code = ['```ts', ...Array.from({ length: 200 }, (_, index) => `const value${index} = ${index};`), '```'].join('\n');
  const text = `Intro paragraph.\n\n${code}\n\nClosing words.`;
  const parts = chunk(text, 500);
  expect(parts.length).toBeGreaterThan(1);
  for (const part of parts) {
    expect(part.length).toBeLessThanOrEqual(500);
    expect(part.split('\n').filter(line => line.startsWith('```')).length % 2).toBe(0);
  }
  expect(parts.slice(1, -1).every(part => part.startsWith('```ts'))).toBe(true);
  expect(parts.join('\n')).toContain('const value199 = 199;');
  expect(parts.at(-1)).toContain('Closing words.');
});

it('hard-splits a single line longer than the limit', () => {
  const parts = chunk('x'.repeat(4500));
  expect(parts.map(part => part.length).every(length => length <= 2000)).toBe(true);
  expect(parts.join('')).toBe('x'.repeat(4500));
});
