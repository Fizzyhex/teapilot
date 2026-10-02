import { expect, it, vi } from 'vitest';
import type { AgentTool } from '@earendil-works/pi-agent-core';
import { Type } from '@earendil-works/pi-ai';
import { planningTools } from '../src/agents/planning.js';
import { Evidence } from '../src/routing/escalation.js';
import { RequestRecovery } from '../src/agents/recovery.js';

const tool = (name: string): AgentTool => ({ name, label: name, description: name, parameters: Type.Object({}), execute: vi.fn(async () => ({ content: [{ type: 'text' as const, text: 'ok' }], details: {} })) });
it('keeps exploration and host bookkeeping but excludes project, app and access mutations', () => {
  expect(planningTools(['read', 'grep', 'find', 'ls', 'task_state', 'artifact_read', 'delegate_task', 'report', 'play_inspect', 'play_list', 'write', 'edit', 'play_update', 'play_start', 'play_test', 'access_grant'].map(tool)).map(tool => tool.name))
    .toEqual(['read', 'grep', 'find', 'ls', 'task_state', 'artifact_read', 'delegate_task', 'report', 'play_inspect', 'play_list']);
});
it('allows fixed git inspection but rejects shell grammar and nominally trusted mutation commands', async () => {
  const shell = tool('bash'), guarded = planningTools([shell])[0]!;
  await guarded.execute('c1', { command: 'git --no-pager log -5 --oneline' });
  expect(shell.execute).toHaveBeenCalledOnce();
  for (const command of ['git status --short && git reset --hard', 'git show HEAD:app.js', 'git add -A', 'python -c "print(1)"']) await expect(guarded.execute('c2', { command })).rejects.toThrow('planning shell refuses');
  expect(shell.execute).toHaveBeenCalledOnce();
});
it('gives read-only exploration a synthesis turn instead of escalating repeated successful reads', () => {
  const evidence = new Evidence({ repeatedToolCalls: 2, consecutiveFailures: 2, maxEscalations: 2 }, [], undefined, new RequestRecovery(), true);
  evidence.observe('read', { path: 'old-output.txt' }, false, 'same evidence');
  evidence.observe('read', { path: 'old-output.txt' }, false, 'same evidence');
  expect(evidence.warning).toContain('Repeated inspection');
  evidence.observe('read', { path: 'old-output.txt' }, false, 'same evidence');
  expect(evidence.answerNow).toBe(true);
  expect(evidence.reason).toBeUndefined();
});
it('does not convert execution failures into a successful planning answer', () => {
  const evidence = new Evidence({ repeatedToolCalls: 2, consecutiveFailures: 2, maxEscalations: 2 }, [], undefined, new RequestRecovery(), true);
  evidence.observe('read', { path: 'missing' }, true, 'missing file');
  evidence.observe('read', { path: 'missing' }, true, 'missing file');
  expect(evidence.reason).toBe('tool_failures');
  expect(evidence.answerNow).toBe(false);
});

it('treats saved-artifact retrieval as inspection rather than a failed execution workflow', () => {
  const evidence = new Evidence({ repeatedToolCalls: 2, consecutiveFailures: 2, maxEscalations: 2 }, [], undefined, new RequestRecovery(), true);
  for (let index = 0; index < 3; index++) evidence.observe('artifact_read', { id: 'a-existing', search: 'door' }, false, 'same source snippet');
  expect(evidence.answerNow).toBe(true); expect(evidence.reason).toBeUndefined();
});
