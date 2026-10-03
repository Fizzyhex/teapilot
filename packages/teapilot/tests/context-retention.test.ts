import { afterEach, expect, it } from 'vitest';
import { mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { completion, events, fixture, mockServer } from './helpers.js';
import { runAttempt } from '../src/agents/run.js';
import { SpendGovernor } from '../src/inference/budget.js';
import { Telemetry } from '../src/telemetry/outcome.js';
import { TaskStore, instructor } from '../src/workspace/task.js';
import { fitRecentResults } from '../src/agents/history.js';
import { estimateValueTokens } from '../src/inference/context.js';
import { emptyUsage } from '../src/integration/inference.js';
import { Evidence } from '../src/routing/escalation.js';

const cleanups: Array<() => Promise<unknown>> = [];
afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup(); });

async function runWithContext(contextTokens: number, toolCalls = 2, readOnly = false) {
  const f = await fixture(); cleanups.push(f.cleanup);
  const scratch = join(f.config.stateDir, 'workspaces', 'context', '.scratch');
  await mkdir(scratch, { recursive: true });
  const task = TaskStore.open(f.config.stateDir, 'context-retention-window', 'inspect latest evidence', scratch);
  task.startRequest(`context-${contextTokens}`, { calls: 20, modelCalls: 20, timeoutMs: 60_000 });
  const bodies: any[] = [];
  const server = await mockServer((body, _request, response) => {
    bodies.push(body);
    completion(response, bodies.length <= toolCalls ? readOnly
      ? { tool: { name: 'read', arguments: { path: `evidence-${bodies.length}.txt` } } }
      : { tool: { name: 'large_evidence', arguments: {} } } : { text: 'done' });
  });
  cleanups.push(server.close);
  Object.assign(f.config.models.capable, { provider: 'ollama', baseUrl: server.url, contextTokens, maxOutputTokens: 1024 });
  const evidence = `${'x'.repeat(3000)}RAW-MARKER-context-retention${'y'.repeat(57_000)}`;
  const path = join(f.config.stateDir, 'evidence.txt');
  await mkdir(f.config.stateDir, { recursive: true });
  await writeFile(path, evidence);
  if (readOnly) {
    for (let index = 1; index <= toolCalls; index++) await writeFile(join(f.cwd, `evidence-${index}.txt`), evidence);
  } else f.config.test = { fixture: { name: 'large_evidence', description: 'Read the provided large evidence.', file: path } };
  const result = await runAttempt({ config: f.config, tier: 'normal', workload: readOnly ? 'coder' : 'ask', cwd: f.cwd, prompt: 'inspect the evidence', web: false,
    budget: new SpendGovernor(join(f.config.stateDir, 'spend.jsonl'), 'context-retention', f.config.policy.budget), telemetry: new Telemetry(f.config.stateDir, 'context-retention'),
    approve: async () => true, scratch, task, taskActor: instructor, readOnly });
  const sent = JSON.stringify(bodies[2]?.messages ?? []);
  return { sent, result, bodies, events: await events(f.config) };
}

it('retains materially more newest raw evidence for a larger context, within the aggregate result window', async () => {
  const small = await runWithContext(8192);
  const large = await runWithContext(65_536);
  expect(small.result.success).toBe(true);
  expect(large.result.success).toBe(true);
  expect(small.sent).not.toContain('RAW-MARKER-context-retention');
  expect(large.sent).toContain('RAW-MARKER-context-retention');
  // The context window remains bounded even though the original tool output is much larger.
  expect(large.sent.length).toBeLessThan(60_000);
  expect((large.sent.match(/Full output saved to/g) ?? [])).toHaveLength(2);
  // Both raw outputs were archived before projection shortened what the model received.
  expect(large.sent).toContain('Full output saved to');
});

it('does not compact or withdraw tools when the actual evidence window stays below pressure', async () => {
  const run = await runWithContext(16_384, 8, true);
  expect(run.result.success, JSON.stringify(run.result)).toBe(true);
  expect(run.bodies).toHaveLength(9);
  expect(run.events.filter(event => event.type === 'compaction' && event.trigger === 'context')).toHaveLength(0);
  expect(run.bodies.slice(0, 8).every(body => body.tools?.some((tool: any) => tool.function.name === 'read'))).toBe(true);
});

it('fits non-ASCII results by estimated tokens, retaining archive handles, error evidence, and controls', () => {
  const oldText = `${'old 🚀 noise '.repeat(3000)}\nFull output saved to /scratch/outputs/old.txt (3000 lines); read or search it for anything not shown here.`;
  const freshText = `newest 🔍 marker ${'item '.repeat(150)}\ntask state was not saved (receipt); continue from the tool result and available files.`;
  const messages: any[] = [
    { role: 'assistant', content: [{ type: 'toolCall', id: 'c1', name: 'read', arguments: { path: 'src/old.ts' } }], api: 'openai-completions', provider: 'mock', model: 'mock', timestamp: 0, usage: emptyUsage(), stopReason: 'toolUse' },
    { role: 'toolResult', toolCallId: 'c1', toolName: 'read', content: [{ type: 'text', text: oldText }], isError: false, timestamp: 0 },
    { role: 'assistant', content: [{ type: 'toolCall', id: 'c1b', name: 'read', arguments: { path: 'src/older.ts' } }], api: 'openai-completions', provider: 'mock', model: 'mock', timestamp: 0, usage: emptyUsage(), stopReason: 'toolUse' },
    { role: 'toolResult', toolCallId: 'c1b', toolName: 'read', content: [{ type: 'text', text: `${'archive 🌱 '.repeat(1800)}\nFull output saved to /scratch/outputs/older.txt (1800 lines); read or search it.` }], isError: false, timestamp: 0 },
    { role: 'assistant', content: [{ type: 'toolCall', id: 'c2', name: 'read', arguments: { path: 'src/new.ts' } }], api: 'openai-completions', provider: 'mock', model: 'mock', timestamp: 0, usage: emptyUsage(), stopReason: 'toolUse' },
    { role: 'toolResult', toolCallId: 'c2', toolName: 'read', content: [{ type: 'text', text: freshText }], isError: false, timestamp: 0 },
    { role: 'toolResult', toolCallId: 'c3', toolName: 'bash', content: [{ type: 'text', text: 'missing dependency: compiler exited 1' }], isError: true, timestamp: 0 },
    { role: 'toolResult', toolCallId: 'c4', toolName: 'task_state', content: [{ type: 'text', text: 'host objective and checks' }], isError: false, timestamp: 0 },
  ];
  const minimums = fitRecentResults(messages, 0);
  const minimumCost = [1, 3, 5].reduce((sum, index) => {
    const item = minimums[index]!;
    return sum + estimateValueTokens({ role: item.role, toolName: (item as any).toolName, content: item.content, isError: (item as any).isError }) + 16;
  }, 0);
  const budget = minimumCost + 128;
  const shaped = fitRecentResults(messages, budget);
  expect(shaped[0]).toBe(messages[0]);
  expect(shaped[2]).toBe(messages[2]);
  expect(shaped[4]).toBe(messages[4]);
  expect(JSON.stringify(shaped[7])).toContain('host objective and checks');
  expect(JSON.stringify(shaped[5])).toContain('newest 🔍 marker');
  expect(JSON.stringify(shaped[5])).toContain('task state was not saved (receipt)');
  expect(JSON.stringify(shaped[1])).toContain('/scratch/outputs/old.txt');
  expect(JSON.stringify(shaped[3])).toContain('/scratch/outputs/older.txt');
  expect(JSON.stringify(shaped[6])).toContain('compiler exited 1');
  const evidenceTokens = [1, 3, 5, 6].reduce((sum, index) => {
    const item = shaped[index]!;
    return sum + estimateValueTokens({ role: item.role, toolName: (item as any).toolName, content: item.content, isError: (item as any).isError }) + 16;
  }, 0);
  expect(evidenceTokens).toBeLessThanOrEqual(budget);
  expect((messages[1] as any).content[0].text).toBe(oldText);
});

it('persists source freshness, changed files, and unresolved checks across a task reload', async () => {
  const f = await fixture(); cleanups.push(f.cleanup);
  const scratch = join(f.config.stateDir, 'workspaces', 'task', '.scratch');
  await mkdir(scratch, { recursive: true });
  const task = TaskStore.open(f.config.stateDir, 'context-retention-state', 'objective', scratch);
  task.startRequest('state-request', { calls: 20, modelCalls: 20, timeoutMs: 60_000 });
  const source = join(scratch, 'src', 'app.ts');
  const read = task.begin(instructor, 'read', { path: source, offset: 4, limit: 12 })!;
  task.settle(read, false, 'source excerpt', 'file', { path: source, offset: 4, limit: 12 });
  expect(JSON.parse(task.record(instructor, read)).source).toEqual({ path: source, offset: 4, limit: 12 });
  const edit = task.begin(instructor, 'edit', { path: source })!;
  task.settle(edit, false);
  task.recordExecution(instructor, { receipt: edit, changedPath: source });
  expect(JSON.parse(task.record(instructor, read)).sourceEpoch).not.toBe(task.snapshot().sourceEpoch);
  expect(task.execution(instructor)).toMatchObject({ changedFiles: [source], currentCheck: 'not-run-after-edit' });
  const check = task.begin(instructor, 'bash', { command: 'npm test' })!;
  task.settle(check, true);
  task.recordExecution(instructor, { receipt: check, shellUncertain: true });
  task.recordExecution(instructor, { receipt: check, check: { command: 'npm test', status: 'failed' } });
  const restored = TaskStore.open(f.config.stateDir, 'context-retention-state', 'objective', scratch);
  expect(restored.execution(instructor)).toMatchObject({ unresolvedChecks: ['npm test'], currentCheck: 'failed', shellUncertain: true });
  restored.recordExecution(instructor, { receipt: check, check: { command: 'npm test', status: 'passed' } });
  expect(restored.execution(instructor).unresolvedChecks).toEqual([]);
  const junior = { name: 'context-junior' };
  const juniorReceipt = restored.begin(junior, 'bash', { command: 'npm test' })!;
  restored.settle(juniorReceipt, false);
  restored.recordExecution(junior, { receipt: juniorReceipt, shellUncertain: true });
  expect(restored.execution(instructor)).toMatchObject({ shellUncertain: true, unresolvedChecks: [] });
});

it('records executed read/edit/check deltas during a real attempt and restores them on restart', async () => {
  const f = await fixture(); cleanups.push(f.cleanup);
  const scratch = join(f.config.stateDir, 'workspaces', 'runtime-task', '.scratch');
  await mkdir(scratch, { recursive: true });
  const source = join(f.cwd, 'source.ts');
  await writeFile(source, 'const state = "before";\n');
  f.config.policy.permissions = ['inference', 'repository.read', 'repository.write', 'repository.shell'];
  const task = TaskStore.open(f.config.stateDir, 'runtime-task-deltas', 'edit and verify source', scratch);
  task.startRequest('runtime-deltas', { calls: 20, modelCalls: 20, timeoutMs: 60_000 });
  const bodies: any[] = [];
  const server = await mockServer((body, _request, response) => {
    bodies.push(body);
    const call = bodies.length === 1 ? { name: 'read', arguments: { path: 'source.ts' } }
      : bodies.length === 2 ? { name: 'edit', arguments: { path: 'source.ts', edits: [{ oldText: 'before', newText: 'after' }] } }
      : bodies.length === 3 ? { name: 'bash', arguments: { command: 'npm test' } } : undefined;
    completion(response, call ? { tool: call } : { text: 'the check failed after the edit' });
  });
  cleanups.push(server.close);
  Object.assign(f.config.models.capable, { provider: 'ollama', baseUrl: server.url });
  const result = await runAttempt({ config: f.config, tier: 'normal', workload: 'coder', cwd: f.cwd, prompt: 'edit and test the source', web: false,
    budget: new SpendGovernor(join(f.config.stateDir, 'spend.jsonl'), 'runtime-deltas', f.config.policy.budget), telemetry: new Telemetry(f.config.stateDir, 'runtime-deltas'),
    approve: async () => true, scratch, task, taskActor: instructor });
  expect(result.success).toBe(false);
  expect(await readFile(source, 'utf8')).toContain('after');
  const read = task.snapshot().receipts.find(receipt => receipt.tool === 'read')!;
  expect(JSON.parse(task.record(instructor, read.id)).source.path).toBe(source);
  expect(JSON.parse(task.record(instructor, read.id)).sourceEpoch).not.toBe(task.snapshot().sourceEpoch);
  const restored = TaskStore.open(f.config.stateDir, 'runtime-task-deltas', 'edit and test the source', scratch);
  expect(restored.execution(instructor).changedFiles).toContain(source);
  expect(restored.execution(instructor).unresolvedChecks).toContain('npm test');
  // The post-edit inference carried hot host state, not the stale read observation.
  expect(JSON.stringify(bodies[2])).toContain('not-run-after-edit');
  expect(JSON.parse(task.project(instructor)).observations.map((item: { id: string }) => item.id)).not.toContain(read.id);
  const check = restored.snapshot().receipts.find(receipt => receipt.tool === 'bash')!;
  restored.recordExecution(instructor, { receipt: check.id, check: { command: 'npm test', status: 'passed' } });
  expect(restored.execution(instructor).unresolvedChecks).toEqual([]);
  expect(restored.execution(instructor).currentCheck).toBe('passed');
});

it('clears a restarted durable failure after the matching long check passes', async () => {
  const f = await fixture(); cleanups.push(f.cleanup);
  const scratch = join(f.config.stateDir, 'workspaces', 'restarted-check', '.scratch');
  await mkdir(scratch, { recursive: true });
  f.config.policy.permissions = ['inference', 'repository.read', 'repository.shell'];
  const command = `echo test ${'arg '.repeat(80)}`;
  const initial = TaskStore.open(f.config.stateDir, 'restarted-check', 'rerun the failed check', scratch);
  initial.startRequest('first-check', { calls: 10, modelCalls: 10, timeoutMs: 60_000 });
  const receipt = initial.begin(instructor, 'bash', { command })!;
  initial.settle(receipt, true, 'test failed');
  initial.recordExecution(instructor, { receipt, shellUncertain: true, check: { command, status: 'failed' } });
  expect(initial.execution(instructor).unresolvedChecks).toHaveLength(1);
  expect(initial.execution(instructor).unresolvedChecks[0]).not.toBe(command);

  const task = TaskStore.open(f.config.stateDir, 'restarted-check', 'rerun the failed check', scratch);
  task.startRequest('second-check', { calls: 10, modelCalls: 10, timeoutMs: 60_000 });
  const callerOnlyCheck = 'manual verification from caller';
  const bodies: any[] = [];
  const server = await mockServer((body, _request, response) => {
    bodies.push(body);
    completion(response, bodies.length === 1 ? { tool: { name: 'bash', arguments: { command } } } : { text: 'the check passed' });
  });
  cleanups.push(server.close);
  Object.assign(f.config.models.capable, { provider: 'ollama', baseUrl: server.url });
  const result = await runAttempt({ config: f.config, tier: 'normal', workload: 'coder', cwd: f.cwd, prompt: 'rerun the failed check', web: false,
    budget: new SpendGovernor(join(f.config.stateDir, 'spend.jsonl'), 'restarted-check', f.config.policy.budget), telemetry: new Telemetry(f.config.stateDir, 'restarted-check'),
    approve: async () => true, scratch, task, taskActor: instructor,
    unresolvedChecks: [...initial.execution(instructor).unresolvedChecks, callerOnlyCheck] });

  expect(result.success).toBe(false); // The unrelated caller-supplied check correctly remains unresolved.
  expect(result.reason).toBe('test_failures');
  expect(result.unresolvedChecks).toEqual([callerOnlyCheck]);
  expect(task.execution(instructor).unresolvedChecks).toEqual([]);
  expect(task.execution(instructor).currentCheck).toBe('passed');
  expect(JSON.stringify(bodies[0])).toContain('unresolvedChecks');
});

it('retains caller-only unresolved checks when reconciling the task ledger', async () => {
  const f = await fixture(); cleanups.push(f.cleanup);
  const evidence = new Evidence(f.config.policy.escalation, ['caller-only check']);
  evidence.syncUnresolvedChecks(['durable check']);
  expect([...evidence.unresolvedChecks]).toEqual(['caller-only check', 'durable check']);
  evidence.syncUnresolvedChecks([]);
  expect([...evidence.unresolvedChecks]).toEqual(['caller-only check']);
});

it('keeps a failed check locally when task persistence fails and a different check passes', async () => {
  const f = await fixture(); cleanups.push(f.cleanup);
  const scratch = join(f.config.stateDir, 'failed-check-write', '.scratch');
  await mkdir(scratch, { recursive: true });
  f.config.policy.permissions = ['inference', 'repository.read', 'repository.shell'];
  const task = TaskStore.open(f.config.stateDir, 'failed-check-write', 'run checks', scratch);
  task.startRequest('failed-check-write', { calls: 10, modelCalls: 10, timeoutMs: 60_000 });
  const recordExecution = task.recordExecution.bind(task);
  task.recordExecution = (actor, update) => {
    if (update.check?.command === 'false # test') throw new Error('injected task write failure');
    return recordExecution(actor, update);
  };
  const bodies: any[] = [];
  const server = await mockServer((body, _request, response) => {
    bodies.push(body);
    const command = bodies.length === 1 ? 'false # test' : bodies.length === 2 ? 'echo test' : undefined;
    completion(response, command ? { tool: { name: 'bash', arguments: { command } } } : { text: 'done' });
  });
  cleanups.push(server.close);
  Object.assign(f.config.models.capable, { provider: 'ollama', baseUrl: server.url });
  const result = await runAttempt({ config: f.config, tier: 'normal', workload: 'coder', cwd: f.cwd, prompt: 'run both checks', web: false,
    budget: new SpendGovernor(join(f.config.stateDir, 'spend.jsonl'), 'failed-check-write', f.config.policy.budget), telemetry: new Telemetry(f.config.stateDir, 'failed-check-write'),
    approve: async () => true, scratch, task, taskActor: instructor });
  expect(result.success).toBe(false); // The failed check remains an unresolved finding despite the later pass.
  expect(result.reason).toBe('test_failures');
  expect(result.unresolvedChecks).toContain('false # test');
  expect(result.unresolvedChecks).not.toContain('echo test');
  expect((await events(f.config)).some(event => event.type === 'task_storage_failed' && event.phase === 'execution')).toBe(true);
});

it('keeps successful tool output and reports artifact-index storage failures', async () => {
  const f = await fixture(); cleanups.push(f.cleanup);
  const scratch = join(f.config.stateDir, 'workspaces', 'storage-failure', '.scratch');
  await mkdir(scratch, { recursive: true });
  const task = TaskStore.open(f.config.stateDir, 'storage-failure', 'read diagnostic', scratch);
  task.startRequest('storage-failure', { calls: 10, modelCalls: 10, timeoutMs: 60_000 });
  task.register = () => { throw new Error('injected artifact index failure'); };
  task.settle = () => { throw new Error('injected receipt settlement failure'); };
  const server = await mockServer((body, _request, response) => completion(response, body.messages?.some((message: any) => message.role === 'tool') ? { text: 'diagnostic completed' } : { tool: { name: 'large_evidence', arguments: {} } }));
  cleanups.push(server.close);
  Object.assign(f.config.models.capable, { provider: 'ollama', baseUrl: server.url });
  const evidence = 'successful tool marker\n'.repeat(5000);
  const path = join(f.config.stateDir, 'large.txt');
  await writeFile(path, evidence);
  f.config.test = { fixture: { name: 'large_evidence', description: 'read evidence', file: path } };
  const result = await runAttempt({ config: f.config, tier: 'normal', workload: 'ask', cwd: f.cwd, prompt: 'read diagnostic', web: false,
    budget: new SpendGovernor(join(f.config.stateDir, 'spend.jsonl'), 'storage-failure', f.config.policy.budget), telemetry: new Telemetry(f.config.stateDir, 'storage-failure'),
    approve: async () => true, scratch, task, taskActor: instructor });
  expect(result.success).toBe(true);
  expect(result.steps?.some(message => message.role === 'toolResult' && message.content.some(part => part.type === 'text' && part.text.includes('Full output saved to')))).toBe(true);
  const savedNames = await readdir(join(scratch, 'outputs'));
  expect(savedNames).toHaveLength(1);
  expect(await readFile(join(scratch, 'outputs', savedNames[0]!), 'utf8')).toBe(evidence);
  const storageEvents = await events(f.config);
  expect(storageEvents.some(event => event.type === 'task_storage_failed' && event.phase === 'artifact-index')).toBe(true);
  expect(storageEvents.some(event => event.type === 'task_storage_failed' && event.phase === 'receipt')).toBe(true);
});
