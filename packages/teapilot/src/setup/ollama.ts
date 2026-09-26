import { during, terminalHandoff } from '../activity.js';
import { spawn } from 'node:child_process';
import { mkdtemp, open, rm, statfs } from 'node:fs/promises';
import { homedir, tmpdir, totalmem } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { exists, physicalModels, type PhysicalModel } from '../config.js';
import { chooseMany, type SetupUI } from './terminal.js';

export const ollamaURL = 'http://127.0.0.1:11434';
export const presets = [
  { label: 'Fast - Qwen3.5-9B Heretic Q4_K_M', id: 'hf.co/mradermacher/Qwen3.5-9B-heretic-GGUF:Q4_K_M', bytes: 6_600_000_000, memoryGiB: 12, context: 8192, role: 'fast' as PhysicalModel },
  { label: 'Capable - Qwen3.8-27B Heretic ARA Q4_K_M', id: 'hf.co/mradermacher/Qwen3.8-27B-heretic-ara-GGUF:Q4_K_M', bytes: 16_900_000_000, memoryGiB: 24, context: 32768, role: 'capable' as PhysicalModel },
];
// hf.co/DevJac/Qwen3.8-27B-heretic declares 65 blocks but omits the MTP block
// (blk.64), so llama-server refuses to load it. Do not restore that preset.
export interface OllamaModel { name: string; size: number; remote_model?: string }

export function command(executable: string, args: string[], signal: AbortSignal, inherit = false): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn(executable, args, { shell: false, windowsHide: true, signal, stdio: inherit ? 'inherit' : ['ignore', 'pipe', 'pipe'] });
    let text = '';
    child.stdout?.on('data', part => { text = (text + String(part)).slice(-16000); });
    child.stderr?.on('data', () => {});
    child.on('error', reject);
    child.on('close', code => code === 0 ? resolve(text.trim()) : reject(new Error(`${executable} failed (${code ?? 'cancelled'}).`)));
  });
}

export async function ollamaJSON<T>(path: string, signal: AbortSignal, body?: unknown, base = ollamaURL): Promise<T> {
  const response = await fetch(`${base}${path}`, { method: body ? 'POST' : 'GET', headers: body ? { 'Content-Type': 'application/json' } : {}, body: body ? JSON.stringify(body) : undefined, signal: AbortSignal.any([signal, AbortSignal.timeout(10000)]), redirect: 'error' });
  if (!response.ok) throw new Error(`Ollama ${path} returned HTTP ${response.status}.`);
  return await response.json() as T;
}

export async function streamOperation(path: string, body: unknown, signal: AbortSignal, progress: (text: string) => void, base = ollamaURL, verbose = false): Promise<void> {
  const response = await fetch(`${base}${path}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body), signal: AbortSignal.any([signal, AbortSignal.timeout(2 * 60 * 60 * 1000)]), redirect: 'error' });
  if (!response.ok || !response.body) throw new Error(`Ollama ${path} returned HTTP ${response.status}.`);
  let pending = '', success = false, previous = '';
  const reader = response.body.pipeThrough(new TextDecoderStream()).getReader();
  const line = (text: string) => {
    if (!text.trim()) return;
    const item = JSON.parse(text) as { error?: string; status?: string; completed?: number; total?: number };
    if (item.error) throw new Error('Ollama could not complete the download/model operation. Check disk space and the model name, then retry.');
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
      if (pending.length > 1_000_000) throw new Error('Ollama progress response exceeded its limit.');
      const lines = pending.split('\n'); pending = lines.pop() ?? '';
      for (const item of lines) line(item);
    }
    line(pending);
    if (!success) throw new Error('Ollama operation was interrupted. Retry to resume the download.');
  } finally { await reader.cancel().catch(() => {}); }
}

export function checkDisk(available: number, required: number): void {
  if (available < required) throw new Error(`Insufficient disk space: need approximately ${(required / 1e9).toFixed(1)} GB. Free space and rerun teapilot setup.`);
}

// /api/create only registers an alias; it never loads the weights, so a GGUF with
// missing/incompatible tensors is accepted silently. An empty-prompt /api/generate
// forces llama-server to actually load the model, surfacing load failures here
// instead of at first inference. Large models can take a while to load.
async function probeOllamaLoad(base: string, id: string, alias: string, signal: AbortSignal): Promise<void> {
  const response = await fetch(`${base}/api/generate`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ model: alias, prompt: '', stream: false, keep_alive: 0 }), signal: AbortSignal.any([signal, AbortSignal.timeout(10 * 60 * 1000)]), redirect: 'error' });
  const payload = await response.json().catch(() => undefined) as { error?: string } | undefined;
  if (!response.ok || payload?.error) throw new Error(`Ollama could not load ${id}: ${payload?.error ?? `HTTP ${response.status}`}. The model file may be incompatible with this Ollama version; choose a different model.`);
}

async function binary(signal: AbortSignal): Promise<string | undefined> {
  for (const candidate of ['ollama', ...(process.platform === 'win32' && process.env.LOCALAPPDATA ? [join(process.env.LOCALAPPDATA, 'Programs/Ollama/ollama.exe')] : [])]) {
    try { await command(candidate, ['--version'], AbortSignal.any([signal, AbortSignal.timeout(10000)])); return candidate; } catch { signal.throwIfAborted(); }
  }
  return undefined;
}

async function downloadInstaller(url: string, path: string, signal: AbortSignal, ui: SetupUI): Promise<void> {
  const response = await fetch(url, { signal: AbortSignal.any([signal, AbortSignal.timeout(30 * 60 * 1000)]) });
  if (!response.ok || !response.body || !response.url.startsWith('https://')) throw new Error('Could not download the official Ollama installer.');
  const file = await open(path, 'wx', 0o700);
  let bytes = 0, last = -1;
  const size = Number(response.headers.get('content-length'));
  try {
    for await (const chunk of response.body) {
      await file.writeFile(chunk); bytes += chunk.length;
      const value = size ? Math.floor(bytes / size * 100) : Math.floor(bytes / 1e6);
      if (value !== last) { ui.log(`Downloading Ollama installer: ${value}${size ? '%' : ' MB'}`); last = value; }
    }
    if (size && size !== bytes) throw new Error('Installer download was interrupted. Rerun setup.');
  } finally { await file.close(); }
}

export async function ensureOllama(ui: SetupUI, signal: AbortSignal): Promise<void> {
  const online = async () => {
    try { await ollamaJSON('/api/version', signal); return true; } catch { signal.throwIfAborted(); return false; }
  };
  if (await online()) { ui.log('Using the running Ollama server.'); return; }
  let executable = await binary(signal);
  if (!executable) {
    if (!['win32', 'linux'].includes(process.platform)) throw new Error('Managed installation supports Windows and Linux. Install Ollama yourself or use an existing endpoint.');
    for (const location of [tmpdir(), homedir()]) {
      const space = await statfs(location);
      checkDisk(space.bavail * space.bsize, process.platform === 'win32' ? 6_000_000_000 : 8_000_000_000);
    }
    if (!await ui.confirm('Install Ollama from ollama.com? Its installer may request system permission.')) throw new Error('Installation declined. Rerun setup or choose an existing endpoint.');
    const directory = await mkdtemp(join(tmpdir(), 'teapilot-ollama-'));
    try {
      const path = join(directory, process.platform === 'win32' ? 'OllamaSetup.exe' : 'install.sh');
      await during(ui, 'Downloading Ollama installer...', () => downloadInstaller(process.platform === 'win32' ? 'https://ollama.com/download/OllamaSetup.exe' : 'https://ollama.com/install.sh', path, signal, ui));
      if (process.platform === 'win32') await during(ui, 'Installing Ollama...', () => command(path, ['/VERYSILENT', '/NORESTART'], signal));
      else await terminalHandoff(ui, () => command('sh', [path], signal, true));
    } finally { await rm(directory, { recursive: true, force: true }); }
    executable = await binary(signal);
    if (!executable) throw new Error('Ollama installation is incomplete. Finish the installer, then rerun teapilot setup.');
  }
  if (await online()) return;
  if (!await ui.confirm('Start the installed Ollama service/application?')) throw new Error('Start Ollama, then rerun teapilot setup.');
  if (process.platform === 'linux') {
    await terminalHandoff(ui, () => command('sudo', ['systemctl', 'start', 'ollama'], signal, true)).catch(() => {
      throw new Error('Could not start the Ollama service. Run ollama serve in another terminal, then rerun setup.');
    });
  } else {
    const app = process.env.LOCALAPPDATA ? join(process.env.LOCALAPPDATA, 'Programs/Ollama/ollama app.exe') : '';
    if (!app || !await exists(app)) throw new Error('Open Ollama from the Start menu, then rerun setup.');
    await new Promise<void>((resolve, reject) => {
      const child = spawn(app, [], { detached: true, stdio: 'ignore', windowsHide: true });
      child.on('error', reject); child.on('spawn', () => { child.unref(); resolve(); });
    });
  }
  await during(ui, 'Waiting for Ollama to become ready...', async () => {
    for (let count = 0; count < 30; count++) { if (await online()) return; await delay(1000, undefined, { signal }); }
    throw new Error('Ollama did not become ready. Check its service logs, then rerun setup.');
  });
}

export interface PreparedModel { id: string; source: string; context: number; tools: boolean; roles: PhysicalModel[] }
export const roleChoices: PhysicalModel[][] = [['capable'], ['fast'], ['fast', 'capable']];
export const roleLabel = (roles: PhysicalModel[]) => roles.length > 1 ? 'Both fast and capable' : roles[0] === 'fast' ? 'Fast (quick answers)' : 'Capable (coding and harder work)';

/** Memory in GiB, and lines describing the hardware models will run on. */
export async function hardware(signal: AbortSignal): Promise<{ memory: number; lines: string[] }> {
  const memory = totalmem() / 2 ** 30;
  const lines = [`System memory: ${memory.toFixed(1)} GiB. CPU inference is supported but can be slow.`];
  try { lines.push(`GPU: ${await command('nvidia-smi', ['--query-gpu=name,memory.total', '--format=csv,noheader'], AbortSignal.any([signal, AbortSignal.timeout(3000)]))}`); }
  catch { signal.throwIfAborted(); lines.push('GPU memory unavailable; memory guidance is approximate.'); }
  return { memory, lines };
}

export async function selectOllamaModel(ui: SetupUI, signal: AbortSignal, base = ollamaURL, verbose = false): Promise<PreparedModel[]> {
  const { memory, lines } = await hardware(signal);
  for (const line of lines) ui.log(line);
  const installed = (await ollamaJSON<{ models: OllamaModel[] }>('/api/tags', signal, undefined, base)).models.filter(model => !model.remote_model && !model.name.includes('cloud'));
  const visible = installed.filter(model => !isTeapilotAlias(model.name) && !presets.some(preset => preset.id === model.name));
  const choices = [...presets.map(p => `${p.label} - ${installed.some(model => model.name === p.id) ? 'installed' : `about ${(p.bytes / 1e9).toFixed(1)} GB download`}, ${p.memoryGiB}+ GiB RAM suggested`), ...visible.map(p => `Installed: ${p.name}`), 'Custom local Ollama model'];
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
    planned.push({ ...item, context: await configureOllamaModel(ui, item.id, item.preset, installed, memory, reservedBytes) });
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

export async function configureOllamaModel(ui: SetupUI, id: string, preset: typeof presets[number] | undefined, installed: OllamaModel[], memory: number, reservedBytes: number): Promise<number> {
  ui.log('Context is how much text the model can work with at once. Larger values use more memory; Enter accepts the suggested value.');
  let context: number;
  for (;;) {
    context = Number(await ui.input('Context tokens', String(preset?.context ?? 16384)));
    if (Number.isInteger(context) && context >= 8192 && context <= 2_000_000) break;
    ui.log('Enter a whole number between 8192 and 2000000.');
  }
  if (preset && memory < preset.memoryGiB && !await ui.confirm('Memory is below the suggested amount. Continue with this model?')) throw new Error('Choose a smaller model when rerunning setup.');
  if (!installed.some(model => model.name === id)) {
    // The Linux system service normally stores models under /usr/share/ollama;
    // OLLAMA_MODELS may specify a separate disk. Find an existing parent to stat.
    let storage = process.env.OLLAMA_MODELS || (process.platform === 'linux' && await exists('/usr/share/ollama') ? '/usr/share/ollama' : homedir());
    while (!await exists(storage)) { const parent = join(storage, '..'); if (parent === storage) break; storage = parent; }
    const disk = await statfs(storage);
    const required = reservedBytes + (preset?.bytes ?? 0) * 1.1 + 1_000_000_000;
    checkDisk(disk.bavail * disk.bsize, required);
    ui.log(`Free space on model storage filesystem: ${(disk.bavail * disk.bsize / 1e9).toFixed(1)} GB.${preset?.bytes ? '' : ' Custom model download size is unknown.'}`);
    if (!await ui.confirm(`Download ${id}${preset?.bytes ? ` (about ${(preset.bytes / 1e9).toFixed(1)} GB)` : ''}?`)) throw new Error('Download declined; existing configuration is unchanged.');
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
  if (metadata.remote_model) throw new Error('This is a remotely hosted model; choose a local model.');
  const maximum = Object.entries(metadata.model_info ?? {}).find(([key]) => key.endsWith('.context_length'))?.[1];
  if (typeof maximum === 'number' && context > maximum) throw new Error(`This model supports at most ${maximum} context tokens.`);
  // A separate alias leaves the user's original model untouched and fixes the
  // context actually used by the OpenAI API, which has no num_ctx parameter.
  const alias = ollamaAlias(id);
  ui.log(`Preparing ${id} with a ${context.toLocaleString('en-US')}-token context...`);
  await during(ui, `Preparing ${id}...`, () => streamOperation('/api/create', { model: alias, from: id, parameters: { num_ctx: context }, stream: true }, signal, ui.log, base, verbose));
  await during(ui, `Loading ${id}...`, () => probeOllamaLoad(base, id, alias, signal));
  return { id: alias, source: id, context, tools: metadata.capabilities?.includes('tools') ?? true };
}
