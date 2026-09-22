import { afterEach, expect, it } from 'vitest';
import { link, mkdir, readFile, symlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { createReadTool, createWriteTool } from '@earendil-works/pi-coding-agent';
import { ExecutionPolicy, automaticCommand, cleanChildEnvironment } from '../src/execution/policy.js';
import { fixture } from './helpers.js';

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => { for (const cleanup of cleanups.splice(0)) await cleanup(); });
async function setup() { const f = await fixture(); cleanups.push(f.cleanup); return f; }

it('rejects traversal, protected paths and custom host state paths', async () => {
  const f = await setup();
  const policy = new ExecutionPolicy(f.cwd, f.config, async () => true);
  for (const path of ['../outside.txt', '.env', '.env.production', '.git/config', '.git /config', '.git./config', '.state/spend.jsonl', 'file.txt:secret', 'NUL']) await expect(policy.path(path, true)).rejects.toThrow();
  expect(await policy.path('src/new.txt', true)).toBe(join(f.cwd, 'src/new.txt'));
  expect(await policy.path('.env.example', false)).toBe(join(f.cwd, '.env.example'));
});

it('blocks symlink/junction ancestors and hard-linked file access', async () => {
  const f = await setup();
  const outside = await setup();
  await mkdir(join(f.cwd, 'safe'));
  await symlink(outside.cwd, join(f.cwd, 'linked'), process.platform === 'win32' ? 'junction' : 'dir');
  const policy = new ExecutionPolicy(f.cwd, f.config, async () => true);
  await expect(policy.path('linked/new.txt', true)).rejects.toThrow('Linked');
  await writeFile(join(outside.cwd, 'secret'), 'secret');
  await link(join(outside.cwd, 'secret'), join(f.cwd, 'alias'));
  await expect(policy.path('alias', false)).rejects.toThrow('Linked');
});

it('requires concrete approval for significant overwrites', async () => {
  const f = await setup();
  await writeFile(join(f.cwd, 'important.txt'), 'x'.repeat(2000));
  let details = '';
  const policy = new ExecutionPolicy(f.cwd, f.config, async request => { details = request.details ?? ''; return false; });
  const tool = policy.wrap(createWriteTool(f.cwd));
  await expect(tool.execute('1', { path: 'important.txt', content: '' })).rejects.toThrow('not approved');
  expect(details).toContain('2000 chars');
  expect(await readFile(join(f.cwd, 'important.txt'), 'utf8')).toHaveLength(2000);
});

it('guards permissions even when a tool is selected directly', async () => {
  const f = await setup();
  f.config.policy.permissions = ['inference'];
  const policy = new ExecutionPolicy(f.cwd, f.config, async () => true);
  await expect(policy.wrap(createReadTool(f.cwd)).execute('1', { path: 'README.md' })).rejects.toThrow('Missing repository.read');
});

it('never treats arbitrary shell syntax as read-only inspection', () => {
  expect(automaticCommand('git status --short', [])).toBe(true);
  for (const command of ['git status --short; rm -rf /', 'git -c alias.x=!evil x', 'git diff', 'npm test', 'echo $(secret)', 'git status --short\nwhoami', 'git status --short && echo yes']) expect(automaticCommand(command, [])).toBe(false);
  expect(automaticCommand('npm test', ['npm test'])).toBe(true);
  expect(cleanChildEnvironment({ PATH: 'tools', OPENROUTER_API_KEY: 'secret', SOME_SECRET: 'hidden', NODE_OPTIONS: 'evil' })).toEqual({ PATH: 'tools' });
});
