import { afterEach, expect, it, vi } from 'vitest';
import { chooseMany, type SetupUI } from '../src/setup/terminal.js';
import { presets, selectOllamaModel } from '../src/setup/ollama.js';

vi.mock('node:fs/promises', async importOriginal => ({
  ...await importOriginal<typeof import('node:fs/promises')>(),
  statfs: vi.fn(async () => ({ bavail: 100_000_000_000, bsize: 1 })),
}));

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

function ollama(installed: string[] = [], failFirstPull = false, loadError?: string) {
  const operations: Array<{ path: string; model: string }> = [];
  let failed = false;
  vi.stubGlobal('fetch', vi.fn(async (url: string, init: RequestInit) => {
    const path = new URL(url).pathname;
    const body = init.body ? JSON.parse(String(init.body)) : {};
    operations.push({ path, model: body.model });
    if (path === '/api/tags') return Response.json({ models: installed.map(name => ({ name, size: 1 })) });
    if (path === '/api/show') return Response.json({ capabilities: ['tools'], model_info: { 'qwen.context_length': 32768 } });
    if (path === '/api/pull' && failFirstPull && !failed) { failed = true; return new Response('{"error":"interrupted"}\n'); }
    if (path === '/api/generate' && loadError) return new Response(JSON.stringify({ error: loadError }), { status: 500 });
    return new Response('{"status":"success"}\n');
  }));
  return operations;
}

it('downloads and prepares queued models sequentially, retries in place and selects an active model', async () => {
  const operations = ollama([], true);
  const prompts = ui(['1, 2, 1']);
  prompts.choose = vi.fn(async () => 1);
  const model = await selectOllamaModel(prompts, new AbortController().signal);
  expect(operations.filter(op => op.path === '/api/pull').map(op => op.model)).toEqual([presets[0]!.id, presets[0]!.id, presets[1]!.id]);
  expect(operations.map(op => op.path)).toEqual(['/api/tags', '/api/pull', '/api/pull', '/api/show', '/api/create', '/api/generate', '/api/pull', '/api/show', '/api/create', '/api/generate']);
  expect(model.source).toBe(presets[1]!.id);
  expect(model.context).toBe(32768);
  expect(prompts.choose).toHaveBeenCalledWith('Active execution model', [presets[0]!.id, presets[1]!.id], 0);
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
