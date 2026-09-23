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

function ollama(installed: string[] = [], failFirstPull = false) {
  const operations: Array<{ path: string; model: string }> = [];
  let failed = false;
  vi.stubGlobal('fetch', vi.fn(async (url: string, init: RequestInit) => {
    const path = new URL(url).pathname;
    const body = init.body ? JSON.parse(String(init.body)) : {};
    operations.push({ path, model: body.model });
    if (path === '/api/tags') return Response.json({ models: installed.map(name => ({ name, size: 1 })) });
    if (path === '/api/show') return Response.json({ capabilities: ['tools'], model_info: { 'qwen.context_length': 32768 } });
    if (path === '/api/pull' && failFirstPull && !failed) { failed = true; return new Response('{"error":"interrupted"}\n'); }
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
  expect(operations.map(op => op.path)).toEqual(['/api/tags', '/api/pull', '/api/pull', '/api/show', '/api/create', '/api/pull', '/api/show', '/api/create']);
  expect(model.source).toBe(presets[1]!.id);
  expect(model.context).toBe(16384);
  expect(prompts.choose).toHaveBeenCalledWith('Active execution model', [presets[0]!.id, presets[1]!.id], 0);
});

it('reuses installed models and pulls the Q8_0 preset without a conversion prompt', async () => {
  const operations = ollama([presets[0]!.id]);
  const prompts = ui(['1,3']);
  await selectOllamaModel(prompts, new AbortController().signal);
  expect(operations.filter(op => op.path === '/api/pull').map(op => op.model)).toEqual(['hf.co/mradermacher/Qwen3.5-4B-Uncensored-GGUF:Q8_0']);
  expect(prompts.input).toHaveBeenCalledTimes(3);
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
