import { expect, it } from 'vitest';
import { msysPath, shellQuote } from '../src/execution/shell.js';

it('spells Windows paths the way Git Bash puts them on PATH', () => {
  expect(msysPath('C:\\Users\\me\\.teapilot\\tools\\pandoc')).toBe('/c/Users/me/.teapilot/tools/pandoc');
  expect(msysPath('D:/tools/bin/')).toBe('/d/tools/bin');
  expect(msysPath('C:\\')).toBe('/c');
  expect(msysPath('/usr/bin')).toBe('/usr/bin');
});

it('quotes any value as one shell word', () => {
  expect(shellQuote('C:/Users/o\'brien/work space')).toBe(`'C:/Users/o'\\''brien/work space'`);
  expect(shellQuote('$HOME `x`')).toBe(`'$HOME \`x\`'`);
});
