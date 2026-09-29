import { afterEach, expect, it } from 'vitest';
import { mkdir, symlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { inventory, sessionTools } from '../src/agents/tools.js';
import { ExecutionPolicy } from '../src/execution/policy.js';
import { Evidence } from '../src/routing/escalation.js';
import { completion, fixture, mockServer } from './helpers.js';
import { runHost } from '../src/host.js';

const cleanup: Array<() => Promise<void>> = [];
afterEach(async () => { for (const fn of cleanup.splice(0).reverse()) await fn(); });
async function setup() { const f = await fixture(); cleanup.push(f.cleanup); return f; }
const noApproval = async () => { throw new Error('Unexpected approval'); };

it('lists, finds and searches without approval, respecting ignore rules and file boundaries', async () => {
  const f = await setup(), outside = await setup();
  await mkdir(join(f.cwd, 'src'));
  await writeFile(join(f.cwd, '.gitignore'), '*.log\n');
  await writeFile(join(f.cwd, '.env'), 'needle secret');
  await writeFile(join(f.cwd, 'ignored.log'), 'needle ignored');
  await writeFile(join(f.cwd, 'src', 'index.ts'), 'first\nneedle here\nneedle twice\n');
  await symlink(outside.cwd, join(f.cwd, 'linked'), process.platform === 'win32' ? 'junction' : 'dir');
  const tools = sessionTools(new ExecutionPolicy(f.cwd, f.config, noApproval), { stateDir: f.config.stateDir });
  expect(tools.map(tool => tool.name)).toEqual(['read', 'write', 'edit', 'ls', 'find', 'grep']);
  const run = async (name: string, args: unknown) => (await tools.find(tool => tool.name === name)!.execute('id', args)).content.map(part => part.type === 'text' ? part.text : '').join('');
  const listing = await run('ls', {});
  expect(listing).toContain('src/');
  expect(listing).not.toMatch(/\.env|linked/);
  const found = await run('find', { pattern: '*' });
  expect(found).toContain('src/index.ts');
  expect(found).not.toMatch(/\.env|ignored\.log|linked/);
  expect(await run('find', { pattern: '*.ts', path: 'src' })).toBe('index.ts');
  // pi's grep runs rg --hidden: lines from protected files are dropped all the same.
  const matches = await run('grep', { pattern: 'needle', ignoreCase: true });
  expect(matches).toContain('src/index.ts:2: needle here');
  expect(matches).not.toMatch(/secret|ignored/);
  expect(await run('grep', { pattern: 'NEEDLE', path: 'src', ignoreCase: true, limit: 1 })).toMatch(/^index\.ts:2: needle here\n\n\[1 matches limit reached/);
  await expect(run('ls', { path: '..' })).rejects.toThrow();
  await expect(run('ls', { path: 'linked' })).rejects.toThrow('Linked');
  await expect(run('grep', { pattern: 'x', path: '.env' })).rejects.toThrow('protected');
  f.config.policy.permissions = [];
  await expect(run('ls', {})).rejects.toThrow('Missing repository.read');
});

it('opens a code session with each folder of the root and the files in it', async () => {
  const f = await setup();
  for (let i = 0; i < 15; i++) {
    const dir = join(f.cwd, `repo-${i}`);
    await mkdir(dir);
    for (let j = 0; j < 30; j++) await writeFile(join(dir, `file-${j}.ts`), 'x'.repeat(50));
  }
  await mkdir(join(f.cwd, 'self-contained-pong-v2'));
  await writeFile(join(f.cwd, 'readme.md'), 'hi');
  const listed = await inventory(new ExecutionPolicy(f.cwd, f.config, noApproval));
  expect(listed.length).toBeLessThan(4096);
  expect(listed.split('\n')).toHaveLength(17);
  expect(listed).toContain('repo-0/ (30 files)');
  expect(listed).toContain('self-contained-pong-v2/ (empty)');
  expect(listed).toContain('readme.md');
});

it('reaches the conversation\'s workspace from a repository as .workspace/, without repository permissions', async () => {
  const f = await setup();
  const workspace = join(f.config.stateDir, 'workspaces', 'abc');
  await mkdir(workspace, { recursive: true });
  f.config.policy.permissions = ['repository.read'];
  const tools = sessionTools(new ExecutionPolicy(f.cwd, f.config, noApproval, undefined, undefined, false, workspace), { stateDir: f.config.stateDir });
  const run = async (name: string, args: unknown) => (await tools.find(tool => tool.name === name)!.execute('id', args)).content.map(part => part.type === 'text' ? part.text : '').join('');
  await run('write', { path: '.workspace/apps/game.js', content: 'export default 1;\n' });
  expect(await run('read', { path: '.workspace/apps/game.js' })).toContain('export default 1;');
  expect(await run('find', { pattern: '*.js', path: '.workspace' })).toBe('apps/game.js');
  // The rest of the state directory stays protected.
  await expect(run('read', { path: join(f.config.stateDir, 'spend.jsonl') })).rejects.toThrow('Host state is protected');
});

it('gives repeated equivalent inspection one recovery opportunity and invalidates checks on edits', () => {
  const evidence = new Evidence({ repeatedToolCalls: 2, consecutiveFailures: 2, maxEscalations: 2 });
  evidence.observe('ls', {}, false, 'empty');
  evidence.observe('ls', { path: '.' }, false, 'empty');
  expect(evidence.reason).toBeUndefined();
  expect(evidence.warning).toContain('Change approach');
  evidence.observe('ls', { limit: 200 }, false, 'empty');
  expect(evidence.reason).toBe('ineffective_calls');
  // discord.play calls carry their code in the reply, so the same arguments with new results are progress.
  const play = new Evidence({ repeatedToolCalls: 2, consecutiveFailures: 2, maxEscalations: 2 });
  play.observe('play_start', { title: 'Game' }, false, 'App problem: syntax');
  play.observe('play_start', { title: 'Game' }, false, 'App problem: duplicate id');
  expect(play.reason).toBeUndefined();
  play.observe('play_start', { title: 'Game' }, false, 'App problem: duplicate id');
  // A live app is worth answering about: tools are withdrawn first, and only a further repeat ends the attempt.
  expect(play.reason).toBeUndefined();
  expect(play.answerNow).toBe(true);
  play.observe('play_start', { title: 'Game' }, false, 'App problem: duplicate id');
  expect(play.reason).toBe('ineffective_calls');
  const check = new Evidence({ repeatedToolCalls: 2, consecutiveFailures: 2, maxEscalations: 2 });
  check.observe('bash', { command: 'npm test' }, false);
  expect(check.lastCheck).toBe('passed');
  check.observe('write', { path: 'index.js' }, false);
  expect(check.lastCheck).toBeUndefined();
  // Editing a scratchpad script between runs makes the next run a new experiment, though it changes nothing in the project.
  const scratch = new Evidence({ repeatedToolCalls: 2, consecutiveFailures: 2, maxEscalations: 2 }, [], path => path.startsWith('/s/'));
  scratch.observe('powershell', { command: 'python .scratch/fit.py' }, false, 'error');
  scratch.observe('edit', { path: '/s/fit.py' }, false);
  scratch.observe('powershell', { command: 'python .scratch/fit.py' }, false, 'error');
  expect(scratch.reason).toBeUndefined();
  expect(scratch.changedFiles.size).toBe(0);
  scratch.observe('powershell', { command: 'python .scratch/fit.py' }, false, 'error');
  expect(scratch.reason).toBe('ineffective_calls');
});

it('repeated searches warn, then refuse further searches instead of aborting', () => {
  const evidence = new Evidence({ repeatedToolCalls: 2, consecutiveFailures: 2, maxEscalations: 2 });
  evidence.observe('web_search', { query: 'a' }, false, 'same results');
  evidence.observe('web_search', { query: 'b' }, false, 'same results');
  expect(evidence.warning).toContain('Stop searching');
  expect(evidence.searchExhausted).toBe(false);
  evidence.observe('web_search', { query: 'c' }, false, 'same results');
  expect(evidence.reason).toBeUndefined();
  expect(evidence.searchExhausted).toBe(true);
});

it('refuses further searches at once when every search engine is unavailable', () => {
  const evidence = new Evidence({ repeatedToolCalls: 3, consecutiveFailures: 2, maxEscalations: 2 });
  evidence.observe('web_search', { query: 'a' }, false, 'No results: the search engines were unavailable (brave: Suspended). Retrying will not help.');
  expect(evidence.searchExhausted).toBe(true);
});

it('empty-repository coding can inspect and write without a shell approval', async () => {
  const f = await setup();
  let calls = 0, approvals = 0;
  const server = await mockServer((_body, req, res) => {
    if (req.url?.endsWith('/models')) { res.end('{}'); return; }
    calls++;
    if (calls === 1) completion(res, { tool: { name: 'ls', arguments: {} } });
    else if (calls === 2) completion(res, { tool: { name: 'write', arguments: { path: 'index.html', content: '<canvas id="pong"></canvas>' } } });
    else completion(res, { text: 'Created the canvas; gameplay is not implemented.' });
  }); cleanup.push(server.close);
  f.config.routingMode = 'direct'; f.config.models.capable.baseUrl = server.url;
  const result = await runHost(f.config, { cwd: f.cwd, workload: 'coder', prompt: 'Create a Pong canvas' }, { approve: async () => { approvals++; return false; } });
  expect(result.success).toBe(true);
  expect(approvals).toBe(0);
  expect(calls).toBe(3);
});

it('a local inspection loop preserves same-tier recovery and reports its final failure', async () => {
  const f = await setup();
  const server = await mockServer((_body, req, res) => {
    if (req.url?.endsWith('/models')) res.end('{}');
    else completion(res, { tool: { name: 'ls', arguments: {} } });
  }); cleanup.push(server.close);
  f.config.routingMode = 'direct'; f.config.models.capable.baseUrl = server.url;
  f.config.models.fast.enabled = false;
  const result = await runHost(f.config, { cwd: f.cwd, workload: 'coder', prompt: 'Create Pong' }, { approve: async () => false });
  expect(result).toMatchObject({ success: false, status: 'ineffective_calls', attempts: 4 });
  expect(result.text).toContain('ineffective calls');
  expect(result.text).toContain('configured escalation limit reached');
  expect(result.text).toContain('Checks after latest observed edit: not run');
  expect(result.text).toContain('Next:');
});

it('does not claim a denied shell command executed or changed files', async () => {
  const f = await setup();
  const server = await mockServer((_body, req, res) => {
    if (req.url?.endsWith('/models')) res.end('{}');
    else completion(res, { tool: { name: process.platform === 'win32' ? 'powershell' : 'bash', arguments: { command: 'echo denied' } } });
  }); cleanup.push(server.close);
  f.config.routingMode = 'direct'; f.config.models.capable.baseUrl = server.url;
  const result = await runHost(f.config, { cwd: f.cwd, workload: 'coder', prompt: 'Run a command' }, { approve: async () => false });
  expect(result.status).toBe('approval_denied');
  expect(result.text).not.toContain('Shell commands ran');
  expect(result.text).not.toContain('Existing edits remain');
});
