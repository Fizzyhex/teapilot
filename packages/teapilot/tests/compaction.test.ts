import { afterEach, expect, it } from 'vitest';
import { mkdir, readdir, readFile, symlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { Message } from '@earendil-works/pi-ai';
import { convertToLlm } from '@earendil-works/pi-coding-agent';
import { completion, events, fixture, mockServer } from './helpers.js';
import { compactionSettings, coveredTurns, cutMessages, markTurn, SessionLog, summaryLength, summaryMessage, turnMark } from '../src/agents/compaction.js';
import { runAttempt } from '../src/agents/run.js';
import { SpendGovernor } from '../src/inference/budget.js';
import type { ConversationTurn } from '../src/integration/events.js';
import { emptyUsage } from '../src/integration/inference.js';
import { Telemetry } from '../src/telemetry/outcome.js';
import { Scratch } from '../src/workspace/scratch.js';

const cleanups: Array<() => Promise<unknown>> = [];
afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup(); });

const user = (text: string): Message => ({ role: 'user', content: text, timestamp: 0 });
const assistant = (content: Extract<Message, { role: 'assistant' }>['content']): Message =>
  ({ role: 'assistant', content, api: 'openai-completions', provider: 'mock', model: 'mock-model', timestamp: 0, usage: emptyUsage(), stopReason: 'toolUse' });
const call = (id: string): Message => assistant([{ type: 'toolCall', id, name: 'read', arguments: { path: `${id}.txt` } }]);
const result = (id: string, size: number): Message => ({ role: 'toolResult', toolCallId: id, toolName: 'read', content: [{ type: 'text', text: `${id} `.repeat(size) }], isError: false, timestamp: 0 });
const footer = (path: string) => `\n\nFull historical transcript:\n${path}\n\nIf information required to continue is missing from this summary,\nsearch/read that transcript rather than guessing.`;

async function setup() {
  const f = await fixture(); cleanups.push(f.cleanup);
  const scratch = join(f.config.stateDir, 'workspaces', 'session', '.scratch');
  await mkdir(scratch, { recursive: true });
  return { ...f, scratch };
}

it('cuts only where a turn may start again, never between a call and its result, and says when a turn is split', () => {
  const messages = [user('first'), call('a'), result('a', 400), user('second'), call('b'), result('b', 400), call('c'), result('c', 400)];
  const cut = cutMessages(messages, 500)!;
  expect(cut.kept[0]!.role).toBe('assistant');
  expect(cut.kept).toEqual(messages.slice(6));
  // The cut falls inside the second request: its start is summarised on its own, the first request with the rest.
  expect(cut.turnPrefix).toEqual(messages.slice(3, 6));
  expect(cut.summarise).toEqual(messages.slice(0, 3));
  // A result too big on its own keeps its call with it.
  expect(cutMessages([user('only'), call('x'), result('x', 2000)], 10)).toMatchObject({ summarise: [], turnPrefix: [user('only')], kept: [call('x'), result('x', 2000)] });
  // Everything fits, or nothing comes before the cut: nothing to summarise.
  expect(cutMessages(messages, 1_000_000)).toBeUndefined();
  expect(cutMessages([user('only')], 1)).toBeUndefined();
});

it("sends pi's own summary message, followed by where the whole transcript is", () => {
  const message = summaryMessage({ summary: '## Goal\nShip it', tokensBefore: 900 }, '/s/.scratch/sessions/0a1b2c3d.jsonl');
  const [pi] = convertToLlm([{ role: 'compactionSummary', summary: '## Goal\nShip it', tokensBefore: 900, timestamp: 0 } as never]);
  const text = (m: Message) => (m.content as Array<{ text: string }>).map(part => part.text).join('');
  expect(text(message)).toBe(text(pi!) + footer('/s/.scratch/sessions/0a1b2c3d.jsonl'));
  expect(text(message)).toContain('<summary>\n## Goal\nShip it\n</summary>');
  expect(text(summaryMessage({ summary: 'x', tokensBefore: 1 }))).toBe(text(pi!).replace('## Goal\nShip it', 'x'));
});

it('keeps the transcript as a redacted pi session in the scratchpad, and continues the same file later', async () => {
  const { scratch, cwd } = await setup();
  const pad = new Scratch(scratch);
  const redact = (text: string) => text.replaceAll('hunter2', '[REDACTED]');
  const first = await SessionLog.open(pad, cwd, redact);
  expect(first.path).toMatch(/[\\/]sessions[\\/][0-9a-f]{8}\.jsonl$/);
  first.mark({ request: 'r1', attempt: 0, tier: 'normal', model: 'mock' });
  first.record(user('the password is hunter2'));
  first.record(assistant([{ type: 'text', text: 'noted' }]));
  await first.flush();
  const lines = (await readFile(first.path, 'utf8')).trim().split('\n').map(line => JSON.parse(line));
  expect(lines.map(line => line.type)).toEqual(['session', 'custom', 'message', 'message']);
  expect(JSON.stringify(lines)).not.toContain('hunter2');

  const again = await SessionLog.open(pad, cwd, redact);
  expect(again.path).toBe(first.path);
  expect(again.latest()).toBeUndefined();
  const marker = { through: 'turns' as const, turn: 'abc', request: 'r1' };
  again.compaction({ summary: 'S', firstKeptEntryId: 'kept', tokensBefore: 10, details: { readFiles: ['a.txt'], modifiedFiles: [] } }, marker);
  await again.flush();
  expect((await SessionLog.open(pad, cwd)).latest()).toMatchObject({ summary: 'S', details: { readFiles: ['a.txt'], teapilot: marker } });
  expect((await readdir(join(scratch, 'sessions'))).length).toBe(1);
});

it('refuses a sessions folder that is a link', async () => {
  const { scratch, cwd, config } = await setup();
  const outside = join(config.stateDir, 'outside');
  await mkdir(outside);
  await symlink(outside, join(scratch, 'sessions'), process.platform === 'win32' ? 'junction' : 'dir');
  await expect(SessionLog.open(new Scratch(scratch), cwd)).rejects.toThrow(/link/);
});

it('selects compaction by explicit task identity instead of replaying an unrelated or legacy summary', async () => {
  const { scratch, cwd } = await setup(), log = await SessionLog.open(new Scratch(scratch), cwd);
  const made = { summary: 'legacy summary', firstKeptEntryId: 'kept', tokensBefore: 10, details: { readFiles: [], modifiedFiles: [] } };
  log.compaction(made, { through: 'request', turn: 'old', request: 'r0' });
  log.compaction({ ...made, summary: 'task A summary' }, { through: 'request', turn: 'a', request: 'r1', task: 'task-a' });
  await log.flush();
  const restored = await SessionLog.open(new Scratch(scratch), cwd);
  expect(restored.latest()?.summary).toBe('task A summary');
  expect(restored.latest('task-a')?.summary).toBe('task A summary');
  expect(restored.latest('task-b')).toBeUndefined();
});

it('keeps conversation text but replays tool steps only from the current explicit task', async () => {
  const f = await setup(), bodies: any[] = [];
  const server = await mockServer((body, _req, res) => { bodies.push(body); completion(res, { text: 'answer' }); }); cleanups.push(server.close);
  Object.assign(f.config.models.capable, { provider: 'ollama', baseUrl: server.url });
  const log = await SessionLog.open(new Scratch(f.scratch), f.cwd);
  log.compaction({ summary: 'unrelated-summary', firstKeptEntryId: 'kept', tokensBefore: 10, details: { readFiles: [], modifiedFiles: [] } }, { through: 'request', turn: 'old', request: 'old-request', task: 'old-task' });
  await log.flush();
  const history = [
    { user: 'earlier conversation', assistant: 'earlier reply', taskId: 'old-task', steps: [call('obsolete-execution'), result('obsolete-execution', 1)] },
    { user: 'legacy conversation', assistant: 'legacy reply', steps: [call('legacy-execution'), result('legacy-execution', 1)] },
    { user: 'current conversation', assistant: 'current reply', taskId: 'current-task', steps: [call('current-execution'), result('current-execution', 1)] },
  ];
  const budget = new SpendGovernor(join(f.config.stateDir, 'spend.jsonl'), 'current-request', f.config.policy.budget);
  const telemetry = new Telemetry(f.config.stateDir, 'current-request');
  const outcome = await runAttempt({ ...f, tier: 'normal', workload: 'ask', web: false, approve: async () => true, prompt: 'continue', history, budget, telemetry, taskId: 'current-task' });
  expect(outcome.success).toBe(true);
  const sent = JSON.stringify(bodies[0]);
  expect(sent).toContain('earlier conversation'); expect(sent).toContain('legacy conversation'); expect(sent).toContain('current-execution');
  expect(sent).not.toContain('obsolete-execution'); expect(sent).not.toContain('legacy-execution'); expect(sent).not.toContain('unrelated-summary');
});

it('leaves the room a reply is admitted with before compacting, and keeps pi’s defaults for large contexts', () => {
  // A 16k reply limit on a 32k context is a ceiling, not room held back: compaction starts near 21k rather than 14k.
  expect(compactionSettings({ contextTokens: 32768, maxOutputTokens: 16384 })).toEqual({ enabled: true, reserveTokens: 11468, keepRecentTokens: 8192 });
  expect(compactionSettings({ contextTokens: 32768, maxOutputTokens: 4096 })).toEqual({ enabled: true, reserveTokens: 7372, keepRecentTokens: 8192 });
  expect(compactionSettings({ contextTokens: 262144, maxOutputTokens: 8192 })).toEqual({ enabled: true, reserveTokens: 16384, keepRecentTokens: 20000 });
  expect(compactionSettings({ contextTokens: 8192, maxOutputTokens: 2048 }, false)).toEqual({ enabled: false, reserveTokens: 4096, keepRecentTokens: 2048 });
});

it('finds the turns a compaction covers, and keeps every turn when the surface has trimmed them away', () => {
  const turns: ConversationTurn[] = [1, 2, 3, 4].map(index => ({ user: `request ${index}`, assistant: `answer ${index}` }));
  expect(coveredTurns(turns, { through: 'turns', turn: markTurn(turns[1]!), request: 'old' }, 'now')).toBe(2);
  // Cut into a request: that turn stays, holding only what came after the cut.
  expect(coveredTurns(turns, { through: 'request', turn: turnMark('request 3'), request: 'old' }, 'now')).toBe(2);
  // An earlier attempt at this same request covered everything before it.
  expect(coveredTurns(turns, { through: 'request', turn: turnMark('request 5'), request: 'now' }, 'now')).toBe(4);
  expect(coveredTurns(turns.slice(2), { through: 'turns', turn: markTurn(turns[1]!), request: 'old' }, 'now')).toBe(0);
});

/** Model calls, told apart: pi's summary requests, and ordinary ones. */
const summaryRequest = (body: any) => JSON.stringify(body.messages?.[0] ?? '').includes('context summarization assistant');
const summaryText = '## Goal\n- Find why r-0042 failed\n\n## Critical Context\n- the diagnostic prints r-0042 lines';

async function attempt(handler: Parameters<typeof mockServer>[0]) {
  const f = await setup();
  const server = await mockServer(handler); cleanups.push(server.close);
  Object.assign(f.config.models.capable, { provider: 'ollama', baseUrl: server.url, contextTokens: 16384, maxOutputTokens: 1024 });
  const telemetry = new Telemetry(f.config.stateDir, 'compaction-test');
  const budget = new SpendGovernor(join(f.config.stateDir, 'spend.jsonl'), 'compaction-test', f.config.policy.budget);
  const diagnostic = join(f.config.stateDir, 'fixture', 'diagnostic.txt');
  await mkdir(join(f.config.stateDir, 'fixture'), { recursive: true });
  await writeFile(diagnostic, Array.from({ length: 3000 }, (_, index) => `event ${index} record r-${index % 97} state ok`).join('\n'));
  f.config.test = { fixture: { name: 'run_import_diagnostic', description: 'Run the import diagnostic.', file: diagnostic } };
  return { ...f, telemetry, budget };
}

it('compacts an attempt nearing the context limit with pi’s prompts, and carries on instead of stopping', async () => {
  const bodies: any[] = [];
  let reads = 0, readBeforeSummary = 0;
  const f = await attempt((body, _req, res) => {
    bodies.push(body);
    if (summaryRequest(body)) { readBeforeSummary = reads; return completion(res, { text: summaryText }); }
    const compacted = JSON.stringify(body.messages).includes('compacted into the following summary');
    completion(res, compacted ? { text: 'r-0042 is fine.' } : { tool: { name: 'read', arguments: { path: `part-${++reads}.txt` } } });
  });
  // Retrieval windows are bounded now, so enough real files must exist to reach the compaction boundary.
  for (let part = 1; part <= 32; part++) {
    await writeFile(join(f.scratch, `part-${part}.txt`), Array.from({ length: 300 }, (_, index) => `part ${part} line ${index} record r-${index % 97} state ok`).join('\n'));
  }
  const run = await runAttempt({ ...f, tier: 'normal', workload: 'ask', web: false, approve: async () => true, prompt: 'why did r-0042 fail?', scratch: f.scratch });
  expect(run.success, JSON.stringify(run)).toBe(true);
  const summaries = bodies.filter(summaryRequest);
  expect(summaries).toHaveLength(1);
  // The cut fell inside this request, so pi summarised the start of the turn with its own prompt for that.
  const asked = JSON.stringify(summaries[0].messages);
  expect(asked).toContain('This is the PREFIX of a turn that was too large to keep');
  expect(asked).toContain('why did r-0042 fail?');

  const [file] = await readdir(join(f.scratch, 'sessions'));
  const path = join(f.scratch, 'sessions', file!);
  const after = bodies[bodies.indexOf(summaries[0]) + 1];
  const lead = JSON.stringify(after.messages.find((message: unknown) => JSON.stringify(message).includes('compacted into the following summary')));
  expect(lead).toContain('The conversation history before this point was compacted into the following summary');
  expect(lead).toContain(JSON.stringify(footer(path)).slice(1, -1));
  // What was summarised is gone from the next request; the newest reads stay word for word.
  expect(readBeforeSummary).toBeGreaterThan(1);
  // Smaller result windows let several recent reads fit the same keep-recent token budget.
  const remaining = Array.from({ length: readBeforeSummary }, (_, index) => index + 1).filter(part => JSON.stringify(after.messages).includes(`part ${part} line 5 `));
  expect(remaining[0]).toBeGreaterThan(1);
  for (let part = 1; part < remaining[0]!; part++) expect(JSON.stringify(after.messages)).not.toContain(`part ${part} line 5 `);
  expect(JSON.stringify(after.messages)).toContain(`part ${readBeforeSummary} line 5 `);

  const entries = (await readFile(path, 'utf8')).trim().split('\n').map(line => JSON.parse(line));
  expect(entries.filter(entry => entry.type === 'compaction')).toEqual([expect.objectContaining({ summary: expect.stringContaining('## Goal'), details: expect.objectContaining({ teapilot: expect.objectContaining({ through: 'request' }) }) })]);
  expect(entries.filter(entry => entry.type === 'message' && entry.message.role === 'toolResult').length).toBe(reads);
  // Later turns replay what the compaction kept, not what it summarised.
  expect(run.steps!.filter(step => step.role === 'toolResult').length).toBeLessThan(entries.filter(entry => entry.type === 'message' && entry.message.role === 'toolResult').length);
});

it('summarises briefly and without thinking, saying so while it happens', async () => {
  const bodies: any[] = [];
  let reads = 0;
  const f = await attempt((body, _req, res) => {
    bodies.push(body);
    if (summaryRequest(body)) return completion(res, { text: summaryText });
    const compacted = JSON.stringify(body.messages).includes('compacted into the following summary');
    completion(res, compacted ? { text: 'r-0042 is fine.' } : { reasoning: `thinking about part ${reads + 1} `.repeat(40), tool: { name: 'read', arguments: { path: `part-${++reads}.txt` } } });
  });
  for (let part = 1; part <= 32; part++) {
    await writeFile(join(f.scratch, `part-${part}.txt`), Array.from({ length: 300 }, (_, index) => `part ${part} line ${index} record r-${index % 97} state ok`).join('\n'));
  }
  const seen: string[] = [];
  const run = await runAttempt({ ...f, tier: 'reasoning', workload: 'ask', web: false, approve: async () => true, prompt: 'why did r-0042 fail?', scratch: f.scratch, onEvent: event => seen.push(event.type) });
  expect(run.success, JSON.stringify(run)).toBe(true);
  const [summary] = bodies.filter(summaryRequest);
  // The tier thinks; its summaries do not.
  expect(bodies[0].reasoning_effort).toBe('low');
  expect(summary.reasoning_effort).toBe('none');
  expect(seen).toContain('compaction_start');
  expect((await events(f.config)).find(e => e.type === 'compaction')).toMatchObject({ trigger: 'context', ms: expect.any(Number) });
  // Only the newest reply keeps its thinking: earlier reasoning is not sent again.
  const main = bodies.filter(body => !summaryRequest(body));
  const before = main[main.indexOf(bodies[bodies.indexOf(summary) - 1])]!;
  expect(JSON.stringify(before.messages)).toContain(`thinking about part ${reads - 1}`);
  expect(JSON.stringify(before.messages)).not.toContain('thinking about part 1 ');
});

it('summarises earlier turns that no longer fit instead of dropping them, and reuses that summary next time', async () => {
  const bodies: any[] = [];
  const f = await attempt((body, _req, res) => { bodies.push(body); completion(res, { text: summaryRequest(body) ? summaryText : 'ok' }); });
  f.config.test = { ...f.config.test, historyTokens: 1000 };
  const long = (index: number) => `${`detail ${index} `.repeat(600)}`;
  const history: ConversationTurn[] = [{ user: 'request 1', assistant: long(1) }, { user: 'request 2', assistant: long(2) }, { user: 'request 3', assistant: 'answer 3' }];
  await runAttempt({ ...f, tier: 'normal', workload: 'ask', web: false, approve: async () => true, prompt: 'and now?', scratch: f.scratch, history });
  expect(bodies.filter(summaryRequest)).toHaveLength(1);
  expect(JSON.stringify(bodies[0].messages)).toContain('detail 1');
  expect(JSON.stringify(bodies[0].messages)).toContain('Use this EXACT format');
  // Each summary folds in the last, so it is held to a length for the context it has to fit in.
  expect(JSON.stringify(bodies[0].messages)).toContain(`Keep the whole summary under ${summaryLength(16384).words} words`);
  const main = JSON.stringify(bodies[1].messages);
  expect(main).toContain('compacted into the following summary');
  expect(main).toContain('request 3');
  expect(main).not.toContain('not shown here');
  expect(main).not.toContain('detail 2 detail 2');

  bodies.length = 0;
  await runAttempt({ ...f, tier: 'normal', workload: 'ask', web: false, approve: async () => true, prompt: 'and then?', scratch: f.scratch, history: [...history, { user: 'and now?', assistant: 'ok' }] });
  expect(bodies.filter(summaryRequest)).toHaveLength(0);
  expect(JSON.stringify(bodies[0].messages)).toContain('compacted into the following summary');
  expect(JSON.stringify(bodies[0].messages)).not.toContain('detail 1 detail 1');
});
