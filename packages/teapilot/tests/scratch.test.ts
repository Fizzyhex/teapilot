import { afterEach, expect, it } from 'vitest';
import { access, mkdir, readFile, readdir, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createWriteTool } from '@earendil-works/pi-coding-agent';
import type { Message } from '@earendil-works/pi-ai';
import { completion, events, fixture, mockServer } from './helpers.js';
import { captureResult, scratchTools } from '../src/agents/scratchpad.js';
import { fitHistory } from '../src/agents/history.js';
import { repositoryTools } from '../src/agents/repository.js';
import { runAttempt } from '../src/agents/run.js';
import { ExecutionPolicy } from '../src/execution/policy.js';
import { SpendGovernor } from '../src/inference/budget.js';
import { emptyUsage } from '../src/integration/inference.js';
import { Telemetry } from '../src/telemetry/outcome.js';
import { workspace } from '../src/agents/workspace.js';
import { clip, runLimits, type WorkspaceSandbox } from '../src/workspace/sandbox.js';
import { keepResult, Scratch, scratchLimits } from '../src/workspace/scratch.js';
import { WorkspaceStore } from '../src/workspace/store.js';

const cleanups: Array<() => Promise<unknown>> = [];
afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup(); });
async function setup() {
  const f = await fixture(); cleanups.push(f.cleanup);
  const scratch = join(f.config.stateDir, 'workspaces', 'session', '.scratch');
  await mkdir(scratch, { recursive: true });
  return { ...f, scratch };
}
const exists = (path: string) => access(path).then(() => true, () => false);
const textOf = (result: { content: Array<{ type: string; text?: string }> }) => result.content[0]?.text ?? '';
/** A log with a marker only in its middle, where no preview reaches. */
const log = (lines = 10_000, marker = 'MARKER-7f2a record=r-0042 cause=timezone-offset') =>
  Array.from({ length: lines }, (_, index) => index === Math.floor(lines / 2) ? marker : `event ${index} ok`).join('\n') + '\n';

it('keeps output whole and redacted, even with a secret split across chunks, and names files apart', async () => {
  const { scratch } = await setup();
  const pad = new Scratch(scratch, ['hunter2-secret']);
  async function* chunks() { yield 'token hunt'; yield 'er2-sec'; yield 'ret end\nline two\n'; }
  const first = await pad.save('logs', 'bash', chunks());
  expect(await readFile(first.path, 'utf8')).toBe('token [REDACTED] end\nline two\n');
  expect(first).toMatchObject({ lines: 2, complete: true });
  const second = await pad.save('logs', 'bash', 'again');
  expect(first.path).toMatch(/bash-1\.log$/);
  expect(second.path).toMatch(/bash-2\.log$/);
  expect(pad.describe()).toMatch(/logs\/bash-2\.log \(0\.0 KB\); logs\/bash-1\.log/);
});

it('stops a file at its limit and says it is incomplete; a known-short source is incomplete too', async () => {
  const { scratch } = await setup();
  const limit = scratchLimits.fileBytes;
  scratchLimits.fileBytes = 1000;
  cleanups.push(async () => { scratchLimits.fileBytes = limit; });
  const pad = new Scratch(scratch);
  const cut = await pad.save('outputs', 'big', 'x'.repeat(5000), '.txt');
  expect(cut).toMatchObject({ bytes: 1000, complete: false });
  expect(cut.path).toMatch(/big-1\.partial\.txt$/);
  expect((await pad.save('logs', 'stopped', 'half', '.log', true)).complete).toBe(false);
});

it('clears what an interrupted save left behind, and never lists it', async () => {
  const { scratch } = await setup();
  await mkdir(join(scratch, 'logs'), { recursive: true });
  await writeFile(join(scratch, 'logs', '.abandoned.tmp'), 'half');
  const pad = new Scratch(scratch);
  expect(pad.describe()).toBe('');
  await pad.save('logs', 'bash', 'whole');
  expect(await readdir(join(scratch, 'logs'))).toEqual(['bash-1.log']);
});

it('shows long results as their start and end, with where the rest is; short ones stand, and failures to keep say so', async () => {
  const { scratch, cwd } = await setup();
  const pad = new Scratch(scratch);
  expect(await keepResult(pad, 'tool', 'short')).toBeUndefined();
  const text = log();
  const kept = (await keepResult(pad, 'run_import_diagnostic', text))!;
  expect(kept.text.length).toBeLessThan(scratchLimits.previewChars + 500);
  expect(kept.text).not.toContain('MARKER-7f2a');
  expect(kept.text).toMatch(/Full output saved to .*run_import_diagnostic-1\.txt \(10000 lines\)/);
  expect(await readFile(kept.saved!.path, 'utf8')).toBe(text);
  // A scratchpad that cannot be written: the outcome stands, and nothing claims a copy exists.
  await writeFile(join(cwd, 'blocked'), 'a file, not a folder');
  const failed = (await keepResult(new Scratch(join(cwd, 'blocked')), 'tool', text))!;
  expect(failed.saved).toBeUndefined();
  expect(failed.text).toMatch(/Output beyond this excerpt was not kept/);
  expect(await keepResult(new Scratch(join(cwd, 'blocked')), 'tool', 'y'.repeat(3000))).toBeUndefined();
});

it('moves the full output pi kept in its own temp file into the scratchpad, and ignores paths command output names', async () => {
  const { scratch, config, cwd } = await setup();
  const pad = new Scratch(scratch);
  const policy = new ExecutionPolicy(cwd, config, async () => true, undefined, scratch);
  const temporary = join(tmpdir(), `pi-bash-scratchtest${Date.now()}.log`);
  await writeFile(temporary, log(3000));
  const tail = `event 2999 ok\n\n[Showing lines 1000-3000 of 3000. Full output: ${temporary}]`;
  const kept = (await captureResult(pad, policy, 'bash', { command: 'make' }, tail, { fullOutputPath: temporary }))!;
  expect(await exists(temporary)).toBe(false);
  expect(kept.text).toMatch(/^First lines:\nevent 0 ok/);
  expect(kept.text).toContain('[Showing lines 1000-3000 of 3000.]');
  expect(kept.text).not.toContain(temporary);
  expect(await readFile(kept.saved!.path, 'utf8')).toContain('MARKER-7f2a');
  // A command can print anything, a pi trailer included; only pi's own temp files are taken.
  const planted = join(cwd, 'pi-bash-planted.log');
  await writeFile(planted, 'not pi output');
  const spoofed = await captureResult(pad, policy, 'bash', { command: 'cat x' }, `x\n[Showing lines 1-1 of 1. Full output: ${planted}]`, undefined);
  expect(spoofed).toBeUndefined();
  expect(await exists(planted)).toBe(true);
  // Reading the scratchpad's own files is not new output.
  expect(await captureResult(pad, policy, 'bash', { command: `cat ${scratch}/logs/bash-1.log` }, log(), undefined)).toBeUndefined();
});

it('lets the agent work in its scratchpad without repository access, and never counts it as a project change', async () => {
  const { scratch, config, cwd } = await setup();
  config.policy.permissions = ['inference'];
  const approvals: string[] = [];
  const policy = new ExecutionPolicy(cwd, config, async approval => { approvals.push(approval.kind); return true; }, undefined, scratch);
  const write = policy.wrap(createWriteTool(cwd));
  await write.execute('w', { path: join(scratch, 'notes.md'), content: 'x'.repeat(200_000) });
  await write.execute('w', { path: join(scratch, 'notes.md'), content: 'short' });
  expect(await readFile(join(scratch, 'notes.md'), 'utf8')).toBe('short');
  expect(approvals).toEqual([]);
  await expect(write.execute('w', { path: 'project.txt', content: 'x' })).rejects.toThrow('Missing repository.write permission');
  // Only this session's scratchpad: not the state around it, nor another session's.
  await mkdir(join(config.stateDir, 'workspaces', 'other', '.scratch'), { recursive: true });
  for (const path of [join(scratch, '..', 'people.png'), join(config.stateDir, 'workspaces', 'other', '.scratch', 'x'), join(config.stateDir, 'spend.jsonl'), join(scratch, '..', '..', 'session2', '.scratch', 'x')]) {
    await expect(policy.path(path, true)).rejects.toThrow();
  }
});

it('refuses a scratchpad a command replaced with a link, for the host\'s saves and the agent\'s file tools alike', async () => {
  const { config, cwd } = await setup();
  const outside = join(cwd, 'outside');
  await mkdir(outside);
  const planted = join(config.stateDir, 'workspaces', 'planted', '.scratch');
  await mkdir(join(config.stateDir, 'workspaces', 'planted'), { recursive: true });
  await symlink(outside, planted, process.platform === 'win32' ? 'junction' : 'dir');
  await expect(new Scratch(planted).save('logs', 'bash', 'x')).rejects.toThrow(/link/);
  const policy = new ExecutionPolicy(cwd, config, async () => true, undefined, planted);
  await expect(policy.path(join(planted, 'notes.md'), true)).rejects.toThrow('Linked paths are not allowed');
  expect(await readdir(outside)).toEqual([]);
});

it('searches the scratchpad from a repository session, naming files so read can open them', async () => {
  const { scratch, config, cwd } = await setup();
  await mkdir(join(scratch, 'logs'), { recursive: true });
  await writeFile(join(scratch, 'logs', 'bash-1.log'), log());
  const policy = new ExecutionPolicy(cwd, config, async () => true, undefined, scratch);
  const search = repositoryTools(policy).find(tool => tool.name === 'repo_search')!;
  const found = JSON.parse(textOf(await search.execute('s', { path: scratch, query: 'MARKER-7f2a' })));
  expect(found.results).toEqual([{ path: join(scratch, 'logs', 'bash-1.log').split('\\').join('/'), line: 5001, text: 'MARKER-7f2a record=r-0042 cause=timezone-offset' }]);
  // Without repository access, the same tools are rooted at the scratchpad, where paths are its own.
  config.policy.permissions = ['inference'];
  const own = scratchTools(new ExecutionPolicy(scratch, config, async () => true, undefined, scratch));
  expect(own.map(tool => tool.name)).toEqual(['list_files', 'search_files', 'read', 'write', 'edit']);
  expect(JSON.parse(textOf(await own[0]!.execute('l', {}))).results).toEqual(['logs/bash-1.log']);
  // `.scratch/` is what sandboxed commands call it, and it means the same folder to every file tool.
  expect(JSON.parse(textOf(await own[1]!.execute('s', { path: '.scratch/logs', query: 'MARKER-7f2a' }))).results).toHaveLength(1);
  expect(textOf(await own[2]!.execute('r', { path: '.scratch/logs/bash-1.log', offset: 5001, limit: 1 }))).toContain('MARKER-7f2a');
  expect(policy.inScratch('.scratch/logs/bash-1.log')).toBe(true);
  // A complete search says it is complete, and the same search again says it will find nothing more.
  expect(JSON.parse(textOf(await own[1]!.execute('s', { query: 'no-such-text' }))).note).toMatch(/^These are all 0 matches in scope: the text does not occur there/);
  const again = JSON.parse(textOf(await own[1]!.execute('s', { path: '.scratch/logs', query: 'MARKER-7f2a', limit: 200 })));
  expect(again.note).toMatch(/^Same matches as your earlier search for this text; searching again will not find more\. These are all 1 matches/);
});

it('keeps all of a workspace command\'s output when its result leaves some out, where commands there can read it', async () => {
  const f = await setup();
  const store = WorkspaceStore.at(join(f.cwd, 'state'));
  const out = log(3000);
  let cancelled = false;
  const sandbox: WorkspaceSandbox = {
    status: async () => ({ available: true, shell: 'bash', tools: [] }),
    run: async (_folder, _command, options) => {
      for (const part of out.match(/[\s\S]{1,4096}/g)!) options.tee?.(part);
      return { exitCode: cancelled ? null : 0, output: clip(out, runLimits.outputChars), timedOut: false, cancelled, clipped: true };
    },
  };
  const pad = new Scratch(store.scratch('dm:1'));
  const tools = (await workspace({ store, conversation: 'dm:1', sandbox }, { latest: () => undefined, block: () => undefined, used: new Set() }, async () => true, undefined, pad)).tools;
  const run = tools.find(tool => tool.name === 'workspace_run')!;
  const text = textOf(await run.execute('r', { command: 'make' }));
  expect(text).toContain('Commands here see it as .scratch/logs/workspace_run-1.log.');
  expect(await readFile(join(store.scratch('dm:1'), 'logs', 'workspace_run-1.log'), 'utf8')).toBe(out);
  // People never see the scratchpad among the conversation's files.
  expect(store.list('dm:1')).toEqual([]);
  cancelled = true;
  expect(textOf(await run.execute('r', { command: 'make' }))).toMatch(/workspace_run-2\.partial\.log \(3000 lines, incomplete\)/);
});

it('keeps where the full output went when an earlier turn is cut down', () => {
  const model = { provider: 'mock', id: 'mock-model' };
  const saved = 'Full output saved to /state/.scratch/logs/bash-1.log (10000 lines); read or search it for anything not shown here.';
  const steps: Message[] = [
    { role: 'assistant', content: [{ type: 'toolCall', id: 'c1', name: 'bash', arguments: { command: 'make' } }], api: 'openai-completions', provider: 'mock', model: 'mock-model', timestamp: 0, usage: emptyUsage(), stopReason: 'toolUse' },
    { role: 'toolResult', toolCallId: 'c1', toolName: 'bash', content: [{ type: 'text', text: `${'noise '.repeat(500)}\n${saved}` }], isError: false, timestamp: 0 },
  ];
  const turns = [{ user: 'build it', assistant: 'built', steps }, { user: 'and now?', assistant: 'done' }];
  const replayed = JSON.stringify(fitHistory(turns, 100_000, model));
  expect(replayed).toContain('…[clipped]');
  expect(replayed).toContain(saved);
});

async function attempt(handler: Parameters<typeof mockServer>[0]) {
  const f = await setup();
  const server = await mockServer(handler); cleanups.push(server.close);
  Object.assign(f.config.models.capable, { provider: 'ollama', baseUrl: server.url });
  const telemetry = new Telemetry(f.config.stateDir, 'scratch-test');
  const budget = new SpendGovernor(join(f.config.stateDir, 'spend.jsonl'), 'scratch-test', f.config.policy.budget);
  const diagnostic = join(f.config.stateDir, 'fixture', 'snapshot.txt');
  await mkdir(join(f.config.stateDir, 'fixture'), { recursive: true });
  await writeFile(diagnostic, log());
  f.config.test = { fixture: { name: 'run_import_diagnostic', description: 'Run the import diagnostic.', file: diagnostic } };
  return { ...f, telemetry, budget };
}

it('keeps a long result whole, so a later search finds what the preview left out', async () => {
  const bodies: any[] = [];
  const f = await attempt((body, _req, res) => {
    bodies.push(body);
    const step = bodies.length;
    completion(res, step === 1 ? { tool: { name: 'run_import_diagnostic', arguments: {} } }
      : step === 2 ? { tool: { name: 'search_files', arguments: { query: 'r-0042' } } }
      : { text: 'r-0042 failed on a timezone offset.' });
  });
  const result = await runAttempt({ ...f, tier: 'normal', workload: 'ask', web: false, approve: async () => true, prompt: 'why did r-0042 fail?', scratch: f.scratch });
  expect(result.success, JSON.stringify(result)).toBe(true);
  expect(bodies[0].tools.map((tool: { function: { name: string } }) => tool.function.name)).toEqual(expect.arrayContaining(['read', 'write', 'edit', 'list_files', 'search_files', 'run_import_diagnostic']));
  expect(bodies[0].messages[0].content).toContain(`Your scratchpad is ${f.scratch}`);
  const preview = JSON.stringify(bodies[1].messages.at(-1));
  expect(preview).not.toContain('r-0042');
  expect(preview).toContain('run_import_diagnostic-1.txt');
  expect(JSON.stringify(bodies[2].messages.at(-1))).toContain('MARKER-7f2a record=r-0042');
  const recorded = await events(f.config);
  expect(recorded.filter(event => event.type === 'fixture_invocation')).toHaveLength(1);
  expect(recorded.find(event => event.type === 'scratch_saved')).toMatchObject({ tool: 'run_import_diagnostic', lines: 10000, complete: true });
  expect(recorded.find(event => event.type === 'scratch_access')).toMatchObject({ tool: 'search_files', file: '.' });
});

it('hands a forced retry what already ran and where its output is, without running it again', async () => {
  let calls = 0;
  const f = await attempt((_body, _req, res) => { calls++; completion(res, calls === 1 ? { tool: { name: 'run_import_diagnostic', arguments: {} } } : { text: 'more' }); });
  f.config.test!.forceRetry = 'run_import_diagnostic';
  const result = await runAttempt({ ...f, tier: 'normal', workload: 'ask', web: false, approve: async () => true, prompt: 'run the diagnostic', scratch: f.scratch, attempt: 0 });
  expect(result.reason).toBe('turn_limit');
  const handoff = JSON.parse(result.handoff!);
  expect(handoff.observations).toEqual([expect.objectContaining({ tool: 'run_import_diagnostic', failed: false, saved: expect.stringMatching(/run_import_diagnostic-1\.txt$/) })]);
  expect(handoff.scratchpad.files).toContain('outputs/run_import_diagnostic-1.txt');
  expect(handoff.note).toMatch(/rather than repeating commands/);
  expect((await events(f.config)).filter(event => event.type === 'fixture_invocation')).toHaveLength(1);
});

it('writes notes into the scratchpad in a session without repository access, and reports no project change', async () => {
  let calls = 0;
  const f = await attempt((_body, _req, res) => { calls++; completion(res, calls === 1 ? { tool: { name: 'write', arguments: { path: 'notes.md', content: '# rules\n- 22 wins' } } } : { text: 'noted' }); });
  const result = await runAttempt({ ...f, tier: 'normal', workload: 'ask', web: false, approve: async () => true, prompt: 'remember the rules', scratch: f.scratch });
  expect(await readFile(join(f.scratch, 'notes.md'), 'utf8')).toBe('# rules\n- 22 wins');
  expect(await exists(join(f.cwd, 'notes.md'))).toBe(false);
  expect(result.changedFiles).toEqual([]);
  expect((await events(f.config)).find(event => event.type === 'scratch_access')).toMatchObject({ tool: 'write', file: 'notes.md' });
});

it('with the scratchpad off, still bounds a long result but keeps none of it', async () => {
  const bodies: any[] = [];
  const f = await attempt((body, _req, res) => { bodies.push(body); completion(res, bodies.length === 1 ? { tool: { name: 'run_import_diagnostic', arguments: {} } } : { text: 'ok' }); });
  f.config.scratchpad = { enabled: false };
  await runAttempt({ ...f, tier: 'normal', workload: 'ask', web: false, approve: async () => true, prompt: 'run it', scratch: f.scratch });
  expect(bodies[0].tools.map((tool: { function: { name: string } }) => tool.function.name)).not.toEqual(expect.arrayContaining(['search_files']));
  expect(bodies[0].messages[0].content).not.toContain('scratchpad');
  const preview = JSON.stringify(bodies[1].messages.at(-1));
  expect(preview).toContain('characters left out');
  expect(preview).not.toContain('MARKER-7f2a');
  expect(preview).not.toContain('saved to');
  expect(await readdir(f.scratch)).toEqual([]);
});
