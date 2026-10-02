import { afterEach, expect, it } from 'vitest';
import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { completion, events, fixture, mockServer } from './helpers.js';
import { runAttempt } from '../src/agents/run.js';
import { delegateTool, juniorAllowance, juniorName, juniorTypes } from '../src/agents/delegate.js';
import { RequestAllowance } from '../src/agents/allowance.js';
import { TaskStore } from '../src/workspace/task.js';
import { SpendGovernor } from '../src/inference/budget.js';
import { Telemetry } from '../src/telemetry/outcome.js';
import { describeTool } from '../src/presentation.js';

const cleanups: Array<() => Promise<unknown>> = [];
it('allocates the type allowance while reserving four shared calls for the instructor', () => {
  expect(juniorAllowance(38, 40)).toBe(34);
  expect(juniorAllowance(38, 20)).toBe(20);
  expect(juniorAllowance(3, 40)).toBe(0);
  expect(juniorAllowance(4, 40)).toBe(0);
  expect(juniorAllowance(5, 40)).toBe(1);
  expect(juniorAllowance(6, 40)).toBe(2);
  expect(juniorAllowance(10, 40)).toBe(6);
  expect(juniorAllowance(38, 0)).toBe(0);
});
afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup(); });
async function setup(handler: Parameters<typeof mockServer>[0]) {
  const f = await fixture(); cleanups.push(f.cleanup);
  const server = await mockServer(handler); cleanups.push(server.close);
  for (const model of [f.config.models.capable, f.config.models.fast]) Object.assign(model, { provider: 'ollama', baseUrl: server.url });
  const telemetry = new Telemetry(f.config.stateDir, 'delegate-test');
  await telemetry.event('start', {});
  const budget = new SpendGovernor(join(f.config.stateDir, 'spend.jsonl'), 'delegate-test', f.config.policy.budget);
  return { ...f, budget, telemetry, scratch: join(f.cwd, '.scratch') };
}
const junior = (body: any) => names(body).includes('report');
const names = (body: any): string[] => (body.tools ?? []).map((tool: any) => tool.function.name);
const run = (f: Awaited<ReturnType<typeof setup>>, extra: Partial<Parameters<typeof runAttempt>[0]> = {}) =>
  runAttempt({ ...f, tier: 'normal', workload: 'coder', web: false, approve: async () => true, prompt: 'Build the thing', ...extra });

it('hands a task to a junior in a clean context and sees only its report', async () => {
  const bodies: { instructor: any[]; junior: any[] } = { instructor: [], junior: [] };
  const f = await setup((body, _req, res) => {
    if (junior(body)) {
      bodies.junior.push(body);
      completion(res, bodies.junior.length === 1 ? { tool: { name: 'write', arguments: { path: 'a.txt', content: 'hello' } } }
        : { tool: { name: 'report', arguments: { status: 'done', summary: 'Wrote a.txt and read it back.' } } });
    } else {
      bodies.instructor.push(body);
      completion(res, bodies.instructor.length === 1 ? { tool: { name: 'delegate_task', arguments: { type: 'implement', message: 'Create a.txt containing hello.' } } } : { text: 'All done.' });
    }
  });
  const seen: any[] = [];
  const result = await run(f, { scratch: f.scratch, onEvent: event => seen.push(event) });
  expect(result.success, JSON.stringify(result)).toBe(true);
  expect(await readFile(join(f.cwd, 'a.txt'), 'utf8')).toBe('hello');

  expect(names(bodies.instructor[0])).toContain('delegate_task');
  expect(names(bodies.junior[0])).toContain('report');
  expect(names(bodies.junior[0])).not.toContain('delegate_task');
  expect(names(bodies.junior[0])).not.toContain('request_escalation');
  // The junior starts from its instruction alone.
  expect(JSON.stringify(bodies.junior[0].messages)).not.toContain('Build the thing');
  expect(JSON.stringify(bodies.junior[0].messages)).toContain('Create a.txt containing hello.');

  const report = JSON.stringify(bodies.instructor[1].messages);
  expect(report).toContain('Junior junior-alfa, turn 1: done');
  expect(report).toContain('Files changed: a.txt');
  expect(report).toContain('Wrote a.txt and read it back.');
  expect(bodies.instructor[1].messages.some((message: any) => JSON.stringify(message.tool_calls ?? '').includes('"write"'))).toBe(false);

  // People see the junior's tools, named, and never its words.
  expect(seen.filter(event => event.junior === 'junior-alfa').map(event => `${event.type}:${event.tool}`)).toEqual(
    ['tool_execution_start:write', 'tool_execution_end:write', 'tool_execution_start:report', 'tool_execution_end:report']);
  expect(seen.some(event => event.type === 'text' && event.junior)).toBe(false);
  expect(seen.find(event => event.type === 'tool_execution_end' && event.tool === 'delegate_task')?.to).toBe('junior-alfa');

  // Its transcript is its own; the instructor's stays the one its conversation reopens.
  const own = await readdir(join(f.scratch, 'juniors', 'junior-alfa', 'sessions'));
  expect(own).toHaveLength(1);
  const [instructor] = await readdir(join(f.scratch, 'sessions'));
  expect(await readFile(join(f.scratch, 'sessions', instructor!), 'utf8')).toContain('delegate_task');
  expect((await events(f.config)).find(event => event.type === 'delegate')).toMatchObject({ junior: 'junior-alfa', turn: 1, status: 'done' });
});

it('continues the same junior with its history, and passes its questions back', async () => {
  const bodies: { instructor: any[]; junior: any[] } = { instructor: [], junior: [] };
  const f = await setup((body, _req, res) => {
    if (junior(body)) {
      bodies.junior.push(body);
      // No report the first time: its last words stand in for one.
      completion(res, bodies.junior.length === 1 ? { text: 'Found three bugs in parser.ts.' }
        : { tool: { name: 'report', arguments: { status: 'needs_input', summary: 'Two are fixed.', question: 'Should the third keep its old behaviour?' } } });
    } else {
      bodies.instructor.push(body);
      completion(res, bodies.instructor.length === 1 ? { tool: { name: 'delegate_task', arguments: { type: 'implement', message: 'Find the bugs in parser.ts.' } } }
        : bodies.instructor.length === 2 ? { tool: { name: 'delegate_task', arguments: { junior: 'junior-alfa', message: 'Fix them.' } } }
        : { text: 'Asking the person.' });
    }
  });
  const result = await run(f, { scratch: f.scratch });
  expect(result.success, JSON.stringify(result)).toBe(true);
  expect(JSON.stringify(bodies.instructor[1].messages)).toContain('Found three bugs in parser.ts.');
  const second = JSON.stringify(bodies.junior[1].messages);
  expect(second).toContain('Find the bugs in parser.ts.');
  expect(second).toContain('Found three bugs in parser.ts.');
  expect(second).toContain('Fix them.');
  const reply = JSON.stringify(bodies.instructor[2].messages);
  expect(reply).toContain('Junior junior-alfa, turn 2: needs_input');
  expect(reply).toContain('Question: Should the third keep its old behaviour?');
});

it('withdraws delegation once the attempt has sent its limit', async () => {
  const bodies: any[] = [];
  const f = await setup((body, _req, res) => {
    if (junior(body)) return completion(res, { tool: { name: 'report', arguments: { status: 'done', summary: 'ok' } } });
    bodies.push(body);
    completion(res, bodies.length === 1 ? { tool: { name: 'delegate_task', arguments: { type: 'research', message: 'One.' } } } : { text: 'Finished myself.' });
  });
  f.config.policy.limits.maxJuniorTurns = 1;
  const result = await run(f, { scratch: f.scratch });
  expect(result.success).toBe(true);
  expect(names(bodies[0])).toContain('delegate_task');
  expect(names(bodies[1])).not.toContain('delegate_task');
});

it('offers no delegation without a scratchpad, when turned off, or on a short context', async () => {
  const bodies: any[] = [];
  const f = await setup((body, _req, res) => { bodies.push(body); completion(res, { text: 'ok' }); });
  await run(f, { scratch: undefined });
  f.config.delegation = { enabled: false };
  await run(f, { scratch: f.scratch });
  f.config.delegation = { enabled: true };
  await run(f, { scratch: f.scratch, tier: 'fast', workload: 'ask' });
  expect(bodies).toHaveLength(3);
  expect(bodies.map(body => names(body).includes('delegate_task'))).toEqual([false, false, false]);
});

it('stops the instructor\'s clock while a junior works', async () => {
  let instructorCalls = 0;
  const f = await setup(async (body, _req, res) => {
    if (junior(body)) {
      await new Promise(resolve => setTimeout(resolve, 250));
      return completion(res, { tool: { name: 'report', arguments: { status: 'done', summary: 'ok' } } });
    }
    instructorCalls++;
    completion(res, instructorCalls <= 3 ? { tool: { name: 'delegate_task', arguments: { type: 'research', message: `Part ${instructorCalls}.` } } } : { text: 'All parts done.' });
  });
  // Three juniors of 250ms each outlast the instructor's own 500ms, which only counts its own time.
  f.config.policy.limits.attemptTimeoutMs = 500;
  const result = await run(f, { scratch: f.scratch });
  expect(result.stopped).toBeUndefined();
  expect(result.success, JSON.stringify(result)).toBe(true);
});

it('cancels the junior with the request', async () => {
  const controller = new AbortController();
  const f = await setup((body, _req, res) => {
    if (junior(body)) { controller.abort(); return completion(res, { text: 'late' }); }
    completion(res, { tool: { name: 'delegate_task', arguments: { type: 'research', message: 'Long task.' } } });
  });
  const result = await run(f, { scratch: f.scratch, signal: controller.signal });
  expect(result.stopped).toBe('cancelled');
  expect(result.success).toBe(false);
});

it('names juniors after free teachat identities, then phonetically', () => {
  const identities = [{ username: 'juner', leased: true }, { username: 'daniel', leased: false }, { username: 'marlow', leased: false }];
  expect(juniorName(identities, new Set(), () => 0)).toBe('junior-daniel');
  expect(juniorName(identities, new Set(['junior-daniel']), () => 0)).toBe('junior-marlow');
  expect(juniorName(identities, new Set(['junior-daniel', 'junior-marlow']))).toBe('junior-alfa');
  expect(juniorName([], new Set(['junior-alfa']))).toBe('junior-bravo');
  const alphabet = ['alfa', 'bravo', 'charlie', 'delta', 'echo', 'foxtrot', 'golf', 'hotel', 'india', 'juliett', 'kilo', 'lima', 'mike',
    'november', 'oscar', 'papa', 'quebec', 'romeo', 'sierra', 'tango', 'uniform', 'victor', 'whiskey', 'xray', 'yankee', 'zulu'].map(word => `junior-${word}`);
  expect(juniorName([], new Set(alphabet))).toBe('junior-alfa-2');
});

it('labels a junior\'s calls with its name', () => {
  expect(describeTool({ type: 'tool_execution_end', tool: 'read', path: 'a.ts', junior: 'daniel' })).toBe('daniel: read a.ts');
  expect(describeTool({ type: 'tool_execution_end', tool: 'delegate_task', to: 'daniel' })).toBe('delegate_task → daniel');
});

it('works in its instructor\'s folder when neither has the repository', async () => {
  let instructorCalls = 0, juniorCalls = 0;
  const f = await setup((body, _req, res) => {
    if (junior(body)) return completion(res, ++juniorCalls === 1 ? { tool: { name: 'write', arguments: { path: 'notes.txt', content: 'from the junior' } } }
      : { tool: { name: 'report', arguments: { status: 'done', summary: 'Wrote notes.txt.' } } });
    completion(res, ++instructorCalls === 1 ? { tool: { name: 'delegate_task', arguments: { type: 'implement', message: 'Write notes.txt.' } } }
      : instructorCalls === 2 ? { tool: { name: 'read', arguments: { path: 'notes.txt' } } } : { text: 'Read it.' });
  });
  const result = await run(f, { scratch: f.scratch, workload: 'ask' });
  expect(result.success, JSON.stringify(result)).toBe(true);
  expect(await readFile(join(f.scratch, 'notes.txt'), 'utf8')).toBe('from the junior');
});

it('keeps report for a junior whose other tools are withdrawn', async () => {
  const bodies: any[] = [];
  let instructorCalls = 0;
  const f = await setup((body, _req, res) => {
    if (junior(body)) {
      bodies.push(body);
      // A tool it does not have is refused, until the host withdraws everything but report.
      return completion(res, names(body).length > 1 ? { tool: { name: 'bash', arguments: { command: 'npm test' } } }
        : { tool: { name: 'report', arguments: { status: 'stuck', summary: 'I could not run the tests.' } } });
    }
    completion(res, ++instructorCalls === 1 ? { tool: { name: 'delegate_task', arguments: { type: 'implement', message: 'Run the tests.' } } } : { text: 'The junior could not run them.' });
  });
  await run(f, { scratch: f.scratch, workload: 'ask' });
  expect(names(bodies.at(-1))).toEqual(['report']);
  expect((await events(f.config)).find(event => event.type === 'delegate')).toMatchObject({ status: 'stuck' });
  expect((await events(f.config)).find(event => event.type === 'delegate')?.stopped).toBeUndefined();
});

it('tells a junior to report before the tool limit stops it', async () => {
  let instructorCalls = 0, juniorCalls = 0;
  const f = await setup((body, _req, res) => {
    if (junior(body)) {
      juniorCalls++;
      // It keeps working until the host says its calls are nearly spent.
      return completion(res, JSON.stringify(body.messages).includes('tool calls left: call report now')
        ? { tool: { name: 'report', arguments: { status: 'stuck', summary: 'Parsed half the table; rows are in notes.txt.' } } }
        : { tool: { name: 'write', arguments: { path: 'notes.txt', content: `row ${juniorCalls}` } } });
    }
    completion(res, ++instructorCalls === 1 ? { tool: { name: 'delegate_task', arguments: { type: 'implement', message: 'Parse the table.' } } } : { text: 'Noted.' });
  });
  f.config.policy.limits.maxToolCalls = 10;
  await run(f, { scratch: f.scratch });
  const delegated = (await events(f.config)).find(event => event.type === 'delegate');
  expect(delegated).toMatchObject({ status: 'stuck' });
  expect(delegated?.stopped).toBeUndefined();
  expect(delegated?.allocation).toBe(5);
  expect(juniorCalls).toBe(3);
});

it('requires a type, rejects widening it, and keeps its cumulative allowance across follow-ups', async () => {
  const f = await setup((_body, _req, res) => completion(res, { text: 'unused' }));
  const allowance = new RequestAllowance({ calls: 40, modelCalls: 50, timeoutMs: 10_000, delegations: 6 });
  const children: any[] = [];
  const parent = { ...f, tier: 'normal' as const, workload: 'coder' as const, web: false, prompt: 'parent', approve: async () => true };
  const delegated = delegateTool(parent, f.scratch, f.cwd, { pause() {}, resume() {} }, async child => {
    children.push(child);
    for (let index = 0; index < Math.min(4, child.config.policy.limits.maxToolCalls); index++) allowance.consumeTool(child.junior!.name);
    child.junior!.onReport({ status: 'done', summary: 'source-backed findings' });
    return { success: true, text: '', turns: 1, toolCalls: Math.min(4, child.config.policy.limits.maxToolCalls) };
  }, allowance);
  const text = (result: any) => result.content[0].text;
  expect(text(await delegated.tool.execute('a', { message: 'inspect sources' }))).toContain('choose a junior type');
  expect(delegated.tool.parameters).not.toHaveProperty('properties.max_calls');
  await delegated.tool.execute('b', { type: 'research', message: 'inspect sources' });
  await delegated.tool.execute('c', { junior: 'junior-alfa', message: 'clarify findings' });
  expect(children.map(child => child.config.policy.limits.maxToolCalls)).toEqual([8, 4]);
  expect(children.every(child => child.readOnly && child.junior.type === 'research')).toBe(true);
  expect(text(await delegated.tool.execute('d', { junior: 'junior-alfa', type: 'implement', message: 'make changes' }))).toContain('start a new junior');
  expect(text(await delegated.tool.execute('e', { junior: 'junior-alfa', message: 'more research' }))).toContain('allowance spent');
  expect(children).toHaveLength(2);
});

it('restores typed scope, rejects implementation in plan mode, and requires classification of legacy juniors', async () => {
  const f = await setup((_body, _req, res) => completion(res, { text: 'unused' }));
  const task = TaskStore.open(f.config.stateDir, 'typed-juniors', 'overall goal', f.scratch);
  task.startRequest('r', { calls: 24, modelCalls: 30, timeoutMs: 10_000 });
  task.saveJunior({ name: 'junior-old', scratch: f.scratch, turn: 1, turns: [] });
  task.saveJunior({ name: 'junior-reader', type: 'research', assignment: 'door mechanics only', scratch: f.scratch, turn: 1, turns: [] });
  task.consumeJunior('junior-reader');
  const restored = TaskStore.open(f.config.stateDir, 'typed-juniors', 'ignored', f.scratch);
  const allowance = new RequestAllowance({ calls: 24, modelCalls: 30, timeoutMs: 10_000, delegations: 6 }, restored);
  const children: any[] = [];
  const parent = { ...f, task: restored, tier: 'normal' as const, workload: 'coder' as const, web: false, readOnly: true, prompt: 'parent', approve: async () => true };
  const delegated = delegateTool(parent, f.scratch, f.cwd, { pause() {}, resume() {} }, async child => { children.push(child); return { success: true, text: 'findings', turns: 1, toolCalls: 0 }; }, allowance);
  const text = (result: any) => result.content[0].text;
  expect(text(await delegated.tool.execute('a', { junior: 'junior-old', message: 'continue' }))).toContain('choose a junior type');
  expect(text(await delegated.tool.execute('b', { type: 'implement', message: 'edit app' }))).toContain('unavailable in a read-only');
  await delegated.tool.execute('c', { junior: 'junior-reader', message: 'clarify opening' });
  expect(children[0].junior).toMatchObject({ type: 'research', assignment: 'door mechanics only' });
  expect(children[0].config.policy.limits.maxToolCalls).toBe(7);
});

it.each(juniorTypes)('allocates the %s type ceiling, capped by policy and shared request room', async type => {
  const f = await setup((_body, _req, res) => completion(res, { text: 'unused' }));
  const children: any[] = [];
  const parent = { ...f, tier: 'normal' as const, workload: 'coder' as const, web: false, prompt: 'parent', approve: async () => true };
  const ceiling = { research: 8, plan: 6, implement: 20, review: 8 }[type];
  for (const [policy, shared, expected] of [[40, 40, ceiling], [5, 40, 5], [40, 9, 5], [40, 5, undefined], [40, 6, 2]] as const) {
    f.config.policy.limits.maxToolCalls = policy;
    const allowance = new RequestAllowance({ calls: shared, modelCalls: 50, timeoutMs: 10_000, delegations: 6 });
    const delegated = delegateTool(parent, f.scratch, f.cwd, { pause() {}, resume() {} }, async child => {
      children.push(child);
      return { success: true, text: 'findings', turns: 1, toolCalls: 0 };
    }, allowance);
    children.length = 0;
    const result = await delegated.tool.execute('a', { type, message: 'complete the assigned task' });
    if (expected === undefined) {
      expect(children).toHaveLength(0);
      expect(result.content[0]).toMatchObject({ text: expect.stringContaining('too little room') });
    } else {
      expect(children).toHaveLength(1);
      expect(children[0].config.policy.limits.maxToolCalls).toBe(expected);
    }
  }
});
