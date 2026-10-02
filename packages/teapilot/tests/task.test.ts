import { afterEach, expect, it, vi } from 'vitest';
import { mkdir, readFile, readdir, rm, symlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { completion, events, fixture, mockServer } from './helpers.js';
import { TaskStore, instructor, taskLimits } from '../src/workspace/task.js';
import { Scratch } from '../src/workspace/scratch.js';
import { RequestRecovery } from '../src/agents/recovery.js';
import { fingerprint } from '../src/agents/recovery.js';
import { taskTools } from '../src/agents/task.js';
import { runAttempt } from '../src/agents/run.js';
import { runHost } from '../src/host.js';
import { SpendGovernor } from '../src/inference/budget.js';
import { Telemetry } from '../src/telemetry/outcome.js';
import { WorkspaceStore } from '../src/workspace/store.js';

const cleanups: Array<() => Promise<unknown>> = [];
afterEach(async () => { vi.restoreAllMocks(); for (const cleanup of cleanups.splice(0).reverse()) await cleanup(); });
async function setup() {
  const f = await fixture(); cleanups.push(f.cleanup);
  const scratch = join(f.config.stateDir, 'workspaces', 'session', '.scratch');
  await mkdir(scratch, { recursive: true });
  const task = TaskStore.open(f.config.stateDir, 'explicit-scope', 'original objective', scratch, text => text.replaceAll('private-token', '[REDACTED]'));
  task.startRequest('request-1', { calls: 100, modelCalls: 100, timeoutMs: 60_000 });
  return { ...f, scratch, task };
}
async function save(f: Awaited<ReturnType<typeof setup>>, text: string, actor = instructor) {
  const producer = f.task.begin(actor, 'diagnostic', {})!;
  const scratch = actor.name === instructor.name ? f.scratch : join(f.scratch, 'juniors', actor.name);
  const pad = new Scratch(scratch, ['private-token'], (saved, kind) => f.task.register(actor, producer, saved, kind));
  const artifact = await pad.save('outputs', 'diagnostic', text, '.txt');
  f.task.settle(producer, false);
  return artifact;
}

it('restores state without replenishing the same request or replacing its objective', async () => {
  const f = await setup();
  const now = Date.now(); vi.spyOn(Date, 'now').mockReturnValue(now);
  f.task.consumeModel(); const receipt = f.task.begin(instructor, 'read', { path: 'a' })!; f.task.settle(receipt, false);
  f.task.update(instructor, { revision: 0, step: { id: 'p1', goal: 'check', status: 'working' } });
  const restored = TaskStore.open(f.config.stateDir, 'explicit-scope', 'a different objective', f.scratch);
  restored.startRequest('request-1', { calls: 1000, modelCalls: 1000, timeoutMs: 600_000 });
  expect(restored.snapshot()).toEqual(f.task.snapshot());
  expect(restored.snapshot().objective).toBe('original objective');
  expect(restored.remaining()).toMatchObject({ calls: 99, modelCalls: 99 });
  restored.startRequest('request-2', { calls: 2, modelCalls: 3, timeoutMs: 1000 });
  expect(restored.remaining()).toEqual({ calls: 2, modelCalls: 3, ms: 1000 });
  expect(restored.snapshot().steps).toHaveLength(1);
});

it('recovers interrupted calls as uncertain rather than replaying them', async () => {
  const f = await setup();
  f.task.begin(instructor, 'file_send', { path: 'output.gif' });
  const restored = TaskStore.open(f.config.stateDir, 'explicit-scope', 'objective', f.scratch);
  expect(restored.snapshot().receipts[0]?.status).toBe('uncertain');
  expect(restored.snapshot().status).toBe('blocked');
  expect(restored.remaining().calls).toBe(99);
});

it('checks working revisions but receipt accounting does not invalidate a just-issued update', async () => {
  const f = await setup();
  const receipt = f.task.begin(instructor, 'task_state', {})!;
  await taskTools(f.task)[0]!.execute('update', { revision: 0, step: { id: 'p1', goal: 'verify', status: 'ready' } });
  f.task.settle(receipt, false);
  expect(f.task.snapshot().revision).toBe(1);
  expect(() => f.task.update(instructor, { revision: 0, remove_step: 'p1' })).toThrow('stale');
  expect(() => f.task.update(instructor, { revision: 1, step: { id: 'p2', goal: 'x'.repeat(241), status: 'done' } })).toThrow();
});

it('returns the updated state even if a model adds an unrelated view-only record selector', async () => {
  const f = await setup();
  const result = await taskTools(f.task)[0]!.execute('update', { revision: 0, record: 'not-a-state-id', step: { id: 'p1', goal: 'work', status: 'ready' } });
  expect(result.content[0]).toMatchObject({ type: 'text', text: expect.stringContaining('"revision":1') });
  expect(f.task.snapshot().steps).toHaveLength(1);
});

it('does not recycle dismissed junior identities into unrelated work', async () => {
  const f = await setup();
  const junior = { name: 'junior-alfa', scratch: join(f.scratch, 'juniors', 'junior-alfa'), turn: 12, turns: Array.from({ length: 8 }, () => ({ user: 'question', assistant: 'report' })) };
  f.task.saveJunior(junior);
  expect(f.task.snapshot().juniors[0]?.turns).toHaveLength(6);
  f.task.saveJunior(junior, true);
  const restored = TaskStore.open(f.config.stateDir, 'explicit-scope', 'objective', f.scratch);
  expect(restored.snapshot().juniors).toHaveLength(0);
  expect(restored.snapshot().juniorNames).toEqual(['junior-alfa']);
});

it('pins explicit host constraints without exposing any model operation to rewrite them', async () => {
  const f = await setup();
  const task = TaskStore.open(f.config.stateDir, 'constrained', 'objective', f.scratch, text => text, ['do not modify the project']);
  task.startRequest('r', { calls: 10, modelCalls: 10, timeoutMs: 1000 });
  expect(JSON.parse(task.project(instructor)).constraints).toEqual(['do not modify the project']);
  task.configure({ constraints: ['explicit user amendment'], objective: 'amended objective' });
  expect(task.snapshot().revision).toBe(1);
  expect(JSON.parse(task.project(instructor))).toMatchObject({ constraints: ['explicit user amendment'], objective: 'amended objective' });
  expect(() => TaskStore.open(f.config.stateDir, 'too-large', 'objective', f.scratch, text => text, Array(8).fill('\\'.repeat(400)))).toThrow('pinned');
});

it('keeps proposal mode request-local so an approved follow-up is not permanently read-only', async () => {
  const f = await setup();
  f.task.startRequest('plan', { calls: 10, modelCalls: 10, timeoutMs: 1000, readOnly: true });
  expect(JSON.parse(f.task.project(instructor)).readOnly).toBe(true);
  f.task.startRequest('approved-work', { calls: 10, modelCalls: 10, timeoutMs: 1000 });
  expect(JSON.parse(f.task.project(instructor)).readOnly).toBe(false);
});

it('projects host-observed sources even when the model never writes steps or claims', async () => {
  const f = await setup();
  const old = f.task.begin(instructor, 'read', { path: '.scratch/juniors/junior-old/outputs/bash-1.txt' })!;
  f.task.settle(old, false, 'historical door code', 'saved-output');
  const current = f.task.begin(instructor, 'read', { path: 'apps/game.js' })!;
  f.task.settle(current, false, 'current floor/wall-only source', 'file');
  const restored = TaskStore.open(f.config.stateDir, 'explicit-scope', 'ignored', f.scratch);
  const view = JSON.parse(restored.project(instructor));
  expect(view.steps).toHaveLength(0); expect(view.claims).toHaveLength(0);
  expect(view.observations).toEqual(expect.arrayContaining([
    expect.objectContaining({ origin: 'saved-output', excerpt: 'historical door code' }),
    expect.objectContaining({ origin: 'file', source: 'apps/game.js', excerpt: 'current floor/wall-only source' }),
  ]));
  expect(JSON.parse(restored.project({ name: 'junior-new' })).observations).toHaveLength(0);
});

it('does not let repeated historical reads displace direct source and discovery observations', async () => {
  const f = await setup();
  const current = f.task.begin(instructor, 'read', { path: 'apps/game.js' })!;
  f.task.settle(current, false, 'current source', 'file');
  const lookup = f.task.begin(instructor, 'find', { path: '.', pattern: '**/reference*' })!;
  f.task.settle(lookup, false, 'no files found', 'inventory');
  for (let index = 0; index < 8; index++) {
    const old = f.task.begin(instructor, 'read', { path: `.scratch/outputs/bash-${index}.txt` })!;
    f.task.settle(old, false, 'old output', 'saved-output');
  }
  const view = JSON.parse(f.task.project(instructor));
  expect(view.observations).toHaveLength(3);
  expect(view.observations).toEqual(expect.arrayContaining([
    expect.objectContaining({ source: 'apps/game.js', excerpt: 'current source' }),
    expect.objectContaining({ source: '.; **/reference*', excerpt: 'no files found' }),
  ]));
});

it('bounds long receipt summaries without rejecting a valid command before it runs', async () => {
  const f = await setup();
  const receipt = f.task.begin(instructor, 'bash', { command: 'x'.repeat(1000) })!;
  expect(JSON.parse(f.task.record(instructor, receipt)).summary.length).toBeLessThanOrEqual(240);
});

it('discovers older evidence through bounded scoped catalog pages', async () => {
  const f = await setup();
  for (let index = 0; index < 10; index++) await save(f, `result ${index}`);
  const page = JSON.parse(f.task.catalog(instructor, 'artifacts'));
  expect(page).toMatchObject({ total: 10, next: 8 }); expect(page.records).toHaveLength(8);
  expect(JSON.parse(f.task.catalog(instructor, 'artifacts', 8)).records).toHaveLength(2);
  expect(JSON.parse(f.task.catalog({ name: 'junior-new' }, 'artifacts')).total).toBe(0);
  expect(() => f.task.catalog(instructor, 'receipts', -1)).toThrow('offset');
  const tool = taskTools(f.task)[0]!;
  const result = await tool.execute('list', { list: 'receipts' });
  expect(result.content[0]).toMatchObject({ type: 'text', text: expect.stringContaining('"next":8') });
});

it('retains partial-output status in the manifest and retrieval receipt', async () => {
  const f = await setup(), producer = f.task.begin(instructor, 'diagnostic', {})!;
  const pad = new Scratch(f.scratch, [], (saved, kind) => f.task.register(instructor, producer, saved, kind));
  const artifact = await pad.save('outputs', 'stopped', 'only part of the output', '.txt', true);
  f.task.settle(producer, true);
  expect(f.task.snapshot().artifacts[0]?.complete).toBe(false);
  expect(await f.task.artifact(instructor, artifact.id)).toContain('incomplete');
});

it('requires scoped evidence for claims and keeps model completion separate from host status', async () => {
  const f = await setup();
  expect(() => f.task.update(instructor, { revision: 0, claim: { id: 'f1', text: 'passed', basis: 'observed', evidence: ['a-forged'] } })).toThrow('artifact');
  const artifact = await save(f, 'check failed');
  f.task.update(instructor, { revision: 0, claim: { id: 'f1', text: 'private-token', basis: 'reported', evidence: [artifact.id] }, step: { id: 'p1', goal: 'claimed done', status: 'done', evidence: [artifact.id] } });
  expect(f.task.snapshot().status).toBe('active');
  expect(f.task.snapshot().claims[0]).toMatchObject({ text: '[REDACTED]', basis: 'reported' });
  expect(f.task.record(instructor, 'p1')).toContain('claimed done');
});

it('allows settled short observations as evidence but not pending or uncertain receipts', async () => {
  const f = await setup();
  const receipt = f.task.begin(instructor, 'read', { path: 'source.txt' }, 'call-1')!;
  const claim = { id: 'f1', text: 'source says so', basis: 'reported' as const, evidence: [receipt] };
  expect(() => f.task.update(instructor, { revision: 0, claim })).toThrow('receipt');
  f.task.settle(receipt, false, 'bounded source excerpt private-token');
  f.task.update(instructor, { revision: 0, claim });
  expect(JSON.parse(f.task.record(instructor, receipt))).toMatchObject({ call: 'call-1', excerpt: 'bounded source excerpt [REDACTED]' });
});

it('retrieves hidden-middle evidence through a stable handle after restart', async () => {
  const f = await setup();
  const artifact = await save(f, Array.from({ length: 10_000 }, (_, index) => index === 5000 ? 'decisive-middle-marker private-token' : 'noise').join('\n'));
  const restored = TaskStore.open(f.config.stateDir, 'explicit-scope', 'objective', f.scratch);
  const found = await restored.artifact(instructor, artifact.id, { search: 'decisive-middle-marker', limit: 1 });
  expect(found).toContain('5001: decisive-middle-marker [REDACTED]');
  expect(found.length).toBeLessThan(taskLimits.retrievalChars);
  const bounded = await restored.artifact(instructor, artifact.id, { limit: 100 });
  expect(bounded.length).toBeLessThanOrEqual(taskLimits.retrievalChars + 100);
  await expect(restored.artifact(instructor, artifact.id, { offset: 0 })).rejects.toThrow('range');
  await expect(restored.artifact(instructor, artifact.id, { search: '' })).rejects.toThrow('search');
});

it('shows a literal search match in the middle of a giant single line', async () => {
  const f = await setup();
  const artifact = await save(f, `${'noise '.repeat(5000)}single-line-marker${'noise '.repeat(5000)}`);
  const found = await f.task.artifact(instructor, artifact.id, { search: 'single-line-marker', limit: 1 });
  expect(found).toContain('single-line-marker');
  expect(found).toContain('column 30001');
  expect(found.length).toBeLessThan(taskLimits.retrievalChars);
});

it('rejects replaced, deleted, foreign and linked artifacts', async () => {
  const f = await setup();
  const artifact = await save(f, 'good');
  await writeFile(artifact.path, 'evil');
  await expect(f.task.artifact(instructor, artifact.id)).rejects.toThrow('changed');
  await rm(artifact.path);
  await expect(f.task.artifact(instructor, artifact.id)).rejects.toThrow();
  const outside = join(f.cwd, 'outside.txt'); await writeFile(outside, 'good');
  await symlink(outside, artifact.path, 'file');
  await expect(f.task.artifact(instructor, artifact.id)).rejects.toThrow('linked');
  await expect(f.task.artifact(instructor, '../../spend.jsonl')).rejects.toThrow('unknown');
  const foreign = TaskStore.open(f.config.stateDir, 'different-scope', 'foreign', f.scratch);
  foreign.startRequest('foreign-request', { calls: 5, modelCalls: 5, timeoutMs: 1000 });
  await expect(foreign.artifact(instructor, artifact.id)).rejects.toThrow('unknown');
});

it('gives juniors only explicitly shared artifacts and their own scoped working view', async () => {
  const f = await setup(), actor = { name: 'junior-alfa', objective: 'narrow task' };
  const parent = await save(f, 'parent evidence');
  const child = await save(f, 'child evidence', actor);
  await expect(f.task.artifact(actor, parent.id)).rejects.toThrow('inaccessible');
  expect(await f.task.artifact({ ...actor, artifacts: [parent.id] }, parent.id)).toContain('parent evidence');
  expect(await f.task.artifact(instructor, child.id)).toContain('child evidence');
  const view = f.task.project(actor);
  expect(view).toContain('narrow task'); expect(view).not.toContain('original objective'); expect(view).not.toContain(parent.id);
  expect(() => f.task.authorizeArtifacts(actor, [parent.id])).toThrow();
  f.task.update(instructor, { revision: 0, step: { id: 'parent-step', goal: 'parent only', status: 'ready' } });
  expect(() => f.task.update(actor, { revision: 1, remove_step: 'parent-step' })).toThrow('another actor');
});

it('bounds state and projects valid JSON while hiding completed plan detail', async () => {
  const f = await setup(), artifact = await save(f, 'evidence');
  for (let index = 0; index < taskLimits.steps; index++) f.task.update(instructor, { revision: f.task.snapshot().revision, step: { id: `p${index}`, goal: 'g'.repeat(240), acceptance: 'a'.repeat(240), status: 'ready', evidence: [artifact.id] } });
  for (let index = 0; index < taskLimits.claims; index++) f.task.update(instructor, { revision: f.task.snapshot().revision, claim: { id: `f${index}`, text: 'c'.repeat(400), basis: 'inferred', evidence: [artifact.id] } });
  const before = f.task.snapshot();
  expect(() => f.task.update(instructor, { revision: before.revision, step: { id: 'too-many', goal: 'extra', status: 'ready' } })).toThrow();
  expect(f.task.snapshot()).toEqual(before);
  const projection = f.task.project(instructor);
  expect(projection.length).toBeLessThanOrEqual(taskLimits.projectionChars);
  expect(JSON.parse(projection).budget.calls).toBeGreaterThan(0);
  f.task.update(instructor, { revision: before.revision, step: { id: 'p0', goal: 'completed-marker', status: 'done' } });
  expect(f.task.project(instructor)).not.toContain('completed-marker');
  expect(f.task.record(instructor, 'f0')).toContain('inferred');
});

it('bounds escaped model text without committing an update that makes its projection unusable', async () => {
  const f = await setup();
  f.task.configure({ constraints: ['\\'.repeat(399), '\\'.repeat(399)] });
  f.task.update(instructor, { revision: 1, step: { id: 'p1', goal: '\u0000'.repeat(240), acceptance: '\u0000'.repeat(240), status: 'ready' } });
  const projection = f.task.project(instructor);
  expect(projection.length).toBeLessThanOrEqual(taskLimits.projectionChars);
  expect(JSON.parse(projection).steps[0].id).toBe('p1');
});

it('persists narrowly scoped unchanged-edit failures, not arbitrary command bans', async () => {
  const f = await setup(), recovery = new RequestRecovery();
  recovery.fileFailures.set(fingerprint(['edit', 'unchanged']), 'target was not found');
  recovery.commands.set('bash', 'irrelevant');
  f.task.saveRecovery(recovery);
  const restored = TaskStore.open(f.config.stateDir, 'explicit-scope', 'objective', f.scratch);
  const next = new RequestRecovery(); restored.restoreRecovery(next);
  expect([...next.fileFailures]).toEqual([...recovery.fileFailures]);
  expect(next.commands.size).toBe(0);
});

it('fails closed on corrupt state and a changed scratch scope', async () => {
  const f = await setup(), files = await readdir(join(f.config.stateDir, 'tasks'));
  expect(() => TaskStore.open(f.config.stateDir, 'explicit-scope', 'objective', join(f.cwd, 'other'))).toThrow('scope changed');
  await writeFile(join(f.config.stateDir, 'tasks', files[0]!), '{broken');
  expect(() => TaskStore.open(f.config.stateDir, 'explicit-scope', 'objective', f.scratch)).toThrow();
});

it('clears only task records whose scratchpad belongs to the removed workspace', async () => {
  const f = await setup(), store = WorkspaceStore.at(f.config.stateDir);
  const scratch = store.scratch('terminal:owned');
  TaskStore.open(f.config.stateDir, 'owned-scope', 'objective', scratch);
  await store.remove('terminal:owned');
  const files = await readdir(join(f.config.stateDir, 'tasks'));
  expect(files).toHaveLength(1);
  expect(JSON.parse(await readFile(join(f.config.stateDir, 'tasks', files[0]!), 'utf8')).scope).toBe('explicit-scope');
});

async function attempt(handler: Parameters<typeof mockServer>[0]) {
  const f = await setup(), server = await mockServer(handler); cleanups.push(server.close);
  Object.assign(f.config.models.capable, { provider: 'ollama', baseUrl: server.url });
  const telemetry = new Telemetry(f.config.stateDir, 'request-1');
  const budget = new SpendGovernor(join(f.config.stateDir, 'spend.jsonl'), 'request-1', f.config.policy.budget);
  return { ...f, telemetry, budget };
}
const run = (f: Awaited<ReturnType<typeof attempt>>) => runAttempt({ ...f, tier: 'normal', workload: 'ask', web: false, approve: async () => true, prompt: 'complete the task', task: f.task });
const isJunior = (body: any) => body.tools?.some((tool: any) => tool.function.name === 'report');

it('replaces the working projection every inference and lets a model update at the displayed revision', async () => {
  const bodies: any[] = [];
  const f = await attempt((body, _req, res) => {
    bodies.push(body);
    completion(res, bodies.length === 1 ? { tool: { name: 'task_state', arguments: { revision: 0, step: { id: 'p1', goal: 'check sources', status: 'ready' } } } }
      : bodies.length === 2 ? { tool: { name: 'task_state', arguments: { revision: 1, step: { id: 'p1', goal: 'checked sources', status: 'done' } } } } : { text: 'done' });
  });
  const result = await run(f);
  expect(result.success, JSON.stringify(result)).toBe(true);
  for (const body of bodies) expect(JSON.stringify(body.messages).split('[task state:').length - 1).toBe(1);
  expect(f.task.snapshot().steps[0]?.status).toBe('done');
  expect(f.task.snapshot().request).toMatchObject({ calls: 2, modelCalls: 3 });
});

it('uses handles for long output without repeating its producer, with bounded provider observations', async () => {
  const bodies: any[] = [], f = await attempt((body, _req, res) => {
    bodies.push(body);
    const handle = JSON.stringify(body.messages).match(/a-[a-f0-9-]{36}/)?.[0];
    completion(res, bodies.length === 1 ? { tool: { name: 'diagnostic', arguments: {} } }
      : bodies.length === 2 ? { tool: { name: 'artifact_read', arguments: { id: handle, search: 'hidden-marker', limit: 1 } } } : { text: 'found hidden-marker' });
  });
  const diagnostic = join(f.cwd, 'fixture.txt');
  await writeFile(diagnostic, `${'noise\n'.repeat(5000)}hidden-marker\n${'noise\n'.repeat(5000)}`);
  f.config.test = { fixture: { name: 'diagnostic', description: 'diagnostic', file: diagnostic } };
  const result = await run(f);
  expect(result.success, JSON.stringify(result)).toBe(true);
  expect((await events(f.config)).filter(event => event.type === 'fixture_invocation')).toHaveLength(1);
  expect(JSON.stringify(bodies[1])).not.toContain('hidden-marker');
  expect(JSON.stringify(bodies[2])).toContain('5001: hidden-marker');
  expect(f.task.snapshot().artifacts).toHaveLength(1);
  expect(bodies[1].messages.find((message: any) => message.role === 'tool')?.content.length).toBeLessThan(2600);
});

it('shares a request-wide ceiling with juniors and retains child evidence without exposing parent context', async () => {
  let calls = 0; const childBodies: any[] = [];
  const f = await attempt((body, _req, res) => {
    if (isJunior(body)) {
      childBodies.push(body);
      return completion(res, childBodies.length === 1 ? { tool: { name: 'write', arguments: { path: 'notes.txt', content: 'child evidence' } } }
        : { tool: { name: 'report', arguments: { status: 'done', summary: 'wrote notes.txt' } } });
    }
    completion(res, ++calls === 1 ? { tool: { name: 'delegate_task', arguments: { type: 'implement', message: 'narrow child objective' } } } : { text: 'received report' });
  });
  f.task.startRequest('aggregate', { calls: 8, modelCalls: 10, timeoutMs: 10_000 });
  const result = await run(f);
  expect(result.success, JSON.stringify(result)).toBe(true);
  expect(f.task.snapshot().request).toMatchObject({ calls: 3, modelCalls: 4, delegations: 1 });
  expect(JSON.stringify(childBodies[0])).not.toContain('original objective');
  expect(f.task.snapshot().juniors[0]?.turn).toBe(1);
  const restored = TaskStore.open(f.config.stateDir, 'explicit-scope', 'objective', f.scratch);
  expect(restored.snapshot().juniors[0]?.turns[0]?.assistant).toContain('wrote notes.txt');
});

it('does not pause the aggregate deadline while the instructor waits', async () => {
  const f = await attempt(async (body, _req, res) => {
    if (isJunior(body)) { await new Promise(resolve => setTimeout(resolve, 400)); return completion(res, { text: 'late' }); }
    completion(res, { tool: { name: 'delegate_task', arguments: { type: 'research', message: 'slow child' } } });
  });
  f.task.startRequest('short', { calls: 10, modelCalls: 10, timeoutMs: 180 });
  const result = await run(f);
  expect(result.success).toBe(false);
  expect(result.stopped).toBe('timeout');
});

it('blocks further provider requests when the aggregate model allowance is exhausted', async () => {
  let requests = 0;
  const f = await attempt((_body, _req, res) => { requests++; completion(res, { tool: { name: 'read', arguments: { path: 'notes.txt' } } }); });
  await writeFile(join(f.scratch, 'notes.txt'), 'evidence');
  f.task.startRequest('short', { calls: 10, modelCalls: 1, timeoutMs: 10_000 });
  const result = await run(f);
  expect(result.success).toBe(false); expect(requests).toBe(1);
  expect(result.stopped).toBe('turn_limit');
});

it('preserves working state through history compaction and accounts for the summary call', async () => {
  const bodies: any[] = [];
  const f = await attempt((body, _req, res) => {
    bodies.push(body);
    completion(res, { text: JSON.stringify(body.messages[0]).includes('context summarization assistant') ? '## Goal\nprevious task context' : 'answer' });
  });
  f.task.update(instructor, { revision: 0, step: { id: 'p1', goal: 'decisive-state-marker', status: 'working' } });
  f.config.test = { historyTokens: 1000 };
  const history = [{ user: 'old question', assistant: 'irrelevant history '.repeat(1000) }, { user: 'next question', assistant: 'short answer' }];
  const result = await runAttempt({ ...f, tier: 'normal', workload: 'ask', web: false, approve: async () => true, prompt: 'continue', task: f.task, history });
  expect(result.success, JSON.stringify(result)).toBe(true);
  expect(bodies.some(body => JSON.stringify(body.messages[0]).includes('context summarization assistant'))).toBe(true);
  expect(JSON.stringify(bodies.at(-1))).toContain('decisive-state-marker');
  expect(f.task.snapshot().request?.modelCalls).toBe(bodies.length);
});

it('continues an explicitly named task across host requests without trusting model completion as checks', async () => {
  let calls = 0; const bodies: any[] = [];
  const f = await attempt((body, _req, res) => {
    bodies.push(body); calls++;
    completion(res, calls === 1 ? { tool: { name: 'task_state', arguments: { revision: 0, step: { id: 'p1', goal: 'persistent-goal', status: 'working' } } } } : { text: 'answer' });
  });
  f.config.routingMode = 'direct';
  const request = { cwd: f.cwd, prompt: 'first objective', workload: 'ask' as const, tier: 'normal' as const, taskId: 'explicit', sessionId: 'session', scratch: f.scratch };
  const deps = { approve: async () => true, localProbe: async () => true };
  const first = await runHost(f.config, request, deps);
  expect(first.taskId).toBe('explicit');
  const second = await runHost(f.config, { ...request, prompt: 'follow-up' }, deps);
  expect(second.success).toBe(true);
  expect(JSON.stringify(bodies.at(-1))).toContain('persistent-goal');
  expect(second.check).toBeUndefined();
  expect(JSON.stringify(bodies.at(-1))).toContain('follow-up');
  const states = await readdir(join(f.config.stateDir, 'tasks'));
  const persisted = await Promise.all(states.map(async file => JSON.parse(await readFile(join(f.config.stateDir, 'tasks', file), 'utf8'))));
  expect(persisted.find(state => state.scope.includes('explicit') && state.currentRequest === 'follow-up')?.objective).toBe('first objective');
});

it('reserves a read-only synthesis turn even when every inspection returns new evidence', async () => {
  let requests = 0;
  const f = await attempt((body, _req, res) => {
    requests++;
    completion(res, body.tools?.some((tool: any) => tool.function?.name === 'read')
      ? { tool: { name: 'read', arguments: { path: `source-${requests}.txt` } } } : { text: '<plan>source-backed proposal with gaps</plan>' });
  });
  for (let index = 1; index <= 5; index++) await writeFile(join(f.scratch, `source-${index}.txt`), `unique evidence ${index}`);
  f.config.policy.limits.maxToolCalls = 5;
  const result = await runAttempt({ ...f, tier: 'normal', workload: 'ask', web: false, approve: async () => true, prompt: 'plan only', task: f.task, readOnly: true });
  expect(result.success, JSON.stringify(result)).toBe(true);
  expect(result.toolCalls).toBe(3); expect(requests).toBe(4);
});

it('keeps user amendments distinct from the objective and marks earlier reported blockers as historical', async () => {
  const f = await setup();
  f.task.update(instructor, { revision: 0, step: { id: 'source', goal: 'reference missing', status: 'blocked' } });
  expect(JSON.parse(f.task.project(instructor)).steps[0].historical).toBe(false);
  f.task.configure({ currentRequest: 'use https://github.com/id-Software/wolf3d' });
  f.task.startRequest('next', { calls: 24, modelCalls: 20, timeoutMs: 10_000, readOnly: true });
  const state = f.task.snapshot();
  expect(state.objective).toBe('original objective');
  expect(state.currentRequest).toContain('id-Software/wolf3d');
  expect(JSON.parse(f.task.project(instructor)).steps[0]).toMatchObject({ status: 'blocked', historical: true });
  const reopened = TaskStore.open(f.config.stateDir, 'explicit-scope', 'ignored', f.scratch);
  expect(reopened.snapshot().currentRequest).toBe(state.currentRequest);
});

it('gives a read-only model a final synthesis turn after repetitive inspection', async () => {
  let requests = 0;
  const f = await attempt((body, _req, res) => {
    requests++;
    completion(res, body.tools?.some((tool: any) => tool.function?.name === 'read')
      ? { tool: { name: 'read', arguments: { path: 'current.txt' } } } : { text: '<plan>known evidence; reference unavailable</plan>' });
  });
  await writeFile(join(f.scratch, 'current.txt'), 'current observation');
  f.config.policy.escalation.repeatedToolCalls = 2;
  const result = await runAttempt({ ...f, tier: 'normal', workload: 'ask', web: false, approve: async () => true, prompt: 'give a plan only', task: f.task, readOnly: true });
  expect(result.success, JSON.stringify(result)).toBe(true);
  expect(result.text).toContain('<plan>'); expect(requests).toBe(4);
  expect(result.toolCalls).toBe(3);
});
