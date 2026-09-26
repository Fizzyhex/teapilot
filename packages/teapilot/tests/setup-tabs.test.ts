import { existsSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import { loadConfig } from '../src/config.js';
import { loadDraft } from '../src/setup/draft.js';
import { InstallQueue } from '../src/setup/installs.js';
import { renderScreen, SetupScreen, type ScreenState } from '../src/setup/screen.js';
import { setupTabs, tabbedSetup } from '../src/setup/tabs.js';
import type { SetupUI } from '../src/setup/terminal.js';
import type { RuntimeDriver, Runtimes } from '../src/runtime/index.js';
import { ollamaDriver } from '../src/runtime/ollama.js';

const cleanup: Array<() => Promise<void>> = [];
afterEach(async () => { vi.unstubAllEnvs(); for (const fn of cleanup.splice(0)) await fn(); });

const plain = (text: string) => text.replace(/\x1b\[[0-9;?]*[A-Za-z]/g, '');
function state(overrides: Partial<ScreenState> = {}): ScreenState {
  return { tabs: setupTabs, current: 'source', marks: {}, title: 'Model source', lines: [], choices: ['Locally via Ollama', 'Endpoint'], selected: 0, prompt: { label: 'Choose', fallback: '1', text: '', cursor: 0, secret: false }, hint: 'hint', ...overrides };
}

it('lays out tabs, sub-tabs, art and the input box like the design', () => {
  const art = Array.from({ length: 17 }, () => 'x'.repeat(60)).join('\n');
  const tall = renderScreen(state({ art }), 100, 60, false);
  expect(tall.lines).toHaveLength(60);
  expect(plain(tall.lines[1]!)).toContain('Manage Models > Routing > Run Checks > Configure Search > Save?');
  expect(tall.lines.some(line => line.includes('x'.repeat(60)))).toBe(true);
  const input = tall.lines.findIndex(line => line.includes('Choose [1]: '));
  expect(tall.lines[input + 2]).toContain('hint');
  expect(tall.cursor).toEqual({ row: input, col: 2 + 'Choose [1]: '.length });
  // Short terminals drop the art before the choices.
  const short = renderScreen(state({ art }), 100, 24, false);
  expect(short.lines.some(line => line.includes('x'.repeat(60)))).toBe(false);
  expect(short.lines.some(line => line.includes('2. Endpoint'))).toBe(true);
  // Sub-tabs appear once their tab is open; marks roll up to it.
  const models = renderScreen(state({ current: 'limits', marks: { install: 'changed' } }), 100, 30, false);
  expect(models.lines[1]).toContain('Manage Models ✓');
  expect(models.lines[2]).toContain('↳ Model source · Install models ✓ · Usage limits');
  // Narrow terminals use short tab names.
  expect(renderScreen(state(), 60, 30, false).lines[1]).toContain('Models > Routing > Checks');
});

it('shows installs top right only while one runs', () => {
  expect(renderScreen(state(), 100, 30, false).lines[0]!.trimStart()).toMatch(/^╭/);
  const running = renderScreen(state({ banner: 'downloading qwen - 25%' }), 100, 30, false);
  expect(running.lines[1]).toMatch(/^ +│ downloading qwen - 25% │$/);
  expect(running.lines[4]).toContain('Manage Models');
});

it('installs queued models one at a time, in order, and reports progress', async () => {
  const releases = new Map<string, () => void>();
  const started: string[] = [];
  const prepare = vi.fn(async (ui: SetupUI, signal: AbortSignal, id: string, context: number) => {
    started.push(id);
    ui.activity!({ kind: 'waiting', label: `Downloading ${id}...` });
    ui.log('pulling 25%');
    await new Promise<void>((resolve, reject) => { releases.set(id, resolve); signal.addEventListener('abort', () => reject(new Error('stopped'))); });
    if (id === 'broken') throw new Error('disk full');
    return { id: `teapilot/${id}`, source: id, context, tools: true };
  });
  const queue = new InstallQueue(new AbortController().signal, [], { prepare: prepare as never });
  const first = queue.add('first', 8192, 1e9);
  const second = queue.add('second', 8192);
  const broken = queue.add('broken', 8192);
  expect(queue.add('first', 8192)).toBe(first);
  expect(started).toEqual(['first']);
  expect(queue.status()).toBe('downloading first - 25% · 2 queued');
  expect(queue.reservedBytes).toBeCloseTo(1.1e9);
  queue.cancel(second);
  releases.get('first')!();
  await queue.settle([first], new AbortController().signal);
  expect(first).toMatchObject({ state: 'done', result: { id: 'teapilot/first' } });
  await vi.waitFor(() => expect(started).toEqual(['first', 'broken']));
  releases.get('broken')!();
  await queue.settle([broken], new AbortController().signal);
  expect(broken).toMatchObject({ state: 'failed', error: 'disk full' });
  expect(queue.status()).toBeUndefined();
  queue.retry(second);
  await vi.waitFor(() => expect(started).toEqual(['first', 'broken', 'second']));
  expect(queue.installed.map(model => model.name)).toEqual(['first']);
});

/** Drive a screen that is not attached to the terminal, as a user would through keys. */
function driver(screen: SetupScreen) {
  const internals = screen as unknown as { question?: { label: string }; title: string; key(value: string | undefined, key: object): void };
  const describe = () => `${internals.title}\n${internals.question?.label ?? ''}`;
  const until = async (pattern: RegExp) => {
    for (let tries = 0; tries < 2000; tries++) {
      if (internals.question && pattern.test(describe())) return;
      await new Promise(resolve => setImmediate(resolve));
    }
    throw new Error(`Expected ${pattern}, found ${describe()}`);
  };
  const type = (text: string) => { for (const character of text) internals.key(character, { name: character, sequence: character }); };
  return {
    wait: until,
    async answer(pattern: RegExp, text: string) { await until(pattern); type(text); internals.key('\r', { name: 'return' }); },
    async key(pattern: RegExp, name: string, extra: object = {}) { await until(pattern); internals.key(undefined, { name, ...extra }); },
  };
}

// No process or network: listing sources must not depend on this computer's GPU or Ollama.
const offline: Runtimes = { ollama: { ...ollamaDriver, suitability: async () => ({ suitable: true, summary: 'ok' }) } };

async function session(runtimes: Runtimes = offline) {
  const directory = await mkdtemp(join(tmpdir(), 'teapilot-tabs-'));
  cleanup.push(() => rm(directory, { recursive: true, force: true }));
  vi.stubEnv('TEAPILOT_STATE_DIR', join(directory, '.state'));
  const screen = new SetupScreen({ colour: false, motion: false });
  const messages: string[] = [];
  const ui: SetupUI = { log: text => messages.push(text), input: async () => '', choose: async () => 0, confirm: async () => false };
  const draft = await loadDraft(directory, false);
  return { directory, screen, messages, run: tabbedSetup(draft, screen, ui, new AbortController().signal, { runtimes }), drive: driver(screen) };
}

it('keeps finished tabs when the user leaves another part-way, and saves only on request', async () => {
  const { directory, screen, messages, run, drive } = await session();
  await drive.answer(/^Model source/, '2');
  await drive.answer(/API base URL/, 'http://127.0.0.1:9/v1');
  await drive.answer(/Exact model ID/, 'local-test');
  await drive.answer(/context tokens/, '16384');
  await drive.answer(/API key/, '');
  // An endpoint has nothing to install, so setup moves on to Usage limits.
  await drive.answer(/^Usage limits/, '2');
  expect(screen.markOf('source')).toBe('changed');
  await drive.answer(/Per-request budget/, '0.5');
  await drive.wait(/^Usage limits/);
  expect(screen.markOf('limits')).toBe('changed');
  await drive.answer(/^Usage limits/, '1');
  // Start switching to hosted routing, then leave for another tab before finishing.
  await drive.answer(/^Routing/, '3');
  await drive.key(/^Jev provider/, 'right');
  // Back to the first tab and forward again: earlier answers stay committed.
  await drive.key(/^Run Checks/, 'tab', { shift: true });
  await drive.key(/^Routing/, 'left');
  await drive.key(/^Usage limits/, 'left');
  await drive.key(/^Install models/, 'left');
  await drive.key(/^Model source/, 'right');
  await drive.key(/^Install models/, 'right');
  await drive.key(/^Usage limits/, 'right');
  await drive.key(/^Routing/, 'right');
  await drive.answer(/^Run Checks/, '2');
  await drive.answer(/^Web search/, '3');
  await drive.answer(/^Save these settings/, '1');
  expect(await run).toEqual({ ready: false, coding: false });
  const saved = await loadConfig(directory, {});
  expect(saved.models.capable).toMatchObject({ id: 'local-test', baseUrl: 'http://127.0.0.1:9/v1', enabled: true, toolCalling: false });
  expect(saved.routingMode).toBe('direct');
  expect(saved.policy.budget.requestUsd).toBe(0.5);
  expect(saved.policy.disabledCapabilities).toContain('coder.normal');
  expect(messages.join('\n')).toContain('Configuration saved');
});

it('Ctrl+C twice leaves without writing anything', async () => {
  const { directory, messages, run, drive } = await session();
  await drive.key(/^Model source/, 'c', { ctrl: true });
  await drive.key(/^Model source/, 'c', { ctrl: true });
  expect(await run).toBeUndefined();
  expect(messages.join('\n')).toContain('Settings were not saved');
  expect(existsSync(join(directory, '.env'))).toBe(false);
});

it('prepares a managed runtime through Model source and Install models, and explains one that cannot run here', async () => {
  const calls: string[] = [];
  const managed = (id: string, label: string, reason?: string): RuntimeDriver => ({
    id, label, ownership: 'managed',
    suitability: async () => reason ? { suitable: false, kind: 'hardware', reason } : { suitable: true, summary: 'ok' },
    inspect: async () => ({ ownership: 'managed', ready: true }),
    ensure: async () => { calls.push(`${id} ensure`); },
    provision: async () => {
      calls.push(`${id} provision`);
      return [{ roles: ['capable'], source: 'Big model', model: { id: 'big', provider: 'managed', baseUrl: 'http://127.0.0.1:9/v1', contextTokens: 32768, maxOutputTokens: 16384, toolCalling: true } }];
    },
  });
  const logs = (screen: SetupScreen) => (screen as unknown as { logs: Map<string, string[]> }).logs.get('source') ?? [];

  const blocked = await session({ ollama: managed('ollama', 'Locally via Ollama'), nvidia: managed('nvidia', 'Optimized NVIDIA', 'No NVIDIA GPU was found.') });
  await blocked.drive.wait(/^Model source/);
  expect(logs(blocked.screen)).toContain('Optimized NVIDIA is not available on this computer: No NVIDIA GPU was found.');
  await blocked.drive.answer(/^Model source/, '3');
  await blocked.drive.wait(/^Model source/);
  expect(calls).toEqual([]);
  await blocked.drive.key(/^Model source/, 'c', { ctrl: true });
  await blocked.drive.key(/^Model source/, 'c', { ctrl: true });
  expect(await blocked.run).toBeUndefined();

  const { directory, run, drive } = await session({ ollama: managed('ollama', 'Locally via Ollama'), nvidia: managed('nvidia', 'Optimized NVIDIA') });
  await drive.answer(/^Model source/, '3');
  await drive.answer(/^Install models/, '1');
  await drive.answer(/^Usage limits/, '1');
  await drive.answer(/^Routing/, '1');
  await drive.answer(/^Run Checks/, '2');
  await drive.answer(/^Web search/, '3');
  await drive.answer(/^Save these settings/, '1');
  expect(await run).toEqual({ ready: false, coding: false });
  expect(calls).toEqual(['nvidia ensure', 'nvidia provision']);
  const saved = await loadConfig(directory, {});
  expect(saved.models.capable).toMatchObject({ id: 'big', provider: 'managed', enabled: true, reasoningEfforts: ['off'] });
  expect(saved.models.fast.enabled).toBe(false);
  expect(saved.policy.disabledCapabilities).toEqual(expect.arrayContaining(['coder.normal', 'coder.reasoning', 'coder.deep']));
});
