import { afterEach, expect, it, vi } from 'vitest';
import { ExecutionPolicy } from '../src/execution/policy.js';
import { fixture } from './helpers.js';

const cleanup: Array<() => Promise<void>> = [];
afterEach(async () => {
  vi.restoreAllMocks();
  vi.doUnmock('@earendil-works/pi-coding-agent');
  vi.resetModules();
  for (const fn of cleanup.splice(0)) await fn();
});

// execution/shell.ts caches Git Bash at module scope so it only shells out to
// `where.exe` once per process. Reset the module registry between cases so each
// mocked getShellConfig() result produces a fresh prompt.
async function coderFor(shellPath: string | null): Promise<{ systemPrompt: string; tools: string[] }> {
  vi.doMock('@earendil-works/pi-coding-agent', async () => {
    const actual = await vi.importActual<typeof import('@earendil-works/pi-coding-agent')>('@earendil-works/pi-coding-agent');
    return {
      ...actual,
      getShellConfig: () => {
        if (!shellPath) throw new Error('No bash shell found.');
        return { shell: shellPath, args: ['-c'] };
      },
    };
  });
  const { coder } = await import('../src/agents/coder.js');
  const f = await fixture();
  cleanup.push(f.cleanup);
  const policy = new ExecutionPolicy(f.cwd, f.config, async () => { throw new Error('Unexpected approval'); });
  const { systemPrompt, tools } = await coder(f.config, policy);
  return { systemPrompt, tools: tools.map(tool => tool.name) };
}

it.skipIf(process.platform !== 'win32')('gives Windows Git Bash, with how to write paths and reach PowerShell', async () => {
  const { systemPrompt, tools } = await coderFor('C:\\Program Files\\Git\\bin\\bash.exe');
  expect(tools).toContain('bash');
  expect(systemPrompt).toContain('Shell: Git Bash (');
  expect(systemPrompt).toContain('C:/x or /c/x');
  expect(systemPrompt).toContain('powershell -Command');
});

it.skipIf(process.platform !== 'win32')('has no shell on Windows without Git Bash, and says to install Git for Windows', async () => {
  const { systemPrompt, tools } = await coderFor(null);
  expect(tools).not.toContain('bash');
  expect(systemPrompt).toContain('No shell: Git Bash is missing');
});

it.skipIf(process.platform !== 'win32')('does not take WSL bash for Git Bash', async () => {
  const { tools } = await coderFor('C:\\Windows\\System32\\bash.exe');
  expect(tools).not.toContain('bash');
});

it('tells the model cd does not persist and points it at /cd', async () => {
  const { systemPrompt } = await coderFor(process.platform === 'win32' ? 'C:\\Program Files\\Git\\bin\\bash.exe' : '/bin/bash');
  expect(systemPrompt).toContain("cd doesn't persist");
  expect(systemPrompt).toContain('/cd <path>');
});

it.skipIf(process.platform === 'win32')('names bash on other platforms', async () => {
  const { systemPrompt, tools } = await coderFor('/bin/bash');
  expect(tools).toContain('bash');
  expect(systemPrompt).toContain('Shell: bash.');
});
