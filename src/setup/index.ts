import { during } from '../activity.js';
import { randomUUID } from 'node:crypto';
import { mkdir, open, readFile, readdir, rename, rm, stat } from 'node:fs/promises';
import { resolve } from 'node:path';
import { parse } from 'dotenv';
import { configDirectory, exists, loadConfig, modelsSchema, policySchema, userConfigDir, type Config, type Tier } from '../config.js';
import { modelFor, profileFor } from '../routing/execution.js';
import { liveCheck, modelStatus, routingCheck, endpointHint, type LiveReport } from '../diagnostics.js';
import { discoverModelCapabilities } from '../inference/capabilities.js';
import { command } from './ollama.js';
import { inspectHardware } from './hardware.js';
import { discoverRuntimeDrivers, runtimeDriver } from './runtimes.js';
import type { SetupUI } from './terminal.js';
import { configureSearch } from './search.js';

export interface SetupOptions { directory?: string; nonInteractive?: boolean; endpoint?: string; model?: string; contextTokens?: number; verbose?: boolean }
export interface CredentialStorage {
  load(): Promise<Record<string, string>>;
  save(credentials: Record<string, string>): Promise<void>;
}

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

async function numberInput(ui: SetupUI, label: string, fallback: number | undefined, minimum: number): Promise<number> {
  for (;;) {
    const value = Number(await ui.input(label, fallback === undefined ? undefined : String(fallback)));
    if (Number.isFinite(value) && value >= minimum) return value;
    ui.log(`Enter a number of at least ${minimum}.`);
  }
}

export async function setup(options: SetupOptions, ui: SetupUI, signal: AbortSignal, credentials?: CredentialStorage): Promise<boolean> {
  if (options.nonInteractive && (!options.endpoint || !options.model || !Number.isInteger(options.contextTokens))) throw new Error('Unattended setup requires --endpoint, --model, and integer --context-tokens.');
  const directory = resolve(options.directory ?? userConfigDir());
  ui.log(`Configuration: ${directory} (${options.directory ? 'explicit --config-dir' : 'personal profile'}). Repository selection is separate: use --cwd for coding.`);
  const launchDirectory = await configDirectory();
  const nextCommand = `teapilot ask --config-dir "${directory}" "Explain dependency injection"`;
  if (launchDirectory !== directory) ui.log(`Commands launched here select ${launchDirectory}, which shadows this setup. Use: ${nextCommand}`);
  const hasConfiguration = await exists(resolve(directory, '.env'));
  const files = await readdir(directory).catch(error => { if (error.code === 'ENOENT') return []; throw error; });
  if (!hasConfiguration && files.some(file => /^(models-|policy-|\.env-)/.test(file))) ui.log('Setup was interrupted before activation. Recovery will create a complete profile and reuse installed models.');
  if (hasConfiguration) {
    if (options.nonInteractive) throw new Error('Configuration already exists. Rerun teapilot setup interactively to retain or replace it.');
    if (await ui.choose(`Configuration exists at ${directory}.`, ['Keep settings and verify', 'Reconfigure (confirm before saving)']) === 0) {
      const { doctor } = await import('../diagnostics.js');
      const ready = await doctor(await loadConfig(directory, { ...process.env, ...await credentials?.load() }), process.cwd(), { live: true, signal, consent: ui.confirm, log: ui.log, activity: ui.activity });
      ui.log(`Next: ${nextCommand}`);
      return ready;
    }
  }
  // Start from existing policy/settings when available. Environment is cloned so
  // setup never mutates the running process or leaks secrets to installer children.
  let savedEnv: Record<string, string> = {};
  if (hasConfiguration) savedEnv = parse(await readFile(resolve(directory, '.env')));
  Object.assign(savedEnv, await credentials?.load());
  const config = await loadConfig(directory, { ...savedEnv });
  if (process.env.TEAPILOT_STATE_DIR) config.stateDir = resolve(process.env.TEAPILOT_STATE_DIR);
  const before = { execution: Object.values(config.models).filter(model => model.enabled).map(model => model.id).join(', '), routing: config.routingMode, search: config.searchUrl ?? 'Disabled' };
  ui.log('Model downloads and verification happen before the final settings review.');
  let env: Record<string, string> = { ...savedEnv };
  if (process.env.TEAPILOT_STATE_DIR) env.TEAPILOT_STATE_DIR = config.stateDir.replace(/\\/g, '/');
  for (const key of Object.keys(env)) {
    if (/^(LOCAL|ECONOMY|STRONG)_(ENABLED|MODEL|BASE_URL|INPUT_USD_PER_MILLION|OUTPUT_USD_PER_MILLION)$/.test(key) || ['REQUEST_BUDGET_USD', 'DAILY_BUDGET_USD'].includes(key)) delete env[key];
  }

  const hardware = await during(ui, 'Inspecting local hardware...', () => inspectHardware(signal));
  if (hardware.nvidia.length) ui.log(`NVIDIA: ${hardware.nvidia.map(gpu => `${gpu.name} (${(gpu.memoryMiB / 1024).toFixed(1)} GiB)`).join(', ')}`);
  else if (hardware.reason && !options.nonInteractive) ui.log(`Optimized NVIDIA unavailable: ${hardware.reason}`);

  const runtimeContext = { ui, signal, stateDir: config.stateDir, hardware, options, existingApiKey: env.LOCAL_API_KEY };
  const drivers = options.nonInteractive ? [runtimeDriver('openai-compatible')] : await discoverRuntimeDrivers(runtimeContext);
  if (!drivers.length) throw new Error('No local inference runtime is available.');
  const runtimeChoice = options.nonInteractive ? 0 : await ui.choose('Execution model', drivers.map(driver => driver.label));
  const driver = drivers[runtimeChoice];
  if (!driver) throw new Error('Invalid runtime selection.');
  const selection = await during(ui, `Preparing ${driver.label}...`, () => driver.prepare(runtimeContext));
  const tier = selection.tier;
  const previousModel = { ...modelFor(config, tier) };
  const displayModel = selection.displayModel;

  for (const model of Object.values(config.models)) model.enabled = false;
  const selectedModel = modelFor(config, tier);
  delete selectedModel.reasoning; delete selectedModel.temperature;
  Object.assign(selectedModel, selection.model, { enabled: true, inputUsdPerMillion: 0, outputUsdPerMillion: 0, compatibility: false });
  if (selection.clearApiKey) delete env[selectedModel.apiKeyEnv];
  else if (selection.apiKey) env[selectedModel.apiKeyEnv] = selection.apiKey;
  if (selection.requestTimeoutMs) config.policy.limits.requestTimeoutMs = selection.requestTimeoutMs;
  if (!hasConfiguration) config.routingMode = 'direct';

  ui.log('The router chooses a model; the execution model does the work. Direct routing needs no routing key.');
  if (config.routingMode === 'hosted') ui.log('Hosted routing may still incur charges, including when execution runs locally.');
  if (!options.nonInteractive) {
    const routing = await ui.choose('Routing', [`Keep current: ${config.routingMode}${config.routingMode === 'hosted' ? ' (may incur charges)' : ' (no routing charges)'}`, 'Direct (no hosted routing charges)', 'Hosted Jev (paid routing)']);
    if (routing !== 0) config.routingMode = routing === 1 ? 'direct' : 'hosted';
    if (routing === 2) {
      const provider = await ui.choose('Jev provider:', ['TypeSafe', 'OpenRouter']) === 0 ? 'typesafe' : 'openrouter';
      const keyName = provider === 'typesafe' ? 'TYPESAFE_API_KEY' : 'OPENROUTER_API_KEY';
      env.JEV_PROVIDER = provider;
      env[keyName] = await ui.input('Routing API key (hidden; blank keeps existing)', env[keyName] ?? '', true);
      config.router.provider = provider;
      config.router.apiKey = env[keyName] || undefined;
      if (!config.router.apiKey) throw new Error('Hosted routing needs a routing key. Rerun setup and choose direct or provide a key.');
    }
  }
  config.secrets = Object.fromEntries((['fast', 'capable'] as const).map(name => [name, env[config.models[name].apiKeyEnv] || undefined])) as Config['secrets'];
  modelsSchema.parse(config.models); policySchema.parse(config.policy);
  const discovered = await during(ui, 'Discovering model capabilities...', () => discoverModelCapabilities(modelFor(config, tier), config.secrets[profileFor(tier).model], signal));
  if (discovered.contextTokens && discovered.contextTokens >= 8192) {
    modelFor(config, tier).contextTokens = discovered.contextTokens;
    modelFor(config, tier).maxOutputTokens = Math.min(modelFor(config, tier).maxOutputTokens, Math.max(128, discovered.contextTokens - 2049));
  }
  if (discovered.vision !== undefined) modelFor(config, tier).vision = discovered.vision;
  const status = await during(ui, 'Checking model endpoint...', () => modelStatus(config, tier, signal));
  let report: LiveReport | undefined;
  if (status) { ui.log(`Endpoint ${modelFor(config, tier).baseUrl}: ${status}`); await during(ui, 'Checking local endpoint...', () => endpointHint(config, tier, ui.log, signal)); }
  else if (options.nonInteractive || await ui.confirm(`Run live local checks, bounded by the configured request/day limits?`)) {
    report = await during(ui, 'Verifying answers and coding...', () => liveCheck(config, tier, signal, ui.log));
  }
  // Advertised metadata is only a hint. Failed or skipped live verification
  // never advertises a ready coding path on any profile backed by this model.
  modelFor(config, tier).toolCalling = Boolean(report?.tools);
  const physical = profileFor(tier).model;
  const affectedTiers = (['fast', 'normal', 'reasoning', 'deep'] as const).filter(candidate => profileFor(candidate).model === physical);
  config.policy.disabledCapabilities = config.policy.disabledCapabilities.filter(id => !affectedTiers.some(candidate => id === `coder.${candidate}`));
  if (!report?.coding) for (const candidate of affectedTiers) config.policy.disabledCapabilities.push(`coder.${candidate}`);
  ui.log(report?.coding ? 'Ready: answers, tool continuation, and a verified file edit passed.' : report?.ask ? 'Partial: answers work; coding is disabled until validation passes.' : 'Partial: inference is unverified. Use teapilot doctor --live after fixing the endpoint.');
  const routingReady = config.routingMode === 'direct' || await during(ui, 'Verifying hosted routing...', () => routingCheck(config, ui.confirm, ui.log, signal));
  const searchStatus = options.nonInteractive ? (config.searchUrl ? 'Unchanged · not tested' : 'Disabled') : await configureSearch(config, env, directory, ui, signal);
  const selected = modelFor(config, tier);
  ui.log('\nReady to save');
  ui.log(`  Execution: ${displayModel ?? selected.id}${hasConfiguration && before.execution !== selected.id ? ` (was ${before.execution})` : ''}`);
  ui.log(`  Endpoint:  ${selected.baseUrl}${hasConfiguration && previousModel.baseUrl !== selected.baseUrl ? ` (was ${previousModel.baseUrl})` : ''}`);
  ui.log(`  Context:   ${selected.contextTokens.toLocaleString('en-US')} tokens${hasConfiguration && previousModel.contextTokens !== selected.contextTokens ? ` (was ${previousModel.contextTokens.toLocaleString('en-US')})` : ''}`);
  ui.log(`  Budgets:   $${config.policy.budget.requestUsd}/request · $${config.policy.budget.dailyUsd}/UTC day`);
  ui.log(`  Routing:   ${config.routingMode}${config.routingMode === 'hosted' ? ' · may incur charges' : ''}${hasConfiguration ? ` (was ${before.routing})` : ''}`);
  ui.log(`  Search:    ${searchStatus}${hasConfiguration ? ` (was ${before.search})` : ''}`);
  ui.log(`  Checks:    answers ${report?.ask ? 'Passed' : 'unverified'} · tools ${report?.tools ? 'Passed' : 'unverified'} · coding ${report?.coding ? 'Passed' : 'disabled'}`);
  ui.log(`  Routing check: ${config.routingMode === 'direct' ? 'Not needed' : routingReady ? 'Passed' : 'Not verified; see routing result above'}`);
  if (!options.nonInteractive && !await ui.confirm(hasConfiguration ? 'Save these settings? The previous configuration will be kept for rollback.' : 'Save these settings?')) {
    ui.log('Settings were not saved. Completed downloads and any local search service are retained.');
    return false;
  }
  if (credentials) {
    const keys = new Set([...Object.values(config.models).map(model => model.apiKeyEnv), 'JEV_API_KEY', 'TYPESAFE_API_KEY', 'OPENROUTER_API_KEY']);
    await credentials.save(Object.fromEntries(Object.entries(env).filter(([key]) => keys.has(key))));
    env = Object.fromEntries(Object.entries(env).filter(([key]) => !keys.has(key)));
  }
  await during(ui, 'Saving configuration...', () => saveConfiguration(directory, config, env, signal));
  ui.log(`Configuration saved in ${directory}. Environment variables still override saved settings.`);
  ui.log(report?.coding ? 'Model checks passed. See the routing and search results above.' : 'Partial: configuration saved; some model checks remain unverified.');
  ui.log(`Next: ${nextCommand}`);
  if (report?.coding) ui.log(`Then: teapilot code --config-dir "${directory}" --cwd "${process.cwd()}" "Describe this project"`);
  return Boolean(report?.ask && report.coding && routingReady);
}
