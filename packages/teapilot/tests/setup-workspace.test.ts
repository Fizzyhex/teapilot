import { afterEach, expect, it } from 'vitest';
import { configureWorkspaceStep } from '../src/setup/workspace.js';
import type { SetupUI } from '../src/setup/terminal.js';
import type { WorkspaceIO } from '../src/workspace/configure.js';
import type { SandboxStatus, Tool } from '../src/workspace/sandbox.js';
import { fixture } from './helpers.js';

const cleanup: Array<() => Promise<void>> = [];
afterEach(async () => { for (const fn of cleanup.splice(0).reverse()) await fn(); });

function ui(pick: (choices: string[]) => number, confirm = true) {
  const logs: string[] = [], menus: string[][] = [], asked: string[] = [];
  const screen = {
    log: (message: string) => { logs.push(message); },
    choose: async (_message: string, choices: string[]) => { menus.push(choices); return pick(choices); },
    confirm: async (message: string) => { asked.push(message); return confirm; },
    input: async () => '',
  } as unknown as SetupUI;
  return { screen, logs, menus, asked };
}
const setUp = (choices: string[]) => choices.findIndex(choice => choice.includes('Set up'));
const tool = (name: string, kind = name.toLowerCase()): Tool => ({ name, kind, version: '1.0' });
const system = [tool('ffmpeg'), tool('magick', 'imagemagick'), tool('python'), tool('node')];
const extras = [tool('pandoc'), tool('Pillow'), tool('numpy'), tool('yt-dlp')];

/** A sandbox that starts in `state` and gains teapilot's tools once they are installed. */
function sandbox(state: 'not set up' | 'ready' | 'installed', platform: NodeJS.Platform = 'win32') {
  const calls: string[] = [];
  let account = state !== 'not set up', pandoc = state === 'installed', packages = state === 'installed';
  const io: WorkspaceIO = {
    platform,
    status: async (): Promise<SandboxStatus> => {
      calls.push('status');
      if (!account) return { available: false, reason: 'The Windows sandbox account is not set up.', shell: 'cmd', tools: [] };
      return { available: true, shell: 'cmd', python: { executable: 'python', abi: 'cp314-win_amd64' },
        tools: [...system, ...pandoc ? [extras[0]!] : [], ...packages ? extras.slice(1) : []] };
    },
    installWindows: async () => { calls.push('windows'); account = true; return true; },
    pandocAvailable: () => true,
    installPandoc: async () => { calls.push('pandoc'); pandoc = true; },
    installPythonPackages: async () => { calls.push('packages'); packages = true; },
  };
  return { io, calls };
}

it('installs the sandbox and the extras when accepted, and lists what commands can use', async () => {
  const f = await fixture(); cleanup.push(f.cleanup);
  const env: Record<string, string> = { WORKSPACE_SANDBOX: 'off' };
  const { io, calls } = sandbox('not set up');
  const { screen, logs, menus, asked } = ui(setUp);
  const status = await configureWorkspaceStep(f.config, env, screen, new AbortController().signal, io);
  expect(menus[0]).toEqual(['Turn on and set up', 'Keep current (off)', 'Turn off']);
  expect(calls).toEqual(['status', 'windows', 'status', 'pandoc', 'packages', 'status']);
  expect(asked).toHaveLength(2);
  expect(asked[1]).toContain('pandoc 3.11');
  expect(asked[1]).toMatch(/Pillow .*numpy .*yt-dlp/);
  expect(env).toEqual({});
  expect(f.config.workspace?.sandbox).toBe('auto');
  expect(status).toBe('workspaces: on (ffmpeg, magick, python, node, pandoc, Pillow, numpy, yt-dlp)');
  expect(logs.join('\n')).not.toContain('not found inside the sandbox');
});

it('installs nothing when declined, and says which tools are missing', async () => {
  const f = await fixture(); cleanup.push(f.cleanup);
  const env: Record<string, string> = {};
  const { io, calls } = sandbox('ready');
  io.status = async () => { calls.push('status'); return { available: true, shell: 'cmd', python: { executable: 'python', abi: 'x' }, tools: [tool('python')] }; };
  const { screen, logs } = ui(setUp, false);
  expect(await configureWorkspaceStep(f.config, env, screen, new AbortController().signal, io)).toBe('workspaces: on (python)');
  expect(calls).toEqual(['status']);
  expect(logs.join('\n')).toContain('Workspace tools not found inside the sandbox: ffmpeg, imagemagick, node. Install them for all users');
});

it('asks nothing when everything is already installed', async () => {
  const f = await fixture(); cleanup.push(f.cleanup);
  const { io, calls } = sandbox('installed');
  const { screen, asked } = ui(setUp);
  expect(await configureWorkspaceStep(f.config, {}, screen, new AbortController().signal, io)).toContain('pandoc, Pillow, numpy, yt-dlp');
  expect(calls).toEqual(['status']);
  expect(asked).toEqual([]);
});

it('prints the packages the Linux sandbox needs', async () => {
  const f = await fixture(); cleanup.push(f.cleanup);
  const { io } = sandbox('ready', 'linux');
  io.status = async () => ({ available: false, reason: 'The sandbox needs bubblewrap (bwrap) not installed; socat not installed.', shell: 'bash', tools: [] });
  const { screen, logs, asked } = ui(setUp);
  expect(await configureWorkspaceStep(f.config, {}, screen, new AbortController().signal, io)).toBe('workspaces: on (sandbox not ready)');
  expect(asked).toEqual([]);
  expect(logs).toContain('Install them with your package manager, for example: sudo apt install bubblewrap socat');
});

it('turns workspaces off, or keeps the current setting, without touching the sandbox', async () => {
  const f = await fixture(); cleanup.push(f.cleanup);
  const env: Record<string, string> = {};
  const { io, calls } = sandbox('ready');
  expect(await configureWorkspaceStep(f.config, env, ui(choices => choices.indexOf('Turn off')).screen, new AbortController().signal, io)).toBe('workspaces: off');
  expect(env).toEqual({ WORKSPACE_SANDBOX: 'off' });
  expect(f.config.workspace?.sandbox).toBe('off');
  expect(await configureWorkspaceStep(f.config, env, ui(choices => choices.findIndex(choice => choice.startsWith('Keep'))).screen, new AbortController().signal, io)).toBe('workspaces: off');
  expect(env).toEqual({ WORKSPACE_SANDBOX: 'off' });
  expect(calls).toEqual([]);
});
