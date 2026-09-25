import { afterEach, expect, it, vi } from 'vitest';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { inspectHardware } from '../src/setup/hardware.js';
import { runtimeDriver } from '../src/setup/runtimes.js';
import { TabbyRuntime, TABBY_COMMIT, optimizedNvidiaPreset } from '../src/setup/tabby.js';
import { applyModelProtocol } from '../src/inference/protocol.js';
import { fixture } from './helpers.js';
import type { SetupUI } from '../src/setup/terminal.js';

const cleanup: Array<() => Promise<void>> = [];
afterEach(async () => { for (const fn of cleanup.splice(0).reverse()) await fn(); vi.restoreAllMocks(); });

function ui(): SetupUI {
  return {
    input: vi.fn(async (_message, fallback) => fallback ?? ''),
    choose: vi.fn(async () => 0),
    confirm: vi.fn(async () => true),
    log: vi.fn(),
  };
}

it('detects a suitable Windows NVIDIA GPU with nvidia-smi and does not probe non-Windows hosts', async () => {
  const run = vi.fn(async () => 'NVIDIA GeForce RTX 3090, 24576\n');
  const windows = await inspectHardware(new AbortController().signal, { platform: 'win32', run });
  expect(windows).toMatchObject({ optimizedNvidia: true, nvidia: [{ name: 'NVIDIA GeForce RTX 3090', memoryMiB: 24576 }] });
  expect(run).toHaveBeenCalledWith('nvidia-smi', expect.arrayContaining(['--query-gpu=name,memory.total']), expect.any(AbortSignal));

  const other = await inspectHardware(new AbortController().signal, { platform: 'linux', run });
  expect(other.optimizedNvidia).toBe(false);
  expect(run).toHaveBeenCalledTimes(1);
});

it('maps reasoning from model protocol rather than provider identity', async () => {
  const f = await fixture(); cleanup.push(f.cleanup);
  const model = f.config.models.capable;
  model.provider = 'anything-openai-compatible';
  model.reasoning = {
    type: 'reasoning_effort',
    values: {
      off: { templateVars: { enable_thinking: false } },
      medium: 'medium',
      xhigh: 'xhigh',
    },
  };
  expect(applyModelProtocol({ stream: true }, model, 'off')).toEqual({ stream: true, chat_template_kwargs: { enable_thinking: false } });
  expect(applyModelProtocol({ stream: true }, model, 'medium')).toEqual({ stream: true, reasoning_effort: 'medium' });
  expect(applyModelProtocol({ stream: true }, model, 'xhigh')).toEqual({ stream: true, reasoning_effort: 'xhigh' });
});

it('keeps unmanaged OpenAI-compatible setup lifecycle-free', async () => {
  const driver = runtimeDriver('openai-compatible');
  expect(driver.managed).toBe(false);
  const selection = await driver.prepare({
    ui: ui(),
    signal: new AbortController().signal,
    stateDir: '/unused',
    hardware: { platform: 'linux', nvidia: [], optimizedNvidia: false },
    options: { nonInteractive: true, endpoint: 'http://127.0.0.1:8080/v1', model: 'test-model', contextTokens: 16384 },
  });
  expect(selection).toMatchObject({
    tier: 'normal',
    model: { id: 'test-model', provider: 'local', baseUrl: 'http://127.0.0.1:8080/v1', reasoningEfforts: ['off'] },
  });
});

it('installs, starts, provisions, reuses and stops Tabby through mocked process/network boundaries', async () => {
  const state = await mkdtemp(join(tmpdir(), 'teapilot-tabby-'));
  cleanup.push(() => rm(state, { recursive: true, force: true }));
  let started = false, active = false;
  const installed = new Set<string>();
  const downloads: any[] = [];
  const killed: number[] = [];
  let runtime!: TabbyRuntime;

  const command = vi.fn(async (executable: string, args: string[]) => {
    if (executable === 'py' && args.includes('-c')) return '3.12\n';
    if (executable === 'git' && args[0] === '--version') return 'git version 2.50\n';
    if (executable === 'git' && args[0] === 'clone') {
      await mkdir(String(args.at(-1)), { recursive: true });
      return '';
    }
    if (args.includes('venv')) {
      const destination = String(args.at(-1));
      await mkdir(join(destination, 'Scripts'), { recursive: true });
      await writeFile(join(destination, 'Scripts', 'python.exe'), '');
      return '';
    }
    return '';
  });

  const fetchMock = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(typeof input === 'string' ? input : input instanceof URL ? input.href : input.url);
    if (url.pathname === '/.well-known/serviceinfo') {
      if (!started) throw new TypeError('connection refused');
      return Response.json({ software: { name: 'TabbyAPI' } });
    }
    if (url.pathname === '/v1/models') return Response.json({ data: [...installed].map(id => ({ id })) });
    if (url.pathname === '/v1/download') {
      const body = JSON.parse(String(init?.body));
      downloads.push(body); installed.add(body.folder_name);
      return Response.json({ download_path: 'managed-model-path' });
    }
    if (url.pathname === '/v1/model/load') {
      const body = JSON.parse(String(init?.body));
      expect(body).toMatchObject({
        model_name: optimizedNvidiaPreset.modelFolder,
        backend: 'exllamav3',
        max_seq_len: 32768,
        draft_model: { draft_model_name: optimizedNvidiaPreset.drafterFolder },
      });
      active = true;
      return new Response('data: {"status":"finished"}\n\n', { headers: { 'Content-Type': 'text/event-stream' } });
    }
    if (url.pathname === '/v1/model') return active ? Response.json({ id: optimizedNvidiaPreset.modelFolder }) : new Response('{}', { status: 404 });
    throw new Error(`Unexpected request ${url.pathname}`);
  });

  runtime = new TabbyRuntime(state, {
    platform: 'win32',
    command: command as any,
    fetch: fetchMock as any,
    spawn: vi.fn(() => {
      started = true;
      return { pid: 4242, exitCode: null, unref() {} } as any;
    }) as any,
    kill: vi.fn((pid: number) => { killed.push(pid); return true; }) as any,
  });

  const hardware = { platform: 'win32' as const, optimizedNvidia: true, nvidia: [{ name: 'RTX 3090', memoryMiB: 24576 }] };
  await runtime.ensureInstalled(hardware, new AbortController().signal);
  expect(command).toHaveBeenCalledWith('git', ['-C', runtime.repoDir, 'checkout', '--detach', TABBY_COMMIT], expect.any(AbortSignal));

  await runtime.provision(ui(), new AbortController().signal);
  expect(downloads).toEqual([
    { repo_id: optimizedNvidiaPreset.modelRepo, folder_name: optimizedNvidiaPreset.modelFolder, revision: optimizedNvidiaPreset.modelRevision },
    { repo_id: optimizedNvidiaPreset.drafterRepo, folder_name: optimizedNvidiaPreset.drafterFolder },
  ]);
  expect(await runtime.inspect(new AbortController().signal)).toMatchObject({ installed: true, server: 'ready', model: optimizedNvidiaPreset.modelFolder });

  downloads.length = 0;
  await runtime.provision(ui(), new AbortController().signal);
  expect(downloads).toEqual([]);

  await runtime.stop();
  expect(killed).toEqual([4242]);
});
