import { afterEach, expect, it } from 'vitest';
import { mkdir, readFile, readdir, symlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { PlanStore, compactPlan } from '../src/workspace/plan.js';
import { TaskStore, instructor } from '../src/workspace/task.js';
import { runHost } from '../src/host.js';
import { runSession } from '../src/chat.js';
import { completion, events, fixture, mockServer } from './helpers.js';

const cleanups: Array<() => Promise<unknown>> = [];
afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup(); });
async function setup() {
  const f = await fixture(); cleanups.push(f.cleanup);
  const scratch = join(f.cwd, '.scratch');
  return { ...f, scratch, plans: new PlanStore(scratch, 'task') };
}

it('keeps a stable revision path across reloads, resets approval on edits, and preserves distinct proposals', async () => {
  const f = await setup();
  const first = f.plans.save('# ../Tea Maze\nexactly 2 leaves', true);
  expect(first.path).toMatch(/^plans\/tea-maze-[\w-]+\.md$/);
  expect(f.plans.approve()?.status).toBe('approved');
  const reopened = new PlanStore(f.scratch, 'task');
  const revised = reopened.save('# new title\nexactly 2 leaves; add undo');
  expect(revised).toEqual({ ...first, revision: 2, status: 'draft' });
  expect(await readFile(join(f.scratch, revised.path), 'utf8')).toContain('add undo');
  const other = reopened.save('# unrelated plan', true);
  expect(other.path).not.toBe(first.path);
  expect(await readFile(join(f.scratch, first.path), 'utf8')).toContain('add undo');
  expect(compactPlan(`before\n<plan>${'large body '.repeat(2000)}</plan>\nafter`, revised)).not.toContain('large body');
});

it('rejects linked plan directories', async () => {
  const f = await setup();
  const outside = join(f.cwd, 'outside');
  await mkdir(outside); await mkdir(f.scratch);
  await symlink(outside, f.plans.directory, 'junction');
  expect(() => f.plans.save('plan')).toThrow('linked');
  expect(await readdir(outside)).toEqual([]);
});

it('compacts plan bodies to neutral receipts while preserving surrounding assistant text', () => {
  const plan = { path: 'plans/maze.md', revision: 2, status: 'draft' as const };
  expect(compactPlan('before\n<plan># maze\n1. build</plan>\nafter', plan)).toBe('before\n[saved plan: .scratch/plans/maze.md, revision 2, draft]\nafter');
  expect(compactPlan('<PLAN>first</PLAN>\n<plan>second</plan>', { ...plan, status: 'approved' })).toBe('[saved plan: .scratch/plans/maze.md, revision 2, approved]\n[saved plan: .scratch/plans/maze.md, revision 2, approved]');
  expect(compactPlan('which source should i use?', plan)).toBe('which source should i use?');
});

it('rejects traversal in stored references rather than touching files outside plans', async () => {
  const f = await setup(); f.plans.save('plan');
  const index = (await readdir(f.plans.directory)).find(name => name.endsWith('.json'))!;
  await writeFile(join(f.plans.directory, index), JSON.stringify({ path: '../outside.md', revision: 1, status: 'draft' }));
  expect(() => f.plans.current()).toThrow();
});

it('pins the mutable plan reference without leaking it to juniors or indexing it as evidence', async () => {
  const f = await setup();
  const plan = f.plans.save('# maze\n2 leaves');
  const task = TaskStore.open(f.config.stateDir, 'scope', 'objective', f.scratch);
  task.startRequest('r', { calls: 10, modelCalls: 10, timeoutMs: 10000 });
  task.setPlan(plan);
  expect(JSON.parse(task.project(instructor)).plan).toEqual(plan);
  expect(JSON.parse(task.project({ name: 'junior' })).plan).toBeUndefined();
  expect(task.snapshot().artifacts).toEqual([]);
  expect(TaskStore.open(f.config.stateDir, 'scope', 'objective', f.scratch).snapshot().plan).toEqual(plan);
});

it('persists host output before returning, survives forced compaction, and revises the same file', async () => {
  const f = await setup();
  const bodies: any[] = [];
  let phase = 0;
  let readPlan = false;
  const server = await mockServer((body, _request, response) => {
    bodies.push(body);
    const summary = JSON.stringify(body.messages[0]).includes('context summarization assistant');
    if (phase === 1 && !summary && !readPlan) {
      readPlan = true;
      return completion(response, { tool: { name: 'read', arguments: { path: `.scratch/${f.plans.current()!.path}` } } });
    }
    completion(response, { text: summary ? 'earlier discussion omitted' : phase === 0 ? '<plan># tea maze\nexactly 3 rooms; exactly 2 leaves; no timers</plan>' : phase === 1 ? '<plan># tea maze\nexactly 3 rooms; exactly 2 leaves; no timers; add undo</plan>' : 'approved plan loaded' });
  });
  cleanups.push(server.close);
  f.config.routingMode = 'direct';
  Object.assign(f.config.models.capable, { provider: 'ollama', baseUrl: server.url });
  f.config.test = { historyTokens: 0 };
  const request = { cwd: f.cwd, prompt: 'plan a maze', taskObjective: 'tea maze', workload: 'ask' as const, tier: 'normal' as const, taskId: 'task', sessionId: 'session', scratch: f.scratch, readOnly: true };
  const dependencies = { approve: async () => true, localProbe: async () => true };
  const first = await runHost(f.config, { ...request, planAction: 'new' }, dependencies);
  expect(first.success, JSON.stringify(first)).toBe(true);
  const plan = f.plans.current()!;
  expect(await readFile(join(f.scratch, plan.path), 'utf8')).toContain('exactly 2 leaves');
  expect(first.historyText).toContain(plan.path);
  expect(first.historyText).not.toContain('exactly 2 leaves');
  expect(first.historyText).not.toContain('[host notice]');
  expect(first.historyText).not.toContain('read it before');
  expect(first.text).toContain('<plan>');
  expect(first.steps).toBeUndefined();
  phase = 1;
  const second = await runHost(f.config, { ...request, prompt: 'add undo without changing scope', planAction: 'revise', history: [{ user: '/plan tea maze', assistant: first.historyText!, taskId: 'task' }] }, dependencies);
  expect(second.success, JSON.stringify(second)).toBe(true);
  expect(readPlan).toBe(true);
  expect(second.steps).toBeUndefined();
  expect((await events(f.config)).some(event => event.type === 'compaction')).toBe(true);
  expect(JSON.stringify(bodies.at(-1))).toContain(plan.path);
  expect(f.plans.current()).toEqual({ ...plan, revision: 2 });
  expect(await readFile(join(f.scratch, plan.path), 'utf8')).toContain('add undo');
  phase = 2;
  await runHost(f.config, { ...request, prompt: 'go ahead', planAction: 'approve', readOnly: false }, dependencies);
  expect(f.plans.current()).toEqual({ ...plan, revision: 2, status: 'approved' });
  expect(JSON.stringify(bodies.at(-1))).toContain('approved');
});

it('keeps current plan guidance in the request, not replayed assistant messages', async () => {
  const f = await setup(); const bodies: any[] = [];
  const server = await mockServer((body, _req, res) => {
    bodies.push(body);
    completion(res, { text: bodies.length === 1 ? 'here is the proposal\n<plan># maze\n1. build two rooms\n2. verify</plan>' : 'which source should i use?' });
  }); cleanups.push(server.close);
  f.config.routingMode = 'direct'; Object.assign(f.config.models.capable, { provider: 'ollama', baseUrl: server.url });
  const request = { cwd: f.cwd, prompt: 'plan a maze', workload: 'ask' as const, tier: 'normal' as const, scratch: f.scratch, taskId: 'task', readOnly: true };
  const deps = { approve: async () => true, localProbe: async () => true };
  const first = await runHost(f.config, { ...request, planAction: 'new' }, deps);
  expect(first.success, JSON.stringify(first)).toBe(true);
  const second = await runHost(f.config, { ...request, prompt: 'assign juniors', planAction: 'revise', history: [{ user: '/plan maze', assistant: first.historyText! }] }, deps);
  expect(second.success, JSON.stringify(second)).toBe(true);
  const messages = bodies.at(-1).messages;
  const assistants = messages.filter((message: any) => message.role === 'assistant');
  expect(JSON.stringify(assistants)).toContain('[saved plan:');
  expect(JSON.stringify(assistants)).not.toContain('[host notice]');
  expect(JSON.stringify(assistants)).not.toContain('return complete revisions');
  const current = JSON.stringify(messages.at(-1));
  expect(messages.at(-1).role).toBe('user');
  expect(current).toContain('[host notice] current plan:');
  expect(current).toContain('read it before revising or executing');
  expect(current).toContain('assign juniors');
  expect(f.plans.current()?.revision).toBe(1);
});

it('session history keeps the short plan reference rather than full output or presentation templates', async () => {
  const f = await setup();
  let history: any[] = [];
  await runSession({ request: { cwd: f.cwd, prompt: '/plan maze' }, maxPromptChars: 24000, once: true, input: async () => '', onHistory: value => { history = value; },
    run: async request => {
      expect(request.planAction).toBe('new'); expect(request.readOnly).toBe(true);
      return { requestId: 'r', success: true, status: 'completed', text: '<plan>full body</plan>', historyText: 'saved plan reference', spentUsd: 0, receipts: [], attempts: 1 };
    } });
  expect(history[0]).toMatchObject({ user: '/plan maze', assistant: 'saved plan reference' });
});

it('repairs a missing wrapper once with tools withdrawn before saving the proposal', async () => {
  const f = await setup(); const bodies: any[] = [];
  const server = await mockServer((body, _req, res) => {
    bodies.push(body);
    completion(res, { text: bodies.length === 1 ? '# implementation plan\n1. add doors\n2. verify collision' : '<plan># implementation plan\n1. add doors\n2. verify collision</plan>' });
  }); cleanups.push(server.close);
  f.config.routingMode = 'direct'; Object.assign(f.config.models.capable, { provider: 'ollama', baseUrl: server.url });
  const result = await runHost(f.config, { cwd: f.cwd, prompt: 'plan doors', workload: 'ask', tier: 'normal', scratch: f.scratch, taskId: 'task', readOnly: true, planAction: 'new' }, { approve: async () => true, localProbe: async () => true });
  expect(result.success, JSON.stringify(result)).toBe(true);
  expect(bodies).toHaveLength(2);
  expect(bodies[1].tools ?? []).toHaveLength(0);
  expect(JSON.stringify(bodies[1])).toContain('complete existing proposal');
  expect(f.plans.current()?.revision).toBe(1);
});

it('does not manufacture a plan from a clarification or overwrite an existing plan after failed repair', async () => {
  const f = await setup(); const original = f.plans.save('# existing plan\n1. keep exact scope');
  let phase = 0; const bodies: any[] = [];
  const server = await mockServer((body, _req, res) => { bodies.push(body); completion(res, { text: phase ? '# implementation plan\n1. add doors\n2. verify collision' : 'which source should I use?' }); }); cleanups.push(server.close);
  f.config.routingMode = 'direct'; Object.assign(f.config.models.capable, { provider: 'ollama', baseUrl: server.url });
  const request = { cwd: f.cwd, prompt: 'refine plan', workload: 'ask' as const, tier: 'normal' as const, scratch: f.scratch, taskId: 'task', readOnly: true, planAction: 'revise' as const };
  const deps = { approve: async () => true, localProbe: async () => true };
  expect((await runHost(f.config, request, deps)).success).toBe(true);
  expect(bodies).toHaveLength(1); expect(f.plans.current()).toEqual(original);
  phase = 1; bodies.length = 0;
  const result = await runHost(f.config, request, deps);
  expect(result.success).toBe(false); expect(result.status).toBe('invalid_plan');
  expect(bodies).toHaveLength(2); expect(f.plans.current()).toEqual(original);
});
