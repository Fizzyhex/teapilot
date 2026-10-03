import { expect, it, vi } from 'vitest';
import type { AgentTool } from '@earendil-works/pi-agent-core';
import { Type } from '@earendil-works/pi-ai';
import { planningTools } from '../src/agents/planning.js';
import { Evidence } from '../src/routing/escalation.js';
import { RequestRecovery } from '../src/agents/recovery.js';
import { juniorTools } from '../src/agents/delegate.js';

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

it('keeps publication and access administration outside planning tools regardless of agent type', () => {
  const available = ['read', 'write', 'edit', 'bash', 'web_read', 'file_send', 'play_start', 'play_update', 'play_stop', 'play_test', 'play_inspect', 'report', 'access_grant', 'request_access'].map(tool);
  const filtered = planningTools(available).map(tool => tool.name);
  expect(filtered).toContain('read');
  for (const forbidden of ['file_send', 'play_start', 'play_update', 'play_stop', 'access_grant', 'request_access']) expect(filtered).not.toContain(forbidden);
});

it('uses one junior tool set rather than assigning access by semantic category', () => {
  const names = ['read', 'write', 'edit', 'bash', 'web_read', 'file_send', 'play_start', 'play_update', 'play_stop', 'play_test', 'play_inspect', 'report', 'request_capabilities', 'request_escalation', 'delegate_task'] as const;
  const available = names.map(tool);
  expect(juniorTools(available).map(item => item.name)).toEqual(['read', 'write', 'edit', 'bash', 'web_read', 'play_test', 'play_inspect', 'report', 'request_capabilities']);
});

it('warns about sequential paging and synthesizes only when continued paging also pressures context', () => {
  for (const name of ['read', 'artifact_read', 'web_read']) {
    const evidence = new Evidence({ repeatedToolCalls: 3, consecutiveFailures: 2, maxEscalations: 2 }, [], undefined, new RequestRecovery(), true);
    const args = (offset: number) => ({ path: 'guide.txt', id: 'a-source', url: 'https://example.org/guide', offset });
    for (let index = 1; index <= 3; index++) expect(evidence.observePaging(name, args(index * 100), false, false)).toBeUndefined();
    expect(evidence.observePaging(name, args(400), false, false)).toContain('search for the specific question');
    evidence.observePaging(name, args(500), false, false);
    expect(evidence.answerNow).toBe(false);
    evidence.observePaging(name, args(600), false, true);
    expect(evidence.answerNow).toBe(true);
    expect(evidence.reason).toBeUndefined();
  }
});

it('does not mistake targeted artifact searches or changing sources for sequential paging', () => {
  const evidence = new Evidence({ repeatedToolCalls: 3, consecutiveFailures: 2, maxEscalations: 2 }, [], undefined, new RequestRecovery(), true);
  for (let index = 0; index < 10; index++) {
    expect(evidence.observePaging('artifact_read', { id: 'a-source', search: 'DoorOpen' }, false, true)).toBeUndefined();
    expect(evidence.observePaging('read', { path: `source-${index}`, offset: 100 }, false, true)).toBeUndefined();
  }
  expect(evidence.answerNow).toBe(false);
});
