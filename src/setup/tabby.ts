import { spawn, type ChildProcess } from 'node:child_process';
import { closeSync, openSync } from 'node:fs';
import { mkdir, readFile, rm, unlink, writeFile } from 'node:fs/promises';
import { randomBytes } from 'node:crypto';
import { join } from 'node:path';
import { exists } from '../config.js';
import { command } from './ollama.js';
import type { HardwareReport } from './hardware.js';
import { RuntimeFailure } from './runtime.js';
import type { SetupUI } from './terminal.js';

export const TABBY_REPOSITORY = 'https://github.com/theroyallab/tabbyAPI.git';
export const TABBY_COMMIT = 'f07131cd8fe34e449fe87cdd3a066b52b96d3cac';
export const TABBY_BASE_URL = 'http://127.0.0.1:5000';

export const optimizedNvidiaPreset = {
  id: 'qwen3.8-27b-exl3-dflash2-32k',
  label: 'Qwen3.8-27B · EXL3 4.00 bpw · DFlash2 · 32K',
  modelRepo: 'thelastspark/Qwen3.8-27B-exl3',
  modelRevision: '4.00bpw',
  modelFolder: 'teapilot-qwen3.8-27b-exl3-4bpw',
  drafterRepo: 'incoai/Qwen3.8-27B-DFlash2',
  drafterFolder: 'teapilot-qwen3.8-27b-dflash2',
  contextTokens: 32768,
  maxOutputTokens: 16384,
  cacheMode: 'Q4',
  draftTokens: 8,
} as const;

interface PythonLauncher { executable: string; prefix: string[] }
interface RuntimeKeys { apiKey: string; adminKey: string }

export interface TabbyInspection {
  installed: boolean;
  server: 'stopped' | 'ready' | 'foreign';
  model?: string;
}

export interface TabbyDependencies {
  command: typeof command;
  fetch: typeof fetch;
  spawn: typeof spawn;
  platform: NodeJS.Platform;
  kill: typeof process.kill;
}

const defaults: TabbyDependencies = {
  command,
  fetch: globalThis.fetch,
  spawn,
  platform: process.platform,
  kill: process.kill.bind(process),
};

function auth(key: string): HeadersInit { return { Authorization: `Bearer ${key}` }; }
function delay(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(resolve, ms);
    const abort = () => { clearTimeout(timer); reject(signal.reason); };
    signal.addEventListener('abort', abort, { once: true });
  });
}

export class TabbyRuntime {
  private readonly deps: TabbyDependencies;
  readonly runtimeDir: string;
  readonly repoDir: string;
  readonly venvDir: string;
  readonly configPath: string;
  readonly keysPath: string;
  readonly pidPath: string;
  readonly logPath: string;

  constructor(stateDir: string, deps: Partial<TabbyDependencies> = {}) {
    this.deps = { ...defaults, ...deps };
    this.runtimeDir = join(stateDir, 'runtimes', 'tabby', TABBY_COMMIT.slice(0, 12));
    this.repoDir = join(this.runtimeDir, 'repo');
    this.venvDir = join(this.runtimeDir, 'venv');
    this.configPath = join(this.runtimeDir, 'config.yml');
    this.keysPath = join(this.repoDir, 'api_tokens.yml');
    this.pidPath = join(this.runtimeDir, 'server.pid');
    this.logPath = join(this.runtimeDir, 'tabby.log');
  }

  private venvPython(): string {
    return this.deps.platform === 'win32' ? join(this.venvDir, 'Scripts', 'python.exe') : join(this.venvDir, 'bin', 'python');
  }

  private async findPython(signal: AbortSignal): Promise<PythonLauncher> {
    const candidates: PythonLauncher[] = this.deps.platform === 'win32'
      ? [{ executable: 'py', prefix: ['-3.12'] }, { executable: 'py', prefix: ['-3.13'] }, { executable: 'python', prefix: [] }]
      : [{ executable: 'python3', prefix: [] }, { executable: 'python', prefix: [] }];
    for (const candidate of candidates) {
      try {
        const version = (await this.deps.command(candidate.executable, [...candidate.prefix, '-c', 'import sys; print(f"{sys.version_info.major}.{sys.version_info.minor}")'], signal)).trim();
        const match = version.match(/^3\.(\d+)$/);
        if (match && Number(match[1]) >= 10 && Number(match[1]) < 15) return candidate;
      } catch { signal.throwIfAborted(); }
    }
    throw new RuntimeFailure('runtime_unavailable', 'Managed Optimized NVIDIA needs Python 3.10-3.14 (Python 3.12 is recommended). TeaPilot did not make any system-wide changes.');
  }

  async ensureInstalled(hardware: HardwareReport, signal: AbortSignal): Promise<void> {
    if (this.deps.platform !== 'win32' || !hardware.optimizedNvidia) {
      throw new RuntimeFailure('hardware_unavailable', hardware.reason ?? 'A suitable Windows NVIDIA GPU was not detected.');
    }
    const marker = join(this.runtimeDir, 'version');
    if (await exists(marker) && await exists(this.venvPython())) {
      if ((await readFile(marker, 'utf8')).trim() === TABBY_COMMIT) return;
    }
    const python = await this.findPython(signal);
    try {
      await this.deps.command('git', ['--version'], signal);
    } catch (error) {
      signal.throwIfAborted();
      throw new RuntimeFailure('runtime_unavailable', 'Managed Optimized NVIDIA needs Git on PATH. TeaPilot will not install Git or request administrator privileges.', { cause: error });
    }

    await mkdir(this.runtimeDir, { recursive: true });
    await rm(this.repoDir, { recursive: true, force: true });
    await rm(this.venvDir, { recursive: true, force: true });
    try {
      await this.deps.command('git', ['clone', '--filter=blob:none', TABBY_REPOSITORY, this.repoDir], signal);
      await this.deps.command('git', ['-C', this.repoDir, 'checkout', '--detach', TABBY_COMMIT], signal);
      await this.deps.command(python.executable, [...python.prefix, '-m', 'venv', this.venvDir], signal);
      await this.deps.command(this.venvPython(), ['-m', 'pip', 'install', '--disable-pip-version-check', '-U', `${this.repoDir}[cu12]`], signal);
      await writeFile(marker, `${TABBY_COMMIT}\n`, { mode: 0o600 });
    } catch (error) {
      signal.throwIfAborted();
      throw new RuntimeFailure('runtime_unavailable', 'The TeaPilot-owned TabbyAPI installation failed. Check Git/Python/CUDA compatibility and rerun setup; no system-wide installation was attempted.', { cause: error });
    }
  }

  private async ensureFiles(): Promise<RuntimeKeys> {
    await mkdir(this.runtimeDir, { recursive: true });
    let keys: RuntimeKeys | undefined;
    try {
      const text = await readFile(this.keysPath, 'utf8');
      const apiKey = text.match(/^api_key:\s*([^\s#]+)\s*$/m)?.[1];
      const adminKey = text.match(/^admin_key:\s*([^\s#]+)\s*$/m)?.[1];
      if (apiKey && adminKey) keys = { apiKey, adminKey };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
    if (!keys) {
      keys = { apiKey: randomBytes(24).toString('hex'), adminKey: randomBytes(24).toString('hex') };
      await writeFile(this.keysPath, `api_key: ${keys.apiKey}\nadmin_key: ${keys.adminKey}\n`, { mode: 0o600 });
    }
    const config = `network:
  host: 127.0.0.1
  port: 5000
  disable_auth: false
  allowed_origins: []
  api_servers: ["OAI"]
logging:
  log_prompt: false
  log_generation_params: false
  log_requests: false
  log_chat_completion_requests: false
model:
  model_dir: models
  use_as_default: [backend, max_seq_len, cache_size, cache_mode, chunk_size, output_chunking, max_batch_size, warmup]
  backend: exllamav3
  max_seq_len: 32768
  cache_size: 32768
  cache_mode: Q4
  chunk_size: 1024
  output_chunking: true
  max_batch_size: 1
  warmup: true
  reasoning: true
  tool_format: qwen3_5
draft_model:
  draft_mode: model
  draft_model_dir: models
  draft_cache_mode: Q4
  draft_num_tokens: 8
sampling:
  override_preset: safe_defaults
developer:
  realtime_process_priority: false
`;
    await writeFile(this.configPath, config, { mode: 0o600 });
    return keys;
  }

  private async service(signal: AbortSignal): Promise<'stopped' | 'ready' | 'foreign'> {
    try {
      const response = await this.deps.fetch(`${TABBY_BASE_URL}/.well-known/serviceinfo`, {
        signal: AbortSignal.any([signal, AbortSignal.timeout(1500)]),
        redirect: 'error',
      });
      if (!response.ok) return 'foreign';
      const body = await response.json() as { software?: { name?: unknown } };
      return body.software?.name === 'TabbyAPI' ? 'ready' : 'foreign';
    } catch {
      signal.throwIfAborted();
      return 'stopped';
    }
  }

  async inspect(signal: AbortSignal): Promise<TabbyInspection> {
    const installed = await exists(join(this.runtimeDir, 'version')) && await exists(this.venvPython());
    const server = await this.service(signal);
    let model: string | undefined;
    if (server === 'ready') {
      try {
        const keys = await this.ensureFiles();
        const response = await this.deps.fetch(`${TABBY_BASE_URL}/v1/model`, { headers: auth(keys.apiKey), signal, redirect: 'error' });
        if (response.ok) model = ((await response.json()) as { id?: string }).id;
      } catch { signal.throwIfAborted(); }
    }
    return { installed, server, model };
  }

  async start(signal: AbortSignal): Promise<RuntimeKeys> {
    const keys = await this.ensureFiles();
    const current = await this.service(signal);
    if (current === 'ready') {
      const check = await this.deps.fetch(`${TABBY_BASE_URL}/v1/models`, { headers: auth(keys.apiKey), signal, redirect: 'error' });
      if (!check.ok) throw new RuntimeFailure('server_not_ready', 'TabbyAPI is already running on port 5000, but it is not the TeaPilot-managed instance. Stop it or choose Existing OpenAI-compatible endpoint.');
      return keys;
    }
    if (current === 'foreign') throw new RuntimeFailure('server_not_ready', 'Port 5000 is already used by another service. Free that port or choose Existing OpenAI-compatible endpoint.');

    const fd = openSync(this.logPath, 'a');
    let child: ChildProcess;
    try {
      child = this.deps.spawn(this.venvPython(), [join(this.repoDir, 'main.py'), '--config', this.configPath], {
        cwd: this.repoDir,
        detached: true,
        windowsHide: true,
        stdio: ['ignore', fd, fd],
      });
      child.unref();
    } catch (error) {
      throw new RuntimeFailure('server_not_ready', `Failed to start managed TabbyAPI. See ${this.logPath}.`, { cause: error });
    } finally {
      closeSync(fd);
    }
    if (!child.pid) throw new RuntimeFailure('server_not_ready', `Managed TabbyAPI did not return a process id. See ${this.logPath}.`);
    await writeFile(this.pidPath, String(child.pid), { mode: 0o600 });

    const deadline = Date.now() + 60_000;
    while (Date.now() < deadline) {
      signal.throwIfAborted();
      if (child.exitCode !== null) throw new RuntimeFailure('server_not_ready', `Managed TabbyAPI exited before becoming ready. See ${this.logPath}.`);
      if (await this.service(signal) === 'ready') {
        const check = await this.deps.fetch(`${TABBY_BASE_URL}/v1/models`, { headers: auth(keys.apiKey), signal, redirect: 'error' });
        if (check.ok) return keys;
      }
      await delay(500, signal);
    }
    throw new RuntimeFailure('server_not_ready', `Managed TabbyAPI did not become ready within 60 seconds. See ${this.logPath}.`);
  }

  async stop(): Promise<void> {
    try {
      const pid = Number((await readFile(this.pidPath, 'utf8')).trim());
      if (Number.isInteger(pid) && pid > 0) this.deps.kill(pid, 'SIGTERM');
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT' && (error as NodeJS.ErrnoException).code !== 'ESRCH') throw error;
    } finally {
      await unlink(this.pidPath).catch(error => { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; });
    }
  }

  private async postJson(path: string, body: unknown, key: string, signal: AbortSignal): Promise<Response> {
    return this.deps.fetch(`${TABBY_BASE_URL}${path}`, {
      method: 'POST',
      headers: { ...auth(key), 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      signal,
      redirect: 'error',
    });
  }

  async provision(ui: SetupUI, signal: AbortSignal): Promise<RuntimeKeys> {
    const keys = await this.start(signal);
    const listed = await this.deps.fetch(`${TABBY_BASE_URL}/v1/models`, { headers: auth(keys.adminKey), signal, redirect: 'error' });
    if (!listed.ok) throw new RuntimeFailure('api_incompatible', `TabbyAPI model listing returned HTTP ${listed.status}.`);
    const body = await listed.json() as { data?: Array<{ id?: string }> };
    if (!Array.isArray(body.data)) throw new RuntimeFailure('api_incompatible', 'TabbyAPI did not return an OpenAI-compatible model list.');
    const installed = new Set(body.data.flatMap(item => typeof item.id === 'string' ? [item.id] : []));
    const missing = [
      installed.has(optimizedNvidiaPreset.modelFolder) ? undefined : 'Qwen3.8-27B EXL3 4.00 bpw',
      installed.has(optimizedNvidiaPreset.drafterFolder) ? undefined : 'Qwen3.8-27B DFlash2 drafter',
    ].filter((value): value is string => Boolean(value));
    if (missing.length) {
      const approved = await ui.confirm(`Download ${missing.join(' and ')} into TeaPilot's managed runtime? The combined weights are roughly 18+ GB.`, signal);
      if (!approved) throw new RuntimeFailure('model_unavailable', 'Optimized NVIDIA model provisioning was declined.');
    }

    const download = async (repoId: string, folderName: string, revision?: string) => {
      if (installed.has(folderName)) return;
      const response = await this.postJson('/v1/download', { repo_id: repoId, folder_name: folderName, ...(revision ? { revision } : {}) }, keys.adminKey, signal);
      if (!response.ok) throw new RuntimeFailure('model_unavailable', `TabbyAPI failed to download ${repoId} (HTTP ${response.status}).`);
      const result = await response.json() as { download_path?: unknown };
      if (typeof result.download_path !== 'string') throw new RuntimeFailure('api_incompatible', 'TabbyAPI download response did not contain a download path.');
      installed.add(folderName);
    };

    await download(optimizedNvidiaPreset.modelRepo, optimizedNvidiaPreset.modelFolder, optimizedNvidiaPreset.modelRevision);
    await download(optimizedNvidiaPreset.drafterRepo, optimizedNvidiaPreset.drafterFolder);

    try {
      const active = await this.deps.fetch(`${TABBY_BASE_URL}/v1/model`, { headers: auth(keys.apiKey), signal, redirect: 'error' });
      if (active.ok && ((await active.json()) as { id?: string }).id === optimizedNvidiaPreset.modelFolder) return keys;
    } catch { signal.throwIfAborted(); }

    const load = await this.postJson('/v1/model/load', {
      model_name: optimizedNvidiaPreset.modelFolder,
      backend: 'exllamav3',
      max_seq_len: optimizedNvidiaPreset.contextTokens,
      cache_size: optimizedNvidiaPreset.contextTokens,
      cache_mode: optimizedNvidiaPreset.cacheMode,
      chunk_size: 1024,
      output_chunking: true,
      max_batch_size: 1,
      warmup: true,
      draft_model: { draft_model_name: optimizedNvidiaPreset.drafterFolder },
    }, keys.adminKey, signal);
    if (!load.ok) throw new RuntimeFailure('model_unavailable', `TabbyAPI model load returned HTTP ${load.status}.`);
    const loadText = await load.text();
    if (/["']?error["']?\s*:/i.test(loadText)) throw new RuntimeFailure('model_unavailable', `TabbyAPI reported a model load failure. See ${this.logPath}.`);

    const active = await this.deps.fetch(`${TABBY_BASE_URL}/v1/model`, { headers: auth(keys.apiKey), signal, redirect: 'error' });
    if (!active.ok || ((await active.json()) as { id?: string }).id !== optimizedNvidiaPreset.modelFolder) {
      throw new RuntimeFailure('model_unavailable', `The optimized model did not become active after loading. See ${this.logPath}.`);
    }
    return keys;
  }
}
