import { expect, it } from 'vitest';
import { formatInterruption, interruptionDetails, type Interruption } from '../src/interruption.js';

const stopped: Interruption = { reason: 'cancelled', edits: [], shellRan: false };

it('acknowledges a stop without treating it as a failure or giving advice', () => {
  expect(formatInterruption({ ...stopped, advice: 'retry', reply: 'unfinished answer' }, true)).toBe('stopped');
});

it('keeps edits and missing checks visible, with sizes only in Details', () => {
  const info = { ...stopped, edits: [{ path: 'free-api-keys.md', size: 2048 }] };
  expect(formatInterruption(info, true)).toBe('stopped — edits to `free-api-keys.md` are still there.\n\n-# those edits haven’t been checked.');
  expect(formatInterruption(info)).toContain('\n\nthose edits haven’t been checked.');
  expect(interruptionDetails(info)).toBe('edited `free-api-keys.md` (2 KB)\nchecks: not run after latest recorded edit');
});

it.each(['passed', 'failed'] as const)('preserves %s checks on a stopped edit', check => {
  const text = formatInterruption({ ...stopped, edits: [{ path: 'a.ts' }], check }, true);
  expect(text).toContain(check === 'passed' ? 'checks passed after the latest recorded edit.' : 'checks are still failing.');
  expect(text).not.toContain('haven’t been checked');
});

it('does not equate missing file receipts with no changes when shell commands ran', () => {
  expect(formatInterruption({ ...stopped, shellRan: true }, true)).toBe('stopped — commands ran, so there may be changes.\n\n-# no checks were recorded after the commands.');
  expect(formatInterruption({ ...stopped, shellRan: true, edits: [{ path: 'a.ts' }] })).toContain('there may be other changes.');
  expect(formatInterruption({ ...stopped, shellRan: true, check: 'passed' })).toContain('recorded checks passed.');
});

it('caps the acknowledgement at three literal paths and retains all paths in Details', () => {
  const edits = ['a.ts', 'b`c.ts', 'd\ne.ts', 'four.ts', 'five.ts'].map(path => ({ path }));
  const info = { ...stopped, edits };
  expect(formatInterruption(info)).toContain('`a.ts`, ``b`c.ts``, `d e.ts` +2 more');
  expect(formatInterruption(info)).not.toContain('four.ts');
  expect(interruptionDetails(info)).toContain('edited `four.ts`\nedited `five.ts`');
});

it('gives genuine failures an explanation and one action, keeping diagnostics on demand', () => {
  const info: Interruption = { ...stopped, reason: 'tool_failures', advice: 'check the command before retrying.', detail: 'configured escalation limit reached', reply: 'some partial work' };
  expect(formatInterruption(info, true)).toBe('stopped on a tool error\n\ncheck the command before retrying.\n\npartial reply (task unfinished):\nsome partial work');
  expect(formatInterruption(info)).not.toContain(info.detail);
  expect(interruptionDetails(info)).toContain(info.detail);
});
