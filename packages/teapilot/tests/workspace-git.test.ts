import { execFileSync } from 'node:child_process';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import { ensureRepository } from '../src/workspace/git.js';
import type { SandboxStatus, WorkspaceSandbox } from '../src/workspace/sandbox.js';

const folders: string[] = [];
afterEach(async () => { for (const folder of folders.splice(0)) await rm(folder, { recursive: true, force: true }); });

it('ignores host captures for parent and juniors while retaining useful scratch files', async () => {
  const folder = await mkdtemp(join(tmpdir(), 'teapilot-git-ignore-'));
  folders.push(folder);
  const sandbox = { run: vi.fn(async () => {
    execFileSync('git', ['init', '-q', folder]);
    return { exitCode: 0 };
  }) } as unknown as WorkspaceSandbox;
  const status = { available: true, tools: [{ kind: 'git' }] } as SandboxStatus;
  expect(await ensureRepository(folder, sandbox, status)).toBe(true);
  const captured = [
    '.scratch/sessions/run.jsonl', '.scratch/outputs/read-1.txt', '.scratch/logs/bash-1.txt',
    '.scratch/juniors/alfa/sessions/run.jsonl', '.scratch/juniors/alfa/outputs/read-1.txt',
    '.scratch/juniors/alfa/logs/bash-1.txt'
  ];
  const useful = ['.scratch/handoff.md', '.scratch/validate.py', '.scratch/juniors/alfa/notes.md', 'catalog.json'];
  for (const name of [...captured, ...useful]) {
    await mkdir(join(folder, name, '..'), { recursive: true });
    await writeFile(join(folder, name), 'test');
  }
  const ignored = execFileSync('git', ['-C', folder, 'check-ignore', '--stdin'], {
    encoding: 'utf8', input: [...captured, ...useful].join('\n') + '\n'
  }).trim().split(/\r?\n/);
  expect(ignored.sort()).toEqual(captured.sort());
});
