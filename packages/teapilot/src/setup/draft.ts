import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { parse } from 'dotenv';
import { during } from '../activity.js';
import { loadConfig, modelsSchema, physicalModels, policySchema, tiers, type Config, type PhysicalModel, type Tier } from '../config.js';
import { endpointHint, liveCheck, modelStatus, type LiveReport } from '../diagnostics.js';
import { effectiveProfile, profileAvailable, profileFor, reasoningTier, type ThinkingLevel } from '../routing/execution.js';
import { saveConfiguration } from './index.js';
import { endpointLabel, type Endpoint, type ProvisionedModel, type RuntimeDriver, type Runtimes } from '../runtime/index.js';
import type { SetupUI } from './terminal.js';

// The tier each physical model is verified through during setup.
export const roleTier: Record<PhysicalModel, Tier> = { fast: 'fast', capable: 'normal' };

export interface CredentialStorage {
  load(): Promise<Record<string, string>>;
  save(credentials: Record<string, string>): Promise<void>;
}

/** Settings being edited. Nothing here is written until the user saves. */
export interface Draft {
  directory: string;
  hasConfiguration: boolean;
  config: Config;
  env: Record<string, string>;
  before: { models: string; routing: string | undefined; search: string };
  previousModels: Config['models'];
}

export async function loadDraft(directory: string, hasConfiguration: boolean, credentials?: CredentialStorage): Promise<Draft> {
  // Start from existing policy/settings when available. Environment is cloned so
  // setup never mutates the running process or leaks secrets to installer children.
  let savedEnv: Record<string, string> = {};
  if (hasConfiguration) savedEnv = parse(await readFile(resolve(directory, '.env')));
  Object.assign(savedEnv, await credentials?.load());
  const config = await loadConfig(directory, { ...savedEnv });
  if (process.env.TEAPILOT_STATE_DIR) config.stateDir = resolve(process.env.TEAPILOT_STATE_DIR);
  const before = { models: Object.values(config.models).filter(model => model.enabled).map(model => model.id).join(', '), routing: config.routingMode, search: config.searchUrl ?? 'Disabled' };
  if (!hasConfiguration) config.routingMode = 'direct';
  const env: Record<string, string> = { ...savedEnv };
  if (process.env.TEAPILOT_STATE_DIR) env.TEAPILOT_STATE_DIR = config.stateDir.replace(/\\/g, '/');
  // Remove old overrides for settings the wizard owns; otherwise saved .env
  // values would silently undo the newly written JSON configuration.
  for (const key of Object.keys(env)) {
    if (/^(LOCAL|ECONOMY|STRONG)_(ENABLED|MODEL|BASE_URL|INPUT_USD_PER_MILLION|OUTPUT_USD_PER_MILLION)$/.test(key) || ['REQUEST_BUDGET_USD', 'DAILY_BUDGET_USD'].includes(key)) delete env[key];
  }
  return { directory, hasConfiguration, config, env, before, previousModels: structuredClone(config.models) };
}

/** A copy that can be edited and discarded without touching the original. */
export function cloneConfig(config: Config): Config {
  return { ...config, models: structuredClone(config.models), policy: structuredClone(config.policy), router: { ...config.router }, secrets: { ...config.secrets } };
}

export async function numberInput(ui: SetupUI, label: string, fallback: number | undefined, minimum: number, maximum = Infinity): Promise<number> {
  for (;;) {
    const value = Number(await ui.input(label, fallback === undefined ? undefined : String(fallback)));
    if (Number.isFinite(value) && value >= minimum && value <= maximum) return value;
    ui.log(maximum === Infinity ? `Enter a number of at least ${minimum}.` : `Enter a number from ${minimum} to ${maximum}.`);
  }
}

export async function configureRouting(config: Config, env: Record<string, string>, ui: SetupUI): Promise<void> {
  ui.log('Routing decides which of your models handles each request. Direct routing needs no routing key.');
  //if (config.routingMode === 'hosted') ui.log('£ Hosted routing is charged, even though the models run locally.');
  const routing = await ui.choose('Routing', [`Keep current: \`${config.routingMode}\``, 'Direct', 'Jev by TypeSafe £']);
  if (routing !== 0) config.routingMode = routing === 1 ? 'direct' : 'hosted';
  if (routing === 2) {
    const provider = await ui.choose('Jev provider:', ['TypeSafe', 'OpenRouter']) === 0 ? 'typesafe' : 'openrouter';
    const keyName = provider === 'typesafe' ? 'TYPESAFE_API_KEY' : 'OPENROUTER_API_KEY';
    const key = await ui.input('Routing API key (hidden; blank keeps existing)', env[keyName] ?? '', true);
    if (!key) throw new Error('Hosted routing needs a routing key. Choose direct routing or provide a key.');
    env.JEV_PROVIDER = provider;
    env[keyName] = key;
    config.router.provider = provider;
    config.router.apiKey = key;
  }
}

/**
 * Fill ordinary model entries from what a runtime provisioned. Only these models
 * are enabled (never a silent paid fallback), and no reasoning level counts as
 * verified until live checks pass.
 */
export function applyProvisioned(config: Config, env: Record<string, string>, driver: Pick<RuntimeDriver, 'requestTimeoutMs'>, provisioned: ProvisionedModel[]): { roles: PhysicalModel[]; displayModel: string } {
  for (const model of Object.values(config.models)) model.enabled = false;
  for (const item of provisioned) for (const role of item.roles) {
    const model = config.models[role];
    Object.assign(model, { inputUsdPerMillion: 0, outputUsdPerMillion: 0, ...item.model, reasoning: item.model.reasoning, reasoningEfforts: ['off'] });
    // The fast tier never produces more than its profile allows.
    if (role === 'fast') model.maxOutputTokens = Math.min(model.maxOutputTokens, profileFor('fast').maxOutputTokens);
    if (item.apiKeyEnv) model.apiKeyEnv = item.apiKeyEnv;
    if (item.apiKey === null) delete env[model.apiKeyEnv];
    else if (item.apiKey !== undefined) env[model.apiKeyEnv] = item.apiKey;
  }
  if (driver.requestTimeoutMs) config.policy.limits.requestTimeoutMs = driver.requestTimeoutMs;
  const roles = physicalModels.filter(role => provisioned.some(model => model.roles.includes(role)));
  return { roles, displayModel: provisioned.map(model => `${model.source} (${model.roles.join(' + ')})`).join(', ') };
}

export async function askEndpoint(ui: SetupUI, env: Record<string, string>, config: Config, preset: Partial<Endpoint> = {}): Promise<Endpoint> {
  const current = config.models.capable;
  const baseUrl = preset.baseUrl ?? await ui.input('API base URL including /v1', current.provider === 'local' ? current.baseUrl : 'http://127.0.0.1:8080/v1');
  const id = preset.id ?? await ui.input('Exact model ID', current.provider === 'local' ? current.id : undefined);
  const contextTokens = preset.contextTokens ?? await numberInput(ui, 'Actual server context tokens', current.provider === 'local' ? current.contextTokens : 16384, 8192);
  const key = 'key' in preset ? preset.key : await ui.input('API key if required (hidden; blank keeps existing)', env[current.apiKeyEnv] ?? '', true);
  return { baseUrl, id, contextTokens, key };
}


export interface ModelSource { id: string; label: string; driver?: RuntimeDriver; unavailable?: string; summary?: string[] }

/**
 * Where models can run, in the order setup offers them. The existing endpoint
 * has no driver until its details are known. A managed runtime that cannot run
 * on this machine is still listed, with the reason.
 */
export async function modelSources(runtimes: Runtimes, signal: AbortSignal): Promise<ModelSource[]> {
  const managed = async (driver: RuntimeDriver): Promise<ModelSource> => {
    const suitability = await driver.suitability(signal);
    return suitability.suitable
      ? { id: driver.id, label: driver.label, driver, summary: [`${driver.label}: ${suitability.summary}`, ...suitability.notes ?? []] }
      : { id: driver.id, label: `${driver.label} · unavailable`, driver, unavailable: suitability.reason, summary: [`${driver.label} is not available on this computer: ${suitability.reason}`] };
  };
  return [await managed(runtimes.ollama), { id: 'endpoint', label: endpointLabel }, ...runtimes.nvidia ? [await managed(runtimes.nvidia)] : []];
}

/** Resolve secrets, validate, and enable exactly the given roles. */
export function finishModels(config: Config, env: Record<string, string>, roles: PhysicalModel[]): void {
  config.secrets = Object.fromEntries(physicalModels.map(name => [name, env[config.models[name].apiKeyEnv] || undefined])) as Config['secrets'];
  modelsSchema.parse(config.models); policySchema.parse(config.policy);
  for (const role of roles) config.models[role].enabled = true;
}

/** Status and live checks. Returns undefined for a role whose checks were skipped or unavailable. */
export async function checkModels(config: Config, roles: PhysicalModel[], ui: SetupUI, signal: AbortSignal): Promise<Map<PhysicalModel, LiveReport | undefined>> {
  const reports = new Map<PhysicalModel, LiveReport | undefined>();
  let runLive: boolean | undefined;
  for (const role of roles) {
    const tier = roleTier[role];
    const label = roles.length > 1 ? `[${role}] ` : '';
    const status = await during(ui, `Checking ${role} model endpoint...`, () => modelStatus(config, tier, signal));
    let report: LiveReport | undefined;
    if (status) { ui.log(`${label}Endpoint ${config.models[role].baseUrl}: ${status}`); await during(ui, 'Checking local endpoint...', () => endpointHint(config, tier, ui.log, signal)); }
    else if (runLive ??= await ui.confirm(`Run live local checks, bounded by the configured request/day limits?`)) {
      report = await during(ui, `Verifying ${role} answers and coding...`, () => liveCheck(config, tier, signal, ui.log, candidates(config, role)));
    }
    ui.log(`${label}${report?.coding ? 'Ready: answers, tool continuation, and a verified file edit passed.' : report?.ask ? 'Partial: answers work; coding is disabled until validation passes.' : 'Partial: inference is unverified. Use teapilot doctor --live after fixing the endpoint.'}`);
    if (report?.reasoning) ui.log(`${label}Reasoning: ${reasoningLine(report)}`);
    reports.set(role, report);
  }
  return reports;
}

/** Reasoning levels the model's protocol can request, still to be verified. */
export function candidates(config: Config, role: PhysicalModel): ThinkingLevel[] {
  const values = config.models[role].reasoning?.values ?? {};
  return (['medium', 'xhigh'] as const).filter(level => values[level] !== undefined);
}

/**
 * Failed or skipped coding validation never advertises a ready coding path, and
 * only reasoning levels whose own check passed are enabled. Higher tiers on the
 * same model inherit the coding result of the tier that was checked.
 */
export function applyReports(config: Config, roles: PhysicalModel[], reports: Map<PhysicalModel, LiveReport | undefined>): void {
  for (const role of roles) {
    const report = reports.get(role), model = config.models[role];
    model.toolCalling = Boolean(report?.tools);
    model.reasoningEfforts = ['off', ...report?.reasoning ?? []];
    const coder = tiers.filter(tier => profileFor(tier).model === role).map(tier => `coder.${tier}`);
    config.policy.disabledCapabilities = config.policy.disabledCapabilities.filter(id => !coder.includes(id));
    if (!report?.coding) config.policy.disabledCapabilities.push(...coder);
  }
}

function reasoningLine(report: LiveReport | undefined): string {
  return (['medium', 'xhigh'] as const).map(level => `${reasoningTier[level]} ${report?.reasoning?.includes(level) ? 'Passed' : 'unavailable'}`).join(' · ');
}

export function checksLine(report: LiveReport | undefined): string {
  return `answers ${report?.ask ? 'Passed' : 'unverified'} · tools ${report?.tools ? 'Passed' : 'unverified'} · coding ${report?.coding ? 'Passed' : 'disabled'} · ${reasoningLine(report)}`;
}

/** Context and output limits each tier will run with, so a change to them is visible before saving. */
export function tierLines(config: Config, roles: PhysicalModel[]): string[] {
  return roles.map(role => {
    const parts = tiers.filter(tier => profileFor(tier).model === role).map(tier => {
      if (!profileAvailable(config, tier).available) return `${tier} unavailable`;
      const profile = effectiveProfile(config, tier);
      return `${tier} ${profile.contextTokens.toLocaleString('en-US')} / ${profile.maxOutputTokens.toLocaleString('en-US')} output`;
    });
    return `  Tiers:     ${parts.join(' · ')}`;
  });
}

export function summaryLines(draft: Draft, config: Config, roles: PhysicalModel[], details: { displayModel?: string; checks: string; routingReady: boolean; searchStatus: string }): string[] {
  const { hasConfiguration, before, previousModels } = draft;
  const models = roles.map(role => config.models[role].id).join(', ');
  const lines = [`  Models:    ${details.displayModel ?? models}${hasConfiguration && before.models !== models ? ` (was ${before.models})` : ''}`];
  for (const role of roles) {
    const selected = config.models[role]; const previous = previousModels[role];
    lines.push(`  ${role[0]!.toUpperCase()}${role.slice(1)}: ${selected.baseUrl}${hasConfiguration && previous.baseUrl !== selected.baseUrl ? ` (was ${previous.baseUrl})` : ''} · ${selected.contextTokens.toLocaleString('en-US')} tokens${hasConfiguration && previous.contextTokens !== selected.contextTokens ? ` (was ${previous.contextTokens.toLocaleString('en-US')})` : ''}`);
  }
  lines.push(...tierLines(config, roles));
  lines.push(`  Budgets:   $${config.policy.budget.requestUsd}/request · $${config.policy.budget.dailyUsd}/UTC day`);
  lines.push(`  Routing:   ${config.routingMode}${config.routingMode === 'hosted' ? ' £' : ''}${hasConfiguration ? ` (was ${before.routing})` : ''}`);
  lines.push(`  Search:    ${details.searchStatus}${hasConfiguration ? ` (was ${before.search})` : ''}`);
  lines.push(`  Checks:    ${details.checks}`);
  lines.push(`  Routing check: ${config.routingMode === 'direct' ? 'Not needed' : details.routingReady ? 'Passed' : 'Not verified; see routing result above'}`);
  return lines;
}

/** Move credentials to their store, then commit the configuration generation. */
export async function persist(draft: Draft, config: Config, env: Record<string, string>, ui: SetupUI, signal: AbortSignal, credentials?: CredentialStorage): Promise<void> {
  if (credentials) {
    const keys = new Set([...Object.values(config.models).map(model => model.apiKeyEnv), 'JEV_API_KEY', 'TYPESAFE_API_KEY', 'OPENROUTER_API_KEY']);
    await credentials.save(Object.fromEntries(Object.entries(env).filter(([key]) => keys.has(key))));
    env = Object.fromEntries(Object.entries(env).filter(([key]) => !keys.has(key)));
  }
  await during(ui, 'Saving configuration...', () => saveConfiguration(draft.directory, config, env, signal));
}
