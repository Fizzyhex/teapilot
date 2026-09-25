import { afterEach, expect, it } from 'vitest';
import { mkdir, symlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { repositoryTools } from '../src/agents/repository.js';
import { ExecutionPolicy } from '../src/execution/policy.js';
import { Evidence } from '../src/routing/escalation.js';
import { completion, fixture, mockServer } from './helpers.js';
import { runHost } from '../src/host.js';

const cleanup: Array<() => Promise<void>> = [];
afterEach(async () => { for (const fn of cleanup.splice(0).reverse()) await fn(); });
async function setup() { const f = await fixture(); cleanup.push(f.cleanup); return f; }

it('lists and searches without approval, respecting ignore rules and file boundaries', async () => {
  const f = await setup(), outside = await setup();
  await mkdir(join(f.cwd, 'src'));
  await writeFile(join(f.cwd, '.gitignore'), '*.log\n');
  await writeFile(join(f.cwd, '.env'), 'needle secret');
  await writeFile(join(f.cwd, 'ignored.log'), 'needle ignored');
  await writeFile(join(f.cwd, 'src', 'index.ts'), 'first\nneedle here\nneedle twice\n');
  await symlink(outside.cwd, join(f.cwd, 'linked'), process.platform === 'win32' ? 'junction' : 'dir');
  const tools = repositoryTools(new ExecutionPolicy(f.cwd, f.config, async () => { throw new Error('Unexpected approval'); }));
  const run = async (index: number, args: unknown) => JSON.parse((await tools[index]!.execute('id', args)).content.map(part => part.type === 'text' ? part.text : '').join(''));
  const listing = await run(0, {});
  expect(listing.results).toContain('src/index.ts');
  expect(JSON.stringify(listing.results)).not.toMatch(/\.env|ignored.log|linked/);
  expect((await run(1, { query: 'NEEDLE', path: 'src', limit: 1 }))).toMatchObject({ results: [{ path: 'src/index.ts', line: 2, text: 'needle here' }], truncated: true });
  await expect(run(0, { path: '..' })).rejects.toThrow();
  await expect(run(0, { path: 'linked' })).rejects.toThrow();
  f.config.policy.permissions = [];
  await expect(run(0, {})).rejects.toThrow('Missing repository.read');
});

it('summarises a root with many subdirectories instead of a depth-first dump', async () => {
  const f = await setup();
  for (let i = 0; i < 15; i++) {
    const dir = join(f.cwd, `repo-${i}`);
    await mkdir(dir);
    for (let j = 0; j < 30; j++) await writeFile(join(dir, `file-${j}.ts`), 'x'.repeat(50));
  }
  const tools = repositoryTools(new ExecutionPolicy(f.cwd, f.config, async () => { throw new Error('Unexpected approval'); }));
  const run = async (args: unknown) => JSON.parse((await tools[0]!.execute('id', args)).content.map(part => part.type === 'text' ? part.text : '').join(''));
  const listing = await run({});
  expect(JSON.stringify(listing.results).length).toBeLessThan(4096);
  expect(listing.truncated).toBe(true);
  expect(listing.note).toMatch(/subdirector/i);
  expect(listing.results).toHaveLength(15);
  expect(listing.results).toContain('repo-0/ (30 files)');
});

it('lists an empty child directory instead of omitting it', async () => {
  const f = await setup();
  await mkdir(join(f.cwd, 'self-contained-pong-v2'));
  await writeFile(join(f.cwd, 'readme.md'), 'hi');
  const tools = repositoryTools(new ExecutionPolicy(f.cwd, f.config, async () => { throw new Error('Unexpected approval'); }));
  const run = async (args: unknown) => JSON.parse((await tools[0]!.execute('id', args)).content.map(part => part.type === 'text' ? part.text : '').join(''));
  const listing = await run({});
  expect(listing.results).toContain('self-contained-pong-v2/ (empty)');
  expect(listing.results).toContain('readme.md');
});

it('gives repeated equivalent inspection one recovery opportunity and invalidates checks on edits', () => {
  const evidence = new Evidence({ repeatedToolCalls: 2, consecutiveFailures: 2, maxEscalations: 2 });
  evidence.observe('repo_list', {}, false, 'empty');
  evidence.observe('repo_list', { path: '.' }, false, 'empty');
  expect(evidence.reason).toBeUndefined();
  expect(evidence.warning).toContain('Change approach');
  evidence.observe('repo_list', { limit: 200 }, false, 'empty');
  expect(evidence.reason).toBe('ineffective_calls');
  const check = new Evidence({ repeatedToolCalls: 2, consecutiveFailures: 2, maxEscalations: 2 });
  check.observe('bash', { command: 'npm test' }, false);
  expect(check.lastCheck).toBe('passed');
  check.observe('write', { path: 'index.js' }, false);
  expect(check.lastCheck).toBeUndefined();
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

it('empty-repository coding can inspect and write without a shell approval', async () => {
  const f = await setup();
  let calls = 0, approvals = 0;
  const server = await mockServer((_body, req, res) => {
    if (req.url?.endsWith('/models')) { res.end('{}'); return; }
    calls++;
    if (calls === 1) completion(res, { tool: { name: 'repo_list', arguments: {} } });
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
    else completion(res, { tool: { name: 'repo_list', arguments: {} } });
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
