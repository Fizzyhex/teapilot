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

// coder.ts caches its shell detection at module scope so it only shells out to
// `where.exe` once per process. Reset the module registry between cases so each
// mocked getPowerShellConfig() result produces a fresh prompt.
async function promptFor(shellPath: string | null): Promise<string> {
  vi.doMock('@earendil-works/pi-coding-agent', async () => {
    const actual = await vi.importActual<typeof import('@earendil-works/pi-coding-agent')>('@earendil-works/pi-coding-agent');
    return {
      ...actual,
      getPowerShellConfig: () => {
        if (!shellPath) throw new Error('No PowerShell executable found.');
        return { shell: shellPath, args: [] };
      },
    };
  });
  const { coder } = await import('../src/agents/coder.js');
  const f = await fixture();
  cleanup.push(f.cleanup);
  const policy = new ExecutionPolicy(f.cwd, f.config, async () => { throw new Error('Unexpected approval'); });
  return (await coder(f.config, policy)).systemPrompt;
}

it.skipIf(process.platform !== 'win32')('names pwsh 7 and omits the missing-operator warning when pwsh resolves first', async () => {
  const prompt = await promptFor('C:\\Users\\test\\AppData\\Local\\Microsoft\\WindowsApps\\pwsh.exe');
  expect(prompt).toContain('Shell: PowerShell 7+ (pwsh).');
  expect(prompt).not.toContain('&&');
});

it.skipIf(process.platform !== 'win32')('names Windows PowerShell 5.1 and warns that && / || are unavailable', async () => {
  const prompt = await promptFor('C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe');
  expect(prompt).toContain('Shell: Windows PowerShell 5.1.');
  expect(prompt).toContain('No && / || here');
  expect(prompt).toContain('if ($?)');
});

it.skipIf(process.platform !== 'win32')('falls back to naming Windows PowerShell 5.1 when detection fails', async () => {
  const prompt = await promptFor(null);
  expect(prompt).toContain('Shell: Windows PowerShell 5.1.');
});

it.skipIf(process.platform !== 'win32')('tells the model cd does not persist and points it at /cd', async () => {
  const prompt = await promptFor('C:\\Program Files\\PowerShell\\7\\pwsh.exe');
  expect(prompt).toContain("cd doesn't persist");
  expect(prompt).toContain('/cd <path>');
});

it.skipIf(process.platform === 'win32')('names bash with no PowerShell caveat on non-Windows shells', async () => {
  const prompt = await promptFor(null);
  expect(prompt).toContain('Shell: bash.');
  expect(prompt).toContain("cd doesn't persist");
  expect(prompt).not.toContain('&&');
});
