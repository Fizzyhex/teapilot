import { expect, it, vi } from 'vitest';
import { RequestAllowance } from '../src/agents/allowance.js';

const limits = { calls: 12, modelCalls: 8, timeoutMs: 1000, delegations: 2 };
it('shares tool, model, delegation and junior accounting without durable task state', () => {
  const allowance = new RequestAllowance(limits);
  expect(allowance.consumeTool()).toBe(true);
  expect(allowance.consumeTool('junior-alfa')).toBe(true);
  expect(allowance.consumeTool('junior-alfa')).toBe(true);
  expect(allowance.usedBy('junior-alfa')).toBe(2);
  expect(allowance.remaining().calls).toBe(9);
  expect(allowance.consumeDelegation()).toBe(true);
  expect(allowance.consumeDelegation()).toBe(true);
  expect(allowance.consumeDelegation()).toBe(false);
  for (let index = 0; index < 8; index++) expect(allowance.consumeModel()).toBe(true);
  expect(allowance.consumeModel()).toBe(false);
  for (let index = 0; index < 9; index++) expect(allowance.consumeTool()).toBe(true);
  expect(allowance.consumeTool()).toBe(false);
});
it('does not pause the shared deadline for juniors or compaction', () => {
  vi.useFakeTimers();
  try {
    const allowance = new RequestAllowance(limits);
    vi.advanceTimersByTime(1001);
    expect(allowance.consumeTool('junior-alfa')).toBe(false);
    expect(allowance.consumeModel()).toBe(false);
    expect(allowance.usedBy('junior-alfa')).toBe(0);
  } finally { vi.useRealTimers(); }
});
