import { expect, it, vi } from 'vitest';
import type { AgentTool } from '@earendil-works/pi-agent-core';
import { Type } from '@earendil-works/pi-ai';
import { planningTools } from '../src/agents/planning.js';
import { Evidence } from '../src/routing/escalation.js';
import { RequestRecovery } from '../src/agents/recovery.js';
import { juniorTools, juniorProfiles } from '../src/agents/delegate.js';

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

it('enforces junior profiles independently of inherited editing and publication access', async () => {
  const available = ['read', 'write', 'edit', 'bash', 'web_read', 'file_send', 'play_start', 'play_update', 'play_stop', 'play_test', 'play_inspect', 'report'].map(tool);
  for (const type of ['research', 'plan', 'review'] as const) {
    const filtered = juniorTools(available, type);
    expect(filtered.map(tool => tool.name)).not.toEqual(expect.arrayContaining(['write', 'edit']));
    expect(filtered.some(tool => ['file_send', 'play_start', 'play_update', 'play_stop'].includes(tool.name))).toBe(false);
    const shell = filtered.find(tool => tool.name === 'bash')!;
    await expect(shell.execute('c', { command: 'npm test' })).rejects.toThrow('planning shell refuses');
    expect(filtered.some(tool => tool.name === 'play_test')).toBe(type === 'review');
  }
  const implement = juniorTools(available, 'implement').map(tool => tool.name);
  expect(implement).toContain('write'); expect(implement).toContain('play_test');
  expect(implement).not.toContain('play_update');
  expect(Object.values(juniorProfiles).map(profile => profile.calls)).toEqual([8, 6, 20, 8]);
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
