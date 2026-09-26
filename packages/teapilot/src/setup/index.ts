import { during } from '../activity.js';
import { randomUUID } from 'node:crypto';
import { mkdir, open, readFile, readdir, rename, rm, stat } from 'node:fs/promises';
import { resolve } from 'node:path';
import { parse } from 'dotenv';
import { configDirectory, exists, loadConfig, modelsSchema, policySchema, userConfigDir, type Config, type PhysicalModel } from '../config.js';
import { routingCheck } from '../diagnostics.js';
import { applyEndpoint, applyOllama, applyReports, askEndpoint, checkModels, checksLine, configureRouting, finishModels, loadDraft, persist, summaryLines, type CredentialStorage, type Draft } from './draft.js';
import { command, ensureOllama, selectOllamaModel } from './ollama.js';
import type { SetupUI } from './terminal.js';
import { configureSearch } from './search.js';

export type { CredentialStorage } from './draft.js';
export interface SetupOptions { directory?: string; nonInteractive?: boolean; endpoint?: string; model?: string; contextTokens?: number; verbose?: boolean }

async function privateWrite(path: string, contents: string, signal: AbortSignal): Promise<void> {
  const handle = await open(path, 'wx', 0o600);
  try {
    if (process.platform === 'win32') {
      const identity = await command('whoami', ['/user', '/fo', 'csv', '/nh'], signal);
      const sid = identity.match(/S-1-[\d-]+/)?.[0];
      if (!sid) throw new Error('Could not determine the account for private configuration permissions.');
      await command('icacls', [path, '/inheritance:r', '/grant:r', `*${sid}:F`], signal);
    }
    await handle.writeFile(contents); await handle.sync();
  } finally { await handle.close(); }
}

/** Best effort: after a commit, keep the active generation and the newest previous one for rollback. */
export async function pruneGenerations(directory: string): Promise<void> {
  try {
    const active = parse(await readFile(resolve(directory, '.env'), 'utf8')).TEAPILOT_MODELS_FILE?.match(/^models-(.+)\.json$/)?.[1];
    if (!active) return;
    const generations = new Map<string, string[]>();
    for (const file of await readdir(directory)) {
      const revision = file.match(/^(?:models|policy)-(.+)\.json$/)?.[1];
      if (revision && revision !== active) generations.set(revision, [...generations.get(revision) ?? [], file]);
    }
    const newest = async (files: string[]) => Math.max(0, ...await Promise.all(files.map(file => stat(resolve(directory, file)).then(info => info.mtimeMs, () => 0))));
    const ranked = await Promise.all([...generations].map(async ([revision, files]) => ({ revision, files, mtime: await newest(files) })));
    ranked.sort((a, b) => b.mtime - a.mtime);
    for (const { files } of ranked.slice(1)) for (const file of files) await rm(resolve(directory, file), { force: true }).catch(() => undefined);
  } catch { /* pruning never blocks a committed save */ }
}

function checkEnvironment(env: Record<string, string>): void {
  for (const [key, value] of Object.entries(env)) {
    if (!/^[A-Z][A-Z0-9_]*$/.test(key) || /[\r\n\0"\\]/.test(value)) throw new Error('Configuration values must be single-line strings without double quotes or backslashes.');
  }
}

async function commitEnvironment(directory: string, revision: string, values: Record<string, string>, signal: AbortSignal): Promise<void> {
  const pending = resolve(directory, `.env-${revision}.tmp`);
  try {
    await privateWrite(pending, Object.entries(values).map(([key, value]) => `${key}="${value}"`).join('\n') + '\n', signal);
    signal.throwIfAborted();
    await rename(pending, resolve(directory, '.env'));
  } finally { await rm(pending, { force: true }); }
}

/** Atomically replace only the private .env, leaving the active model and policy generation in place. */
export async function saveEnvironment(directory: string, env: Record<string, string>, signal: AbortSignal): Promise<void> {
  checkEnvironment(env);
  await mkdir(directory, { recursive: true, mode: 0o700 });
  await commitEnvironment(directory, randomUUID(), env, signal);
}

export async function saveConfiguration(directory: string, config: Config, env: Record<string, string>, signal: AbortSignal): Promise<void> {
  modelsSchema.parse(config.models); policySchema.parse(config.policy);
  env = { ...env };
  for (const key of ['TEAPILOT_MODELS_FILE', 'TEAPILOT_POLICY_FILE', 'TEAPILOT_STATE_DIR']) {
    if (env[key]) env[key] = env[key].replace(/\\/g, '/');
  }
  checkEnvironment(env);
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const revision = randomUUID();
  const modelFile = `models-${revision}.json`, policyFile = `policy-${revision}.json`;
  // Commit a complete generation by atomically replacing just its pointer. A
  // cancelled write leaves the previous config usable; after a commit the
  // newest previous generation is kept for rollback and older ones are pruned.
  await privateWrite(resolve(directory, modelFile), `${JSON.stringify(config.models, null, 2)}\n`, signal);
  await privateWrite(resolve(directory, policyFile), `${JSON.stringify(config.policy, null, 2)}\n`, signal);
  await commitEnvironment(directory, revision, { ...env, TEAPILOT_MODELS_FILE: modelFile, TEAPILOT_POLICY_FILE: policyFile, TEAPILOT_ROUTING_MODE: config.routingMode ?? 'hosted' }, signal);
  await pruneGenerations(directory);
}

export async function setup(options: SetupOptions, ui: SetupUI, signal: AbortSignal, credentials?: CredentialStorage): Promise<boolean> {
  if (options.nonInteractive && (!options.endpoint || !options.model || !Number.isInteger(options.contextTokens))) throw new Error('Unattended setup requires --endpoint, --model, and integer --context-tokens.');
  const directory = resolve(options.directory ?? userConfigDir());
  ui.log(`Configuration: ${directory} (${options.directory ? 'explicit --config-dir' : 'personal profile'}).`);
  const launchDirectory = await configDirectory();
  const nextCommand = `teapilot ask --config-dir "${directory}" "Explain dependency injection"`;
  if (launchDirectory !== directory) ui.log(`Commands launched here select ${launchDirectory}, which shadows this setup. Use: ${nextCommand}`);
  const hasConfiguration = await exists(resolve(directory, '.env'));
  const files = await readdir(directory).catch(error => { if (error.code === 'ENOENT') return []; throw error; });
  if (!hasConfiguration && files.some(file => /^(models-|policy-|\.env-)/.test(file))) ui.log('Setup was interrupted before activation. Recovery will create a complete profile and reuse installed models.');
  if (hasConfiguration && options.nonInteractive) throw new Error('Configuration already exists. Rerun teapilot setup interactively to change it.');
  const draft = await loadDraft(directory, hasConfiguration, credentials);
  // The tabbed screen needs a real terminal with room for it; otherwise questions come one after another.
  const screen = options.nonInteractive ? undefined : ui.screen?.();
  const outcome = screen
    ? await (await import('./tabs.js')).tabbedSetup(draft, screen, ui, signal, { verbose: options.verbose, credentials })
    : await linearSetup(draft, options, ui, signal, credentials);
  if (!outcome) return false;
  ui.log(outcome.coding ? 'Model checks passed. See the routing and search results above.' : 'Partial: configuration saved; some model checks remain unverified.');
  ui.log(`Next: ${nextCommand}`);
  if (outcome.coding) ui.log(`Then: teapilot code --config-dir "${directory}" --cwd "${process.cwd()}" "Describe this project"`);
  return outcome.ready;
}

/** One question after another: unattended setup, small terminals and scripted interfaces. */
async function linearSetup(draft: Draft, options: SetupOptions, ui: SetupUI, signal: AbortSignal, credentials?: CredentialStorage): Promise<{ ready: boolean; coding: boolean } | undefined> {
  const { config, env } = draft;
  ui.log('Model downloads and verification happen before the final settings review.');
  const choice = options.nonInteractive ? 1 : await ui.choose('Model source', ['Locally via Ollama', 'An existing local OpenAI-compatible endpoint']);
  let displayModel: string | undefined;
  let roles: PhysicalModel[] = ['capable'];
  if (!options.nonInteractive) await configureRouting(config, env, ui);
  if (choice === 0) {
    await during(ui, 'Preparing Ollama...', () => ensureOllama(ui, signal));
    const prepared = await during(ui, 'Inspecting local models...', () => selectOllamaModel(ui, signal, undefined, options.verbose));
    ({ roles, displayModel } = applyOllama(config, env, prepared));
  } else {
    const endpoint = await askEndpoint(ui, env, config, { baseUrl: options.endpoint, id: options.model, contextTokens: options.contextTokens, ...options.nonInteractive ? { key: process.env.LOCAL_API_KEY } : {} });
    applyEndpoint(config, env, endpoint);
  }
  finishModels(config, env, roles);
  const reports = await checkModels(config, roles, ui, signal);
  applyReports(config, roles, reports);
  const report = reports.get('capable') ?? reports.get('fast');
  const routingReady = config.routingMode === 'direct' || await during(ui, 'Verifying hosted routing...', () => routingCheck(config, ui.confirm, ui.log, signal));
  const searchStatus = options.nonInteractive ? (config.searchUrl ? 'Unchanged · not tested' : 'Disabled') : await configureSearch(config, env, draft.directory, ui, signal);
  ui.log('\nReady to save');
  for (const line of summaryLines(draft, config, roles, { displayModel, checks: checksLine(report), routingReady, searchStatus })) ui.log(line);
  if (!options.nonInteractive && !await ui.confirm(draft.hasConfiguration ? 'Save these settings? The previous configuration will be kept for rollback.' : 'Save these settings?')) {
    ui.log('Existing settings were retained');
    return undefined;
  }
  await persist(draft, config, env, ui, signal, credentials);
  ui.log(`Configuration saved in ${draft.directory}. Environment variables still override saved settings.`);
  return { ready: Boolean(report?.ask && report.coding && routingReady), coding: Boolean(report?.coding) };
}
