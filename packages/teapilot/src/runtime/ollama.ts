import { during, terminalHandoff } from '../activity.js';
import { spawn } from 'node:child_process';
import { mkdtemp, open, rm, statfs } from 'node:fs/promises';
import { homedir, tmpdir, totalmem } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { exists, physicalModels, type ModelConfig, type PhysicalModel, type ThinkingSampling } from '../config.js';
import type { ThinkingLevel } from '../routing/execution.js';
import { chooseMany, type SetupUI } from '../setup/terminal.js';
import { ollamaPresets, type OllamaPreset } from './presets.js';
import { command } from './process.js';
import { RuntimeError, type ProvisionedModel, type RuntimeDriver } from './types.js';

export const ollamaURL = 'http://127.0.0.1:11434';
export const presets = ollamaPresets;
export interface OllamaModel { name: string; size: number; remote_model?: string }

export async function ollamaJSON<T>(path: string, signal: AbortSignal, body?: unknown, base = ollamaURL): Promise<T> {
  const response = await fetch(`${base}${path}`, { method: body ? 'POST' : 'GET', headers: body ? { 'Content-Type': 'application/json' } : {}, body: body ? JSON.stringify(body) : undefined, signal: AbortSignal.any([signal, AbortSignal.timeout(10000)]), redirect: 'error' });
  if (!response.ok) throw new RuntimeError('runtime', `Ollama ${path} returned HTTP ${response.status}.`);
  return await response.json() as T;
}

export async function streamOperation(path: string, body: unknown, signal: AbortSignal, progress: (text: string) => void, base = ollamaURL, verbose = false): Promise<void> {
  const response = await fetch(`${base}${path}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body), signal: AbortSignal.any([signal, AbortSignal.timeout(2 * 60 * 60 * 1000)]), redirect: 'error' });
  // Pulls download weights; every other operation prepares a model that is already present.
  const kind = path === '/api/pull' ? 'download' : 'load';
  if (!response.ok || !response.body) throw new RuntimeError(kind, `Ollama ${path} returned HTTP ${response.status}.`);
  let pending = '', success = false, previous = '';
  const reader = response.body.pipeThrough(new TextDecoderStream()).getReader();
  const line = (text: string) => {
    if (!text.trim()) return;
    const item = JSON.parse(text) as { error?: string; status?: string; completed?: number; total?: number };
    if (item.error) throw new RuntimeError(kind, 'Ollama could not complete the download/model operation. Check disk space and the model name, then retry.');
    success ||= item.status === 'success';
    const description = verbose ? item.status : item.status?.replace(/sha256:[a-f0-9]+/g, '').replace(/\s+$/g, '');
    const status = `${description ?? 'Working'}${item.total ? ` ${Math.floor((item.completed ?? 0) / item.total * 100)}%` : ''}`;
    if (status !== previous) { progress(status); previous = status; }
  };
  try {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      pending += value;
      if (pending.length > 1_000_000) throw new RuntimeError(kind, 'Ollama progress response exceeded its limit.');
      const lines = pending.split('\n'); pending = lines.pop() ?? '';
      for (const item of lines) line(item);
    }
    line(pending);
    if (!success) throw new RuntimeError(kind, 'Ollama operation was interrupted. Retry to resume the download.');
  } finally { await reader.cancel().catch(() => {}); }
}

export function checkDisk(available: number, required: number): void {
  if (available < required) throw new RuntimeError('download', `Insufficient disk space: need approximately ${(required / 1e9).toFixed(1)} GB. Free space and rerun teapilot setup.`);
}

// /api/create only registers an alias; it never loads the weights, so a GGUF with
// missing/incompatible tensors is accepted silently. An empty-prompt /api/generate
// forces llama-server to actually load the model, surfacing load failures here
// instead of at first inference. Large models can take a while to load. While it is
// loaded, /api/ps tells how much of it (weights and context) is in GPU memory.
async function probeOllamaLoad(base: string, id: string, alias: string, signal: AbortSignal): Promise<number | undefined> {
  const generate = (keep_alive: number | string) => fetch(`${base}/api/generate`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ model: alias, prompt: '', stream: false, keep_alive }), signal: AbortSignal.any([signal, AbortSignal.timeout(10 * 60 * 1000)]), redirect: 'error' });
  const response = await generate('1m');
  const payload = await response.json().catch(() => undefined) as { error?: string } | undefined;
  if (!response.ok || payload?.error) throw new RuntimeError('load', `Ollama could not load ${id}: ${payload?.error ?? `HTTP ${response.status}`}. The model file may be incompatible with this Ollama version; choose a different model.`);
  try {
    const loaded = (await ollamaJSON<{ models?: Array<{ name: string; size?: number; size_vram?: number }> }>('/api/ps', signal, undefined, base)).models?.find(model => model.name === alias);
    return loaded?.size && loaded.size_vram !== undefined ? loaded.size_vram / loaded.size : undefined;
  } catch { signal.throwIfAborted(); return undefined; }
  finally { await generate(0).then(unload => unload.body?.cancel(), () => {}); }
}

async function binary(signal: AbortSignal): Promise<string | undefined> {
  for (const candidate of ['ollama', ...(process.platform === 'win32' && process.env.LOCALAPPDATA ? [join(process.env.LOCALAPPDATA, 'Programs/Ollama/ollama.exe')] : [])]) {
    try { await command(candidate, ['--version'], AbortSignal.any([signal, AbortSignal.timeout(10000)])); return candidate; } catch { signal.throwIfAborted(); }
  }
  return undefined;
}

async function downloadInstaller(url: string, path: string, signal: AbortSignal, ui: SetupUI): Promise<void> {
  const response = await fetch(url, { signal: AbortSignal.any([signal, AbortSignal.timeout(30 * 60 * 1000)]) });
  if (!response.ok || !response.body || !response.url.startsWith('https://')) throw new RuntimeError('runtime', 'Could not download the official Ollama installer.');
  const file = await open(path, 'wx', 0o700);
  let bytes = 0, last = -1;
  const size = Number(response.headers.get('content-length'));
  try {
    for await (const chunk of response.body) {
      await file.writeFile(chunk); bytes += chunk.length;
      const value = size ? Math.floor(bytes / size * 100) : Math.floor(bytes / 1e6);
      if (value !== last) { ui.log(`Downloading Ollama installer: ${value}${size ? '%' : ' MB'}`); last = value; }
    }
    if (size && size !== bytes) throw new RuntimeError('runtime', 'Installer download was interrupted. Rerun setup.');
  } finally { await file.close(); }
}

export async function ensureOllama(ui: SetupUI, signal: AbortSignal): Promise<void> {
  const online = async () => {
    try { await ollamaJSON('/api/version', signal); return true; } catch { signal.throwIfAborted(); return false; }
  };
  if (await online()) { ui.log('Using the running Ollama server.'); return; }
  let executable = await binary(signal);
  if (!executable) {
    if (!['win32', 'linux'].includes(process.platform)) throw new RuntimeError('runtime', 'Managed installation supports Windows and Linux. Install Ollama yourself or use an existing endpoint.');
    for (const location of [tmpdir(), homedir()]) {
      const space = await statfs(location);
      checkDisk(space.bavail * space.bsize, process.platform === 'win32' ? 6_000_000_000 : 8_000_000_000);
    }
    if (!await ui.confirm('Install Ollama from ollama.com? Its installer may request system permission.')) throw new RuntimeError('declined', 'Installation declined. Rerun setup or choose an existing endpoint.');
    const directory = await mkdtemp(join(tmpdir(), 'teapilot-ollama-'));
    try {
      const path = join(directory, process.platform === 'win32' ? 'OllamaSetup.exe' : 'install.sh');
      await during(ui, 'Downloading Ollama installer...', () => downloadInstaller(process.platform === 'win32' ? 'https://ollama.com/download/OllamaSetup.exe' : 'https://ollama.com/install.sh', path, signal, ui));
      if (process.platform === 'win32') await during(ui, 'Installing Ollama...', () => command(path, ['/VERYSILENT', '/NORESTART'], signal));
      else await terminalHandoff(ui, () => command('sh', [path], signal, true));
    } finally { await rm(directory, { recursive: true, force: true }); }
    executable = await binary(signal);
    if (!executable) throw new RuntimeError('runtime', 'Ollama installation is incomplete. Finish the installer, then rerun teapilot setup.');
  }
  if (await online()) return;
  if (!await ui.confirm('Start the installed Ollama service/application?')) throw new RuntimeError('declined', 'Start Ollama, then rerun teapilot setup.');
  if (process.platform === 'linux') {
    await terminalHandoff(ui, () => command('sudo', ['systemctl', 'start', 'ollama'], signal, true)).catch(() => {
      throw new RuntimeError('not-ready', 'Could not start the Ollama service. Run ollama serve in another terminal, then rerun setup.');
    });
  } else await startOllamaApp(signal);
  await waitForOllama(ui, signal);
}

async function waitForOllama(ui: SetupUI, signal: AbortSignal): Promise<void> {
  await during(ui, 'Waiting for Ollama to become ready...', async () => {
    for (let count = 0; count < 30; count++) {
      try { await ollamaJSON('/api/version', signal); return; } catch { signal.throwIfAborted(); }
      await delay(1000, undefined, { signal });
    }
    throw new RuntimeError('not-ready', 'Ollama did not become ready. Check its service logs, then rerun setup.');
  });
}

/** Starts the Windows app with the user's saved server settings, which a terminal opened before they were saved lacks. */
async function startOllamaApp(signal: AbortSignal): Promise<void> {
  const app = process.env.LOCALAPPDATA ? join(process.env.LOCALAPPDATA, 'Programs/Ollama/ollama app.exe') : '';
  if (!app || !await exists(app)) throw new RuntimeError('not-ready', 'Open Ollama from the Start menu, then rerun setup.');
  const saved = await savedServerSettings(signal);
  await new Promise<void>((resolve, reject) => {
    const child = spawn(app, [], { detached: true, stdio: 'ignore', windowsHide: true, env: { ...process.env, ...saved } });
    child.on('error', reject); child.on('spawn', () => { child.unref(); resolve(); });
  });
}

const serverVariables = ['OLLAMA_FLASH_ATTENTION', 'OLLAMA_KV_CACHE_TYPE'] as const;
type ServerSettings = Partial<Record<typeof serverVariables[number], string>>;
/** The server settings Ollama starts with: the user's environment on Windows, the service's on Linux. */
async function savedServerSettings(signal: AbortSignal): Promise<ServerSettings> {
  const timeout = AbortSignal.any([signal, AbortSignal.timeout(5000)]);
  const settings: ServerSettings = {};
  if (process.platform === 'win32') {
    for (const name of serverVariables) {
      const value = await command('reg', ['query', 'HKCU\\Environment', '/v', name], timeout).catch(() => '');
      const match = value.match(new RegExp(`${name}\\s+REG_\\w+\\s+(\\S+)`));
      if (match) settings[name] = match[1];
    }
  } else if (process.platform === 'linux') {
    const value = await command('systemctl', ['show', 'ollama', '--property=Environment', '--value'], timeout).catch(() => '');
    for (const name of serverVariables) { const match = value.match(new RegExp(`(?:^|\\s)${name}=(\\S+)`)); if (match) settings[name] = match[1]; }
  } else for (const name of serverVariables) if (process.env[name]) settings[name] = process.env[name];
  return settings;
}

/**
 * Makes sure the Ollama server keeps its KV cache quantized as the preset needs, offering to
 * save the setting and restart Ollama on Windows. True when the server has the setting.
 */
export async function ensureServerSettings(ui: SetupUI, server: NonNullable<OllamaPreset['server']>, signal: AbortSignal): Promise<boolean> {
  const wanted = { OLLAMA_FLASH_ATTENTION: '1', OLLAMA_KV_CACHE_TYPE: server.kvCacheType };
  const saved = await savedServerSettings(signal);
  if (saved.OLLAMA_KV_CACHE_TYPE === server.kvCacheType && ['1', 'true'].includes(saved.OLLAMA_FLASH_ATTENTION ?? '')) return true;
  const lines = Object.entries(wanted).map(([name, value]) => `${name}=${value}`);
  ui.log(`This model's suggested context fits in GPU memory only with a compressed (${server.kvCacheType}) context cache, set on the Ollama server: ${lines.join(', ')}.`);
  if (process.platform !== 'win32') {
    ui.log(process.platform === 'linux'
      ? `To use it, run sudo systemctl edit ollama, add [Service] with ${lines.map(line => `Environment="${line}"`).join(' and ')}, then sudo systemctl restart ollama and rerun setup.`
      : `To use it, set ${lines.join(' and ')} where Ollama starts, restart Ollama and rerun setup.`);
    return false;
  }
  if (!await ui.confirm(`Save ${lines.join(' and ')} for your Windows user and restart Ollama? Models loaded in Ollama are unloaded.`)) return false;
  for (const [name, value] of Object.entries(wanted)) await command('setx', [name, value], AbortSignal.any([signal, AbortSignal.timeout(10000)]));
  await during(ui, 'Restarting Ollama...', async () => {
    for (const image of ['ollama app.exe', 'ollama.exe']) await command('taskkill', ['/IM', image, '/F'], AbortSignal.any([signal, AbortSignal.timeout(10000)])).catch(() => '');
    for (let count = 0; count < 20; count++) {
      try { await ollamaJSON('/api/version', AbortSignal.any([signal, AbortSignal.timeout(1000)])); } catch { signal.throwIfAborted(); break; }
      await delay(500, undefined, { signal });
    }
    await startOllamaApp(signal);
  });
  await waitForOllama(ui, signal);
  return true;
}

/** reasoning lists candidate levels only; live checks decide which are enabled. */
export interface PreparedModel {
  id: string; source: string; context: number; tools: boolean; vision?: boolean; reasoning?: ThinkingLevel[]; sampling?: ThinkingSampling; roles: PhysicalModel[];
  /** How much of the loaded model and its context Ollama placed in GPU memory, from 0 to 1. */
  gpuShare?: number;
}
export const roleChoices: PhysicalModel[][] = [['capable'], ['fast'], ['fast', 'capable']];
export const roleLabel = (roles: PhysicalModel[]) => roles.length > 1 ? 'Both fast and capable' : roles[0] === 'fast' ? 'Fast (quick answers)' : 'Capable (coding and harder work)';

/** Memory in GiB that models run in (GPU memory when there is an NVIDIA GPU), and lines describing the hardware. */
export async function hardware(signal: AbortSignal): Promise<{ memory: number; lines: string[] }> {
  const system = totalmem() / 2 ** 30;
  const lines = [`System memory: ${system.toFixed(1)} GiB. CPU inference is supported but can be slow.`];
  try {
    const gpus = await command('nvidia-smi', ['--query-gpu=name,memory.total', '--format=csv,noheader'], AbortSignal.any([signal, AbortSignal.timeout(3000)]));
    const mebibytes = [...gpus.matchAll(/(\d+)\s*MiB/g)].reduce((total, match) => total + Number(match[1]), 0);
    lines.push(`GPU: ${gpus}`);
    if (mebibytes) return { memory: mebibytes / 1024, lines };
  } catch { signal.throwIfAborted(); lines.push('GPU memory unavailable; memory guidance is approximate.'); }
  return { memory: system, lines };
}

export async function selectOllamaModel(ui: SetupUI, signal: AbortSignal, base = ollamaURL, verbose = false): Promise<PreparedModel[]> {
  const { memory, lines } = await hardware(signal);
  for (const line of lines) ui.log(line);
  const installed = (await ollamaJSON<{ models: OllamaModel[] }>('/api/tags', signal, undefined, base)).models.filter(model => !model.remote_model && !model.name.includes('cloud'));
  const visible = installed.filter(model => !isTeapilotAlias(model.name) && !presets.some(preset => preset.id === model.name));
  const choices = [...presets.map(p => `${p.label} - ${installed.some(model => model.name === p.id) ? 'installed' : `about ${(p.bytes / 1e9).toFixed(1)} GB download`}, ${p.memoryGiB}+ GiB GPU memory suggested`), ...visible.map(p => `Installed: ${p.name}`), 'Custom local Ollama model'];
  const suggested = 0;
  ui.log(`Suggested: ${presets[suggested]!.id} is the default; system RAM, GPU memory and context affect fit. Coding is verified after preparation.`);
  const selections = await chooseMany(ui, 'Local models to install (queued in selection order)', choices, suggested);
  const queue: Array<{ id: string; preset: typeof presets[number] | undefined; roles: PhysicalModel[] }> = [];
  for (const choice of selections) {
    const preset = presets[choice];
    const id = preset?.id ?? visible[choice - presets.length]?.name ?? await ui.input('Local Ollama model name');
    if (!/^[a-zA-Z0-9][a-zA-Z0-9._:/-]*$/.test(id) || id.includes('cloud')) throw new Error('Enter a local Ollama model name; cloud models are not a fully local setup.');
    if (queue.some(item => item.id === id)) continue;
    // Presets carry their role; other models are asked, so routing knows what it can use.
    const roles = preset ? [preset.role] : roleChoices[await ui.choose(`Role for ${id}`, roleChoices.map(roleLabel), 0)]!;
    queue.push({ id, preset, roles });
  }
  for (const role of physicalModels) {
    const claimed = queue.filter(item => item.roles.includes(role));
    if (claimed.length > 1) throw new Error(`${claimed.map(item => item.id).join(' and ')} are both assigned the ${role} role. Rerun setup and give each role one model.`);
  }
  if (!queue.some(item => item.roles.includes('capable'))) ui.log('No capable model selected: coding stays disabled and only fast-tier answers are available.');
  ui.log(`Install queue: ${queue.map(item => `${item.id} (${item.roles.join(' + ')})`).join(' -> ')}`);
  const planned = [];
  let reservedBytes = 0;
  for (const item of queue) {
    signal.throwIfAborted();
    ui.log(`Configure ${item.id}`);
    planned.push({ ...item, context: await configureOllamaModel(ui, item.id, item.preset, installed, memory, reservedBytes, signal) });
    if (!installed.some(model => model.name === item.id)) reservedBytes += (item.preset?.bytes ?? 0) * 1.1;
  }
  const prepared = [];
  for (const [index, item] of planned.entries()) {
    signal.throwIfAborted();
    ui.log(`Model ${index + 1}/${queue.length}: ${item.id}`);
    prepared.push({ ...await prepareOllamaModel(ui, signal, item.id, item.context, installed, base, verbose), roles: item.roles });
  }
  return prepared;
}

export async function configureOllamaModel(ui: SetupUI, id: string, preset: typeof presets[number] | undefined, installed: OllamaModel[], memory: number, reservedBytes: number, signal = new AbortController().signal): Promise<number> {
  const suggested = !preset ? 16384 : !preset.server || await ensureServerSettings(ui, preset.server, signal) ? preset.context : preset.server.fallbackContext;
  ui.log('Context is how much text the model can work with at once. Larger values use more memory; Enter accepts the suggested value.');
  let context: number;
  for (;;) {
    context = Number(await ui.input('Context tokens', String(suggested)));
    if (Number.isInteger(context) && context >= 8192 && context <= 2_000_000) break;
    ui.log('Enter a whole number between 8192 and 2000000.');
  }
  if (preset && memory < preset.memoryGiB && !await ui.confirm('Memory is below the suggested amount. Continue with this model?')) throw new RuntimeError('declined', 'Choose a smaller model when rerunning setup.');
  if (!installed.some(model => model.name === id)) {
    // The Linux system service normally stores models under /usr/share/ollama;
    // OLLAMA_MODELS may specify a separate disk. Find an existing parent to stat.
    let storage = process.env.OLLAMA_MODELS || (process.platform === 'linux' && await exists('/usr/share/ollama') ? '/usr/share/ollama' : homedir());
    while (!await exists(storage)) { const parent = join(storage, '..'); if (parent === storage) break; storage = parent; }
    const disk = await statfs(storage);
    const required = reservedBytes + (preset?.bytes ?? 0) * 1.1 + 1_000_000_000;
    checkDisk(disk.bavail * disk.bsize, required);
    ui.log(`Free space on model storage filesystem: ${(disk.bavail * disk.bsize / 1e9).toFixed(1)} GB.${preset?.bytes ? '' : ' Custom model download size is unknown.'}`);
    if (!await ui.confirm(`Download ${id}${preset?.bytes ? ` (about ${(preset.bytes / 1e9).toFixed(1)} GB)` : ''}?`)) throw new RuntimeError('declined', 'Download declined; existing configuration is unchanged.');
  }
  return context;
}

// Namespaced so the source stays readable in `ollama list`: qwen3-coder:30b
// becomes teapilot/qwen3-coder:30b; slashes in the source are flattened.
export function ollamaAlias(id: string): string {
  const split = id.lastIndexOf(':');
  const [name, tag] = split > id.lastIndexOf('/') ? [id.slice(0, split), id.slice(split + 1)] : [id, 'latest'];
  return `teapilot/${name.toLowerCase().replaceAll('/', '-')}:${tag}`;
}

// The second pattern matches hashed aliases created by earlier versions.
export const isTeapilotAlias = (name: string) => name.startsWith('teapilot/') || /^teapilot-[a-f0-9]{10}(-[0-9]+)?:latest$/.test(name);

export async function prepareOllamaModel(ui: SetupUI, signal: AbortSignal, id: string, context: number, installed: OllamaModel[], base: string, verbose: boolean): Promise<Omit<PreparedModel, 'roles'>> {
  if (!installed.some(model => model.name === id)) {
    for (;;) {
      try { await during(ui, `Downloading ${id}...`, () => streamOperation('/api/pull', { model: id, stream: true }, signal, ui.log, base, verbose)); break; }
      catch (error) { signal.throwIfAborted(); if (!await ui.confirm('Download failed. Retry/resume?')) throw error; }
    }
  }
  const metadata = await ollamaJSON<{ capabilities?: string[]; remote_model?: string; model_info?: Record<string, unknown> }>('/api/show', signal, { model: id }, base);
  if (metadata.remote_model) throw new RuntimeError('model-missing', 'This is a remotely hosted model; choose a local model.');
  const maximum = Object.entries(metadata.model_info ?? {}).find(([key]) => key.endsWith('.context_length'))?.[1];
  if (typeof maximum === 'number' && context > maximum) throw new Error(`This model supports at most ${maximum} context tokens.`);
  // A separate alias leaves the user's original model untouched and fixes the
  // context actually used by the OpenAI API, which has no num_ctx parameter.
  const alias = ollamaAlias(id);
  // Ollama's OpenAI API ignores top_k and min_p, so a preset's values are fixed in the alias.
  const sampling = presets.find(preset => preset.id === id)?.sampling;
  const fixed = sampling ? { top_k: sampling.off?.top_k, min_p: sampling.off?.min_p, repeat_penalty: 1 } : {};
  ui.log(`Preparing ${id} with a ${context.toLocaleString('en-US')}-token context...`);
  await during(ui, `Preparing ${id}...`, () => streamOperation('/api/create', { model: alias, from: id, parameters: { num_ctx: context, ...fixed }, stream: true }, signal, ui.log, base, verbose));
  const gpuShare = await during(ui, `Loading ${id}...`, () => probeOllamaLoad(base, id, alias, signal));
  if (gpuShare !== undefined && gpuShare > 0 && gpuShare < 0.99) ui.log(`Only ${Math.floor(gpuShare * 100)}% of ${id} fits in GPU memory at this context; the rest runs on the CPU, several times slower. A smaller context, or closing other GPU programs, helps.`);
  // Ollama reports thinking support as a capability, not as a list of levels. It sends xhigh to
  // chat templates as "max", which Qwen3.8's template rejects, so xhigh is not offered.
  return { id: alias, source: id, context, tools: metadata.capabilities?.includes('tools') ?? true, vision: metadata.capabilities?.includes('vision') ?? false, reasoning: metadata.capabilities?.includes('thinking') ? ['low', 'medium'] : [], sampling, gpuShare };
}

/** An ordinary OpenAI-compatible model entry for a prepared Ollama model. */
export function provisionedOllama(model: PreparedModel): ProvisionedModel {
  return {
    roles: model.roles, source: model.source, apiKeyEnv: 'LOCAL_API_KEY', apiKey: null,
    model: {
      id: model.id, provider: 'ollama', baseUrl: `${ollamaURL}/v1`, contextTokens: model.context,
      maxOutputTokens: Math.min(16384, Math.floor(model.context / 2)), toolCalling: model.tools, vision: Boolean(model.vision),
      supportsDeveloperRole: false, supportsUsage: true, ...model.sampling ? { sampling: model.sampling } : { temperature: 0.2 },
      reasoning: { type: 'reasoning_effort', values: { off: 'none', ...Object.fromEntries((model.reasoning ?? []).map(level => [level, level])) } },
    },
  };
}

async function version(signal: AbortSignal): Promise<string | undefined> {
  try { return (await ollamaJSON<{ version?: string }>('/api/version', AbortSignal.any([signal, AbortSignal.timeout(1500)]))).version ?? 'unknown'; }
  catch { signal.throwIfAborted(); return undefined; }
}
const servedByOllama = (model: ModelConfig) => model.baseUrl.replace(/\/v1\/?$/, '') === ollamaURL;

/** Ollama, installed and started by TeaPilot when it is missing, with models pulled through its own API. */
export const ollamaDriver: RuntimeDriver = {
  id: 'ollama', label: 'Locally via Ollama', ownership: 'managed',
  // A cold model load counts against the stall timeout of its first request.
  requestTimeoutMs: 120000,
  async suitability(signal) {
    if (['win32', 'linux'].includes(process.platform) || await version(signal)) return { suitable: true, summary: 'runs models on this computer\'s CPU or GPU.' };
    return { suitable: false, kind: 'runtime', reason: 'TeaPilot installs Ollama on Windows and Linux only. Start Ollama yourself, or use an existing endpoint.' };
  },
  async inspect(signal) {
    const running = await version(signal);
    return { ownership: 'managed', ready: Boolean(running), version: running, baseUrl: `${ollamaURL}/v1` };
  },
  ensure: ({ ui, signal }) => ensureOllama(ui, signal),
  provision: async ({ ui, signal, verbose }) => (await selectOllamaModel(ui, signal, undefined, verbose)).map(provisionedOllama),
  async hint(model, signal) {
    const running = await version(signal);
    if (servedByOllama(model)) return running ? undefined : 'Ollama is not running. Open Ollama, or run ollama serve, then retry.';
    return running ? `Ollama is running at ${ollamaURL}, but this model is configured at ${model.baseUrl}. To use models installed in Ollama, rerun teapilot setup and choose Locally via Ollama. No endpoint was changed.` : undefined;
  },
};
