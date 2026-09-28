import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { chooseMany, type SetupUI } from '../src/setup/terminal.js';
import { ensureServerSettings, ollamaAlias, presets, selectOllamaModel } from '../src/runtime/ollama.js';

vi.mock('node:fs/promises', async importOriginal => ({
  ...await importOriginal<typeof import('node:fs/promises')>(),
  statfs: vi.fn(async () => ({ bavail: 100_000_000_000, bsize: 1 })),
}));

// Setup never reaches the real system here: the user's saved Ollama settings, setx, taskkill
// and starting Ollama are all simulated.
const system = vi.hoisted(() => ({ commands: [] as string[][], saved: {} as Record<string, string>, stopped: false }));
vi.mock('../src/runtime/process.js', () => ({
  command: vi.fn(async (executable: string, args: string[]) => {
    system.commands.push([executable, ...args]);
    if (executable === 'reg') {
      const value = system.saved[args[3]!];
      if (!value) throw new Error('reg failed (1).');
      return `HKEY_CURRENT_USER\\Environment\r\n    ${args[3]}    REG_SZ    ${value}`;
    }
    if (executable === 'systemctl') return Object.entries(system.saved).map(([name, value]) => `${name}=${value}`).join(' ');
    if (executable === 'setx') { system.saved[args[0]!] = args[1]!; return 'SUCCESS: Specified value was saved.'; }
    if (executable === 'taskkill') { system.stopped = true; return ''; }
    if (executable === 'nvidia-smi') return 'NVIDIA GeForce RTX 3090, 24576 MiB';
    return '';
  }),
}));
vi.mock('node:child_process', async importOriginal => ({
  ...await importOriginal<typeof import('node:child_process')>(),
  spawn: vi.fn((executable: string) => {
    system.commands.push(['spawn', executable]);
    system.stopped = false;
    return { on: (event: string, listener: () => void) => { if (event === 'spawn') queueMicrotask(listener); }, unref: () => {} };
  }),
}));
const serverReady = { OLLAMA_FLASH_ATTENTION: '1', OLLAMA_KV_CACHE_TYPE: 'q8_0' };
beforeEach(() => { system.commands = []; system.saved = { ...serverReady }; system.stopped = false; });
afterEach(() => vi.unstubAllGlobals());

function ui(answers: string[]): SetupUI {
  return { input: vi.fn(async (_message, fallback) => answers.shift() ?? fallback ?? ''), choose: vi.fn(async () => 0), confirm: vi.fn(async () => true), log: vi.fn() };
}

it('accepts multiple selections in order, deduplicates and rejects invalid selections', async () => {
  const prompts = ui(['0', '4', '1.5', '1,banana', '2, 1 2']);
  expect(await chooseMany(prompts, 'Models', ['a', 'b', 'c'])).toEqual([1, 0]);
  expect(prompts.input).toHaveBeenCalledTimes(5);
  expect(await chooseMany(ui(['']), 'Models', ['a', 'b'], 1)).toEqual([1]);
});

function ollama(installed: string[] = [], failFirstPull = false, loadError?: string, gpuShare = 1) {
  const operations: Array<{ path: string; model: string; parameters?: Record<string, unknown> }> = [];
  let failed = false;
  vi.stubGlobal('fetch', vi.fn(async (url: string, init?: RequestInit) => {
    const path = new URL(url).pathname;
    const body = init?.body ? JSON.parse(String(init.body)) : {};
    if (path === '/api/version') return system.stopped ? Promise.reject(new TypeError('fetch failed')) : Response.json({ version: '0.34.3' });
    operations.push({ path, model: body.model, ...(body.parameters ? { parameters: body.parameters } : {}) });
    if (path === '/api/tags') return Response.json({ models: installed.map(name => ({ name, size: 1 })) });
    if (path === '/api/show') return Response.json({ capabilities: ['tools'], model_info: { 'qwen.context_length': 262144 } });
    if (path === '/api/ps') return Response.json({ models: operations.filter(op => op.path === '/api/create').slice(-1).map(op => ({ name: op.model, size: 20e9, size_vram: 20e9 * gpuShare })) });
    if (path === '/api/pull' && failFirstPull && !failed) { failed = true; return new Response('{"error":"interrupted"}\n'); }
    if (path === '/api/generate' && loadError) return new Response(JSON.stringify({ error: loadError }), { status: 500 });
    return new Response('{"status":"success"}\n');
  }));
  return operations;
}

it('downloads and prepares queued models sequentially, retries in place and assigns preset roles', async () => {
  const operations = ollama([], true);
  const prompts = ui(['1, 2, 1']);
  const models = await selectOllamaModel(prompts, new AbortController().signal);
  expect(operations.filter(op => op.path === '/api/pull').map(op => op.model)).toEqual([presets[0]!.id, presets[0]!.id, presets[1]!.id]);
  const load = ['/api/show', '/api/create', '/api/generate', '/api/ps', '/api/generate'];
  expect(operations.map(op => op.path)).toEqual(['/api/tags', '/api/pull', '/api/pull', ...load, '/api/pull', ...load]);
  expect(models.map(model => [model.source, model.roles])).toEqual([[presets[0]!.id, ['fast']], [presets[1]!.id, ['capable']]]);
  // The capable preset's 64K context needs the compressed context cache, which this server already has.
  expect(models[1]).toMatchObject({ context: 65536, reasoning: [], gpuShare: 1, sampling: presets[1]!.sampling });
  // Ollama's OpenAI API has no top_k or min_p, so the alias fixes them next to the context.
  expect(operations.filter(op => op.path === '/api/create').map(op => op.parameters)).toEqual([
    { num_ctx: 8192, top_k: 20, min_p: 0, repeat_penalty: 1 }, { num_ctx: 65536, top_k: 20, min_p: 0, repeat_penalty: 1 },
  ]);
  expect(prompts.choose).not.toHaveBeenCalled();
  expect(system.commands.filter(([executable]) => ['setx', 'taskkill', 'spawn'].includes(executable!))).toEqual([]);
});

it('warns when a prepared model does not fit in GPU memory', async () => {
  ollama([presets[1]!.id], false, undefined, 0.8);
  const prompts = ui(['2']);
  const [model] = await selectOllamaModel(prompts, new AbortController().signal);
  expect(model!.gpuShare).toBeCloseTo(0.8);
  expect(prompts.log).toHaveBeenCalledWith(expect.stringMatching(/^Only 80% of .* fits in GPU memory at this context; the rest runs on the CPU/));
});

it('suggests the preset context only once the Ollama server keeps a compressed context cache', async () => {
  const platform = Object.getOwnPropertyDescriptor(process, 'platform')!;
  Object.defineProperty(process, 'platform', { value: 'win32' });
  try {
    ollama();
    const server = presets[1]!.server!;
    // Declined: nothing is saved or restarted, and setup suggests the smaller context.
    system.saved = {};
    const declined = ui([]);
    declined.confirm = vi.fn(async () => false);
    expect(await ensureServerSettings(declined, server, new AbortController().signal)).toBe(false);
    expect(declined.confirm).toHaveBeenCalledWith('Save OLLAMA_FLASH_ATTENTION=1 and OLLAMA_KV_CACHE_TYPE=q8_0 for your Windows user and restart Ollama? Models loaded in Ollama are unloaded.');
    expect(system.commands.filter(([executable]) => executable !== 'reg')).toEqual([]);
    const fallback = ui(['2', '']);
    fallback.confirm = vi.fn(async message => !message.startsWith('Save'));
    const [model] = await selectOllamaModel(fallback, new AbortController().signal);
    expect(fallback.input).toHaveBeenCalledWith('Context tokens', '32768');
    expect(model!.context).toBe(32768);

    // Accepted: both settings are saved for the user and Ollama restarts with them.
    system.commands = [];
    expect(await ensureServerSettings(ui([]), server, new AbortController().signal)).toBe(true);
    expect(system.saved).toEqual(serverReady);
    expect(system.commands.filter(([executable]) => executable !== 'reg').map(([executable, ...args]) => [executable, args[0], args[1]])).toEqual([
      ['setx', 'OLLAMA_FLASH_ATTENTION', '1'], ['setx', 'OLLAMA_KV_CACHE_TYPE', 'q8_0'],
      ['taskkill', '/IM', 'ollama app.exe'], ['taskkill', '/IM', 'ollama.exe'], ['spawn', expect.stringContaining('ollama app.exe'), undefined],
    ]);
    // Already saved: nothing to ask.
    const ready = ui([]);
    expect(await ensureServerSettings(ready, server, new AbortController().signal)).toBe(true);
    expect(ready.confirm).not.toHaveBeenCalled();
  } finally { Object.defineProperty(process, 'platform', platform); }
});

it('asks for the role of a non-preset model and rejects two models claiming one role', async () => {
  ollama(['custom:1b', presets[1]!.id]);
  const prompts = ui(['3, 2']);
  prompts.choose = vi.fn(async () => 0);
  await expect(selectOllamaModel(prompts, new AbortController().signal)).rejects.toThrow(/both assigned the capable role/);
  expect(prompts.choose).toHaveBeenCalledWith('Role for custom:1b', ['Capable (coding and harder work)', 'Fast (quick answers)', 'Both fast and capable'], 0);
  const fastPrompts = ui(['3, 2']);
  fastPrompts.choose = vi.fn(async () => 1);
  const models = await selectOllamaModel(fastPrompts, new AbortController().signal);
  expect(models.map(model => [model.source, model.roles])).toEqual([['custom:1b', ['fast']], [presets[1]!.id, ['capable']]]);
});

it('reuses the fast model and pulls the capable preset without a conversion prompt', async () => {
  const operations = ollama([presets[0]!.id]);
  const prompts = ui(['1,2']);
  await selectOllamaModel(prompts, new AbortController().signal);
  expect(operations.filter(op => op.path === '/api/pull').map(op => op.model)).toEqual([presets[1]!.id]);
  expect(prompts.input).toHaveBeenCalledTimes(3);
});

it('throws with the Ollama message when the prepared model fails to load', async () => {
  const loadError = "llama-server process has terminated: exit status 1: error loading model: check_tensor_dims: tensor 'blk.64.attn_norm.weight' not found";
  const operations = ollama([], false, loadError);
  const prompts = ui(['0']);
  await expect(selectOllamaModel(prompts, new AbortController().signal)).rejects.toThrow(new RegExp(`could not load ${presets[0]!.id.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}.*tensor 'blk\\.64\\.attn_norm\\.weight' not found`));
  expect(operations.map(op => op.path)).toEqual(['/api/tags', '/api/pull', '/api/show', '/api/create', '/api/generate']);
});

it('stops the queue on cancellation without starting subsequent downloads', async () => {
  const operations = ollama();
  const controller = new AbortController();
  const prompts = ui(['1,2']);
  prompts.confirm = async message => {
    if (message.startsWith('Download')) controller.abort();
    return false;
  };
  await expect(selectOllamaModel(prompts, controller.signal)).rejects.toThrow();
  expect(operations.filter(op => op.path === '/api/pull')).toEqual([]);
});

it('prunes stale generations after successful save, keeping active plus one previous', async () => {
  const { pruneGenerations } = await import('../src/setup/index.js');
  const { join } = await import('node:path');
  const { mkdtemp, writeFile, readdir, rm } = await import('node:fs/promises');
  const { tmpdir } = await import('node:os');

  const tmpDir = await mkdtemp(join(tmpdir(), 'prune-'));
  try {
    // Create 4 old generations with staggered mtimes (using old UUIDs)
    const oldUuids = ['uuid-1111-1111-1111-111111111111', 'uuid-2222-2222-2222-222222222222', 'uuid-3333-3333-3333-333333333333', 'uuid-4444-4444-4444-444444444444'];
    for (let i = 0; i < oldUuids.length; i++) {
      const uuid = oldUuids[i];
      await writeFile(join(tmpDir, `models-${uuid}.json`), '{}');
      await writeFile(join(tmpDir, `policy-${uuid}.json`), '{}');
      if (i < 3) await new Promise(resolve => setTimeout(resolve, 10));
    }

    // Create .env pointing to the most recent old generation
    const activeUuid = oldUuids[3];
    const envContent = `TEAPILOT_MODELS_FILE="models-${activeUuid}.json"\nTEAPIPOLT_POLICY_FILE="policy-${activeUuid}.json"\n`;
    await writeFile(join(tmpDir, '.env'), envContent);

    // Call pruneGenerations which should keep active + 1 previous and delete the rest
    await pruneGenerations(tmpDir);

    // Check what generations remain
    const files = await readdir(tmpDir);
    const generationFiles = files.filter(f => /^(models|policy)-.*\.json$/.test(f));

    // Should have 2 pairs (4 files total): the active + 1 most recent previous
    expect(generationFiles).toHaveLength(4);

    // Verify the active generation still exists
    expect(files).toContain(`models-${oldUuids[3]}.json`);
    expect(files).toContain(`policy-${oldUuids[3]}.json`);

    // Verify the most recent previous generation still exists
    expect(files).toContain(`models-${oldUuids[2]}.json`);
    expect(files).toContain(`policy-${oldUuids[2]}.json`);

    // Verify older generations are deleted
    expect(files).not.toContain(`models-${oldUuids[0]}.json`);
    expect(files).not.toContain(`policy-${oldUuids[0]}.json`);
    expect(files).not.toContain(`models-${oldUuids[1]}.json`);
    expect(files).not.toContain(`policy-${oldUuids[1]}.json`);
  } finally {
    await rm(tmpDir, { recursive: true, force: true });
  }
});

it('names prepared Ollama aliases after their source model', () => {
  expect(ollamaAlias('qwen3-coder:30b')).toBe('teapilot/qwen3-coder:30b');
  expect(ollamaAlias('llama3')).toBe('teapilot/llama3:latest');
  expect(ollamaAlias('hf.co/Org/Model-GGUF:Q4_K_M')).toBe('teapilot/hf.co-org-model-gguf:Q4_K_M');
});
