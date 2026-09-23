import { randomUUID } from 'node:crypto';
import { mkdir, open, readFile, readdir, rename, rm } from 'node:fs/promises';
import { resolve } from 'node:path';
import { parse } from 'dotenv';
import { configDirectory, exists, loadConfig, modelsSchema, policySchema, userConfigDir, type Config } from '../config.js';
import { liveCheck, modelStatus, routingCheck, endpointHint, type LiveReport } from '../diagnostics.js';
import { command, ensureOllama, ollamaURL, selectOllamaModel } from './ollama.js';
import type { SetupUI } from './terminal.js';

export interface SetupOptions { directory?: string; nonInteractive?: boolean; endpoint?: string; model?: string; contextTokens?: number }
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

export async function saveConfiguration(directory: string, config: Config, env: Record<string, string>, signal: AbortSignal): Promise<void> {
  modelsSchema.parse(config.models); policySchema.parse(config.policy);
  env = { ...env };
  for (const key of ['TEAPILOT_MODELS_FILE', 'TEAPILOT_POLICY_FILE', 'TEAPILOT_STATE_DIR']) {
    if (env[key]) env[key] = env[key].replace(/\\/g, '/');
  }
  for (const [key, value] of Object.entries(env)) {
    if (!/^[A-Z][A-Z0-9_]*$/.test(key) || /[\r\n\0"\\]/.test(value)) throw new Error('Configuration values must be single-line strings without double quotes or backslashes.');
  }
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const revision = randomUUID();
  const modelFile = `models-${revision}.json`, policyFile = `policy-${revision}.json`;
  const pending = resolve(directory, `.env-${revision}.tmp`);
  // Commit a complete generation by atomically replacing just its pointer. A
  // cancelled write leaves the previous config usable; prior generations remain.
  try {
    await privateWrite(resolve(directory, modelFile), `${JSON.stringify(config.models, null, 2)}\n`, signal);
    await privateWrite(resolve(directory, policyFile), `${JSON.stringify(config.policy, null, 2)}\n`, signal);
    const values = { ...env, TEAPILOT_MODELS_FILE: modelFile, TEAPILOT_POLICY_FILE: policyFile, TEAPILOT_ROUTING_MODE: config.routingMode ?? 'hosted' };
    await privateWrite(pending, Object.entries(values).map(([key, value]) => `${key}="${value}"`).join('\n') + '\n', signal);
    signal.throwIfAborted();
    await rename(pending, resolve(directory, '.env'));
  } finally { await rm(pending, { force: true }); }
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
      const ready = await doctor(await loadConfig(directory, { ...process.env, ...await credentials?.load() }), process.cwd(), { live: true, signal, consent: ui.confirm, log: ui.log });
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
  const choice = options.nonInteractive ? 1 : await ui.choose('Choose execution setup:', ['Local Ollama (no API key or inference charges)', 'Existing OpenAI-compatible local endpoint', 'Cloud model (paid API key)']);
  const tier = choice === 2 ? 'economy' : 'local';
  // A new profile enables precisely one execution tier, never a silent paid fallback.
  for (const model of Object.values(config.models)) model.enabled = false;
  config.models[tier].enabled = true;
  if (!hasConfiguration) config.routingMode = 'direct';
  let env: Record<string, string> = { ...savedEnv };
  if (process.env.TEAPILOT_STATE_DIR) env.TEAPILOT_STATE_DIR = config.stateDir.replace(/\\/g, '/');
  // Remove old overrides for settings the wizard owns; otherwise saved .env
  // values would silently undo the newly written JSON configuration.
  for (const key of Object.keys(env)) {
    if (/^(LOCAL|ECONOMY|STRONG)_(ENABLED|MODEL|BASE_URL|INPUT_USD_PER_MILLION|OUTPUT_USD_PER_MILLION)$/.test(key) || ['REQUEST_BUDGET_USD', 'DAILY_BUDGET_USD'].includes(key)) delete env[key];
  }
  ui.log('The router chooses a model; the execution model does the work. Direct routing needs no routing key.');
  if (!options.nonInteractive && await ui.confirm(`Change routing? Current: ${config.routingMode}.`)) {
    config.routingMode = await ui.choose('Routing:', ['Direct (no hosted routing charges)', 'Hosted Jev (optional paid routing)']) === 0 ? 'direct' : 'hosted';
    if (config.routingMode === 'hosted') {
      const provider = await ui.choose('Jev provider:', ['TypeSafe', 'OpenRouter']) === 0 ? 'typesafe' : 'openrouter';
      const keyName = provider === 'typesafe' ? 'TYPESAFE_API_KEY' : 'OPENROUTER_API_KEY';
      env.JEV_PROVIDER = provider;
      env[keyName] = await ui.input('Routing API key (hidden; blank keeps existing)', env[keyName] ?? '', true);
      config.router.provider = provider;
      config.router.apiKey = env[keyName] || undefined;
      if (!config.router.apiKey) throw new Error('Hosted routing needs a routing key. Rerun setup and choose direct or provide a key.');
    }
  }
  if (choice === 0) {
    await ensureOllama(ui, signal);
    const model = await selectOllamaModel(ui, signal);
    Object.assign(config.models.local, { id: model.id, provider: 'ollama', baseUrl: `${ollamaURL}/v1`, apiKeyEnv: 'LOCAL_API_KEY', contextTokens: model.context, maxOutputTokens: 2048, toolCalling: model.tools, supportsDeveloperRole: false, supportsUsage: true, temperature: 0.2 });
    delete env.LOCAL_API_KEY;
    config.policy.limits.requestTimeoutMs = 120000;
  } else {
    const model = config.models[tier];
    model.baseUrl = options.endpoint ?? await ui.input('API base URL including /v1', choice === 2 ? 'https://openrouter.ai/api/v1' : 'http://127.0.0.1:8080/v1');
    model.id = options.model ?? await ui.input('Exact model ID');
    model.contextTokens = options.contextTokens ?? await numberInput(ui, 'Actual server context tokens', 16384, 8192);
    model.maxOutputTokens = Math.min(2048, Math.floor(model.contextTokens / 4));
    model.toolCalling = true;
    model.provider = choice === 2 && new URL(model.baseUrl).hostname === 'openrouter.ai' ? 'openrouter' : 'local';
    const key = options.nonInteractive ? process.env.LOCAL_API_KEY ?? '' : await ui.input(choice === 2 ? 'API key (hidden; blank keeps existing)' : 'API key if required (hidden; blank keeps existing)', env[model.apiKeyEnv] ?? '', true);
    if (key) env[model.apiKeyEnv] = key;
    if (choice === 2) {
      if (!key) throw new Error('A cloud API key is required.');
      model.inputUsdPerMillion = await numberInput(ui, 'Conservative maximum input USD per million tokens (from your rate card)', model.inputUsdPerMillion || undefined, 0.000001);
      model.outputUsdPerMillion = await numberInput(ui, 'Conservative maximum output USD per million tokens (from your rate card)', model.outputUsdPerMillion || undefined, 0.000001);
      config.policy.budget.requestUsd = await numberInput(ui, 'Maximum USD per request', 1, 0);
      config.policy.budget.dailyUsd = await numberInput(ui, 'Maximum USD per UTC day', 5, 0);
      ui.log('Check these upper prices against your provider rate card before enabling cloud execution.');
    }
  }
  if (tier === 'local') { config.models.local.inputUsdPerMillion = 0; config.models.local.outputUsdPerMillion = 0; }
  config.secrets = Object.fromEntries(Object.entries(config.models).map(([name, model]) => [name, env[model.apiKeyEnv] || undefined])) as Config['secrets'];
  modelsSchema.parse(config.models); policySchema.parse(config.policy);
  const status = await modelStatus(config, tier, signal);
  let report: LiveReport | undefined;
  if (status) { ui.log(`Endpoint ${config.models[tier].baseUrl}: ${status}`); await endpointHint(config, tier, ui.log, signal); }
  else if (tier === 'local' || await ui.confirm(`Run paid live checks, bounded by $${config.policy.budget.requestUsd}/request and $${config.policy.budget.dailyUsd}/day?`)) {
    report = await liveCheck(config, tier, signal, ui.log);
  }
  // Failed or skipped coding validation never advertises a ready coding path.
  config.models[tier].toolCalling = Boolean(report?.tools);
  config.policy.disabledCapabilities = config.policy.disabledCapabilities.filter(id => id !== `coder.${tier}`);
  if (!report?.coding) config.policy.disabledCapabilities.push(`coder.${tier}`);
  ui.log(report?.coding ? 'Ready: answers, tool continuation, and a verified file edit passed.' : report?.ask ? 'Partial: answers work; coding is disabled until validation passes.' : 'Partial: inference is unverified. Use teapilot doctor --live after fixing the endpoint.');
  const routingReady = config.routingMode === 'direct' || await routingCheck(config, ui.confirm, ui.log, signal);
  if (hasConfiguration && !await ui.confirm('Replace the active settings? Previous configuration files will be retained.')) return false;
  if (credentials) {
    const keys = new Set([...Object.values(config.models).map(model => model.apiKeyEnv), 'JEV_API_KEY', 'TYPESAFE_API_KEY', 'OPENROUTER_API_KEY']);
    await credentials.save(Object.fromEntries(Object.entries(env).filter(([key]) => keys.has(key))));
    env = Object.fromEntries(Object.entries(env).filter(([key]) => !keys.has(key)));
  }
  await saveConfiguration(directory, config, env, signal);
  ui.log(`Configuration saved in ${directory}. Environment variables still override saved settings.`);
  ui.log(`Next: ${nextCommand}`);
  if (report?.coding) ui.log(`Then: teapilot code --config-dir "${directory}" --cwd "${process.cwd()}" "Describe this project"`);
  return Boolean(report?.ask && report.coding && routingReady);
}
