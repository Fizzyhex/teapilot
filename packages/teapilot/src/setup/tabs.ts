import { during } from '../activity.js';
import { physicalModels, policySchema, type Config, type PhysicalModel } from '../config.js';
import { routingCheck, type LiveReport } from '../diagnostics.js';
import { applyEndpoint, applyOllama, applyReports, askEndpoint, checkModels, checksLine, cloneConfig, configureRouting, finishModels, numberInput, persist, summaryLines, type CredentialStorage, type Draft } from './draft.js';
import { InstallQueue, type InstallJob } from './installs.js';
import { configureOllamaModel, ensureOllama, hardware, isTeapilotAlias, ollamaAlias, ollamaJSON, presets, roleChoices, roleLabel, type OllamaModel, type PreparedModel } from './ollama.js';
import { Navigation, type ScreenTab, type SetupScreen } from './screen.js';
import { configureSearch } from './search.js';
import type { SetupUI } from './terminal.js';

export const setupTabs: ScreenTab[] = [
  { id: 'models', label: 'Manage Models', short: 'Models' },
  { id: 'source', label: 'Model source', parent: 'models' },
  { id: 'install', label: 'Install models', parent: 'models' },
  { id: 'limits', label: 'Usage limits', parent: 'models' },
  { id: 'routing', label: 'Routing' },
  { id: 'checks', label: 'Run Checks', short: 'Checks' },
  { id: 'search', label: 'Configure Search', short: 'Search' },
  { id: 'save', label: 'Save?' },
];
type TabId = 'source' | 'install' | 'limits' | 'routing' | 'checks' | 'search' | 'save';
const order: TabId[] = ['source', 'install', 'limits', 'routing', 'checks', 'search', 'save'];
const following = (tab: TabId): TabId => order[Math.min(order.indexOf(tab) + 1, order.length - 1)]!;

export interface Outcome { ready: boolean; coding: boolean }
/** A tab returns the tab to open next (the following one when undefined), or ends setup. */
type TabResult = TabId | undefined | { end: Outcome | undefined; summary?: string[] };

interface Session {
  draft: Draft;
  screen: SetupScreen;
  /** Setup's own signal: work started here outlives a tab change. */
  signal: AbortSignal;
  verbose?: boolean;
  credentials?: CredentialStorage;
  original: { models: Config['models']; env: Record<string, string>; routing: Config['routingMode']; provider: string; budget: Config['policy']['budget']; search?: string };
  source: 'keep' | 'ollama' | 'endpoint';
  ollamaReady: boolean;
  queue?: InstallQueue;
  hardware?: { memory: number; lines: string[] };
  /** Which queued model provides each role. */
  assignments: Partial<Record<PhysicalModel, InstallJob>>;
  notes: string[];
  checks?: { fingerprint: string; reports: Map<PhysicalModel, LiveReport | undefined>; routingReady: boolean };
  searchStatus: string;
}

/**
 * Setup as tabs. Each tab edits a copy of the settings and only commits it
 * when the tab finishes, so leaving a tab part-way never undoes earlier work.
 * Nothing is written to disk until Save.
 */
export async function tabbedSetup(draft: Draft, screen: SetupScreen, ui: SetupUI, root: AbortSignal, options: { verbose?: boolean; credentials?: CredentialStorage }): Promise<Outcome | undefined> {
  const quit = new AbortController();
  const signal = AbortSignal.any([root, quit.signal]);
  const { config, env } = draft;
  const session: Session = {
    draft, screen, signal, ...options,
    original: { models: structuredClone(config.models), env: { ...env }, routing: config.routingMode, provider: config.router.provider, budget: { ...config.policy.budget }, search: config.searchUrl },
    source: 'keep', ollamaReady: false, assignments: {}, notes: [],
    searchStatus: config.searchUrl ? 'Unchanged · not tested' : 'Disabled',
  };
  screen.tabs = setupTabs;
  screen.status = () => session.queue?.status();
  screen.onQuit = () => quit.abort(new Error('Setup was closed.'));
  let summary: string[] = [];
  let outcome: Outcome | undefined;
  try {
    let current: TabId = 'source';
    for (;;) {
      const tab = new AbortController();
      let requested: TabId | undefined;
      screen.navigate = target => { requested = target as TabId; tab.abort(new Navigation(target)); };
      const tabSignal = AbortSignal.any([signal, tab.signal]);
      updateMarks(session);
      screen.enter(current, tabSignal);
      let next: TabResult;
      try {
        try { next = await tabs[current](session, tabSignal); }
        catch (error) {
          if (requested || signal.aborted) throw error;
          // A failed step stays open with its error, rather than ending setup.
          screen.log(error instanceof Error ? error.message : String(error));
          screen.mark(current, 'attention');
          next = await screen.choose(`${screen.tabs.find(item => item.id === current)!.label} did not finish`, ['Try again', 'Skip to the next tab'], 0) === 0 ? current : following(current);
        }
      } catch (error) {
        if (requested) { current = requested; continue; }
        throw error;
      }
      if (typeof next === 'object') { outcome = next.end; summary = next.summary ?? []; break; }
      current = next ?? following(current);
    }
  } catch (error) {
    if (!quit.signal.aborted) throw error;
  } finally { screen.close(); }
  if (!outcome) {
    ui.log(session.queue?.pending.length ? 'Settings were not saved. Unfinished downloads have been stopped, and can be resumed next time by Ollama.' : 'Settings were not saved. (Completed downloads/local search service have been kept).');
    return undefined;
  }
  ui.log('\nSaved settings');
  for (const line of summary) ui.log(line);
  ui.log(`Configuration saved in ${draft.directory}. Environment variables still override saved settings.`);
  return outcome;
}

const tabs: Record<TabId, (session: Session, signal: AbortSignal) => Promise<TabResult>> = { source, install, limits, routing, checks, search, save };

/** The models the configuration had before setup started, if they run on Ollama. */
const currentlyOllama = (s: Session) => s.draft.hasConfiguration && physicalModels.some(role => s.original.models[role].enabled && s.original.models[role].provider === 'ollama');
const usesOllama = (s: Session) => s.source === 'ollama' || (s.source === 'keep' && currentlyOllama(s));

function restoreModels(s: Session): void {
  s.draft.config.models = structuredClone(s.original.models);
  const key = s.original.models.capable.apiKeyEnv;
  if (s.original.env[key] === undefined) delete s.draft.env[key]; else s.draft.env[key] = s.original.env[key]!;
}

async function readyOllama(s: Session): Promise<void> {
  if (s.ollamaReady) return;
  // Installing Ollama may run a system installer, which must not be interrupted by a tab change.
  await s.screen.lock('Preparing Ollama...', () => ensureOllama(s.screen, s.signal));
  s.ollamaReady = true;
}

/** The configuration Save would write, built from every committed tab. */
function candidate(s: Session) {
  const config = cloneConfig(s.draft.config), env = { ...s.draft.env };
  const problems: string[] = [], pending: InstallJob[] = [];
  let roles: PhysicalModel[] = s.source === 'endpoint' ? ['capable'] : physicalModels.filter(role => config.models[role].enabled);
  let displayModel: string | undefined;
  let changed = s.source === 'endpoint';
  const jobs = [...new Set(Object.values(s.assignments))];
  if (usesOllama(s) && jobs.length) {
    changed = true;
    const prepared: PreparedModel[] = [];
    for (const job of jobs) {
      const jobRoles = physicalModels.filter(role => s.assignments[role] === job);
      if (job.state === 'done') prepared.push({ ...job.result!, roles: jobRoles });
      else if (job.state === 'failed' || job.state === 'cancelled') problems.push(`${job.id} (${jobRoles.join(' + ')}) ${job.state === 'failed' ? `failed: ${job.error}` : 'was cancelled'}. Retry it or choose another model in Install models.`);
      else pending.push(job);
    }
    if (!problems.length && !pending.length) ({ roles, displayModel } = applyOllama(config, env, prepared));
  } else if (s.source === 'ollama' && !currentlyOllama(s)) problems.push('Choose at least one model in Manage Models › Install models.');
  else if (s.source === 'keep' && !s.draft.hasConfiguration) problems.push('Choose a model source first.');
  if (!problems.length && !pending.length) {
    if (!roles.length) problems.push('No model is enabled. Choose one in Manage Models › Model source.');
    else finishModels(config, env, roles);
  }
  return { config, env, roles, displayModel, changed, problems, pending };
}
type Candidate = ReturnType<typeof candidate>;

function fingerprint(c: Candidate): string {
  return JSON.stringify([c.roles.map(role => { const model = c.config.models[role]; return [role, model.id, model.baseUrl, model.contextTokens, model.provider, c.config.secrets[role] ?? '']; }), c.config.routingMode, c.config.router.provider, c.config.router.apiKey ?? '']);
}

function updateMarks(s: Session): void {
  const c = candidate(s);
  if (!s.checks) return;
  const fresh = !c.problems.length && !c.pending.length && s.checks.fingerprint === fingerprint(c);
  const passed = [...s.checks.reports.values()].every(report => report?.coding) && s.checks.routingReady;
  s.screen.mark('checks', fresh && passed ? 'changed' : 'attention');
}

function note(s: Session, text: string): void {
  s.notes = [...s.notes, text].slice(-4);
  s.screen.log(text);
}

async function source(s: Session): Promise<TabResult> {
  const { screen, draft } = s;
  screen.log('Choose where your models run. With Local Ollama, you pick the models next, in Install models.');
  if (draft.hasConfiguration) screen.log(`Current: ${draft.before.models || 'none enabled'}`);
  const choices = ['Locally via Ollama', 'An existing local OpenAI-compatible endpoint', ...draft.hasConfiguration ? ['Keep current models'] : []];
  const fallback = s.source === 'ollama' ? 0 : s.source === 'endpoint' ? 1 : draft.hasConfiguration ? 2 : 0;
  const choice = await screen.choose('Model source', choices, fallback);
  if (choice === 2) {
    restoreModels(s); s.source = 'keep'; screen.mark('source', undefined);
    return;
  }
  if (choice === 0) {
    await readyOllama(s);
    if (s.source !== 'ollama') restoreModels(s);
    s.source = 'ollama'; screen.mark('source', 'changed');
    return;
  }
  // Ask on a copy so leaving part-way through keeps the previous endpoint.
  const env = { ...draft.env };
  const endpoint = await askEndpoint(screen, env, cloneConfig(draft.config));
  restoreModels(s);
  applyEndpoint(draft.config, draft.env, endpoint);
  s.source = 'endpoint'; screen.mark('source', 'changed');
  // The endpoint already names its model, so there is nothing to install.
  return 'limits';
}

async function routing(s: Session): Promise<TabResult> {
  const config = cloneConfig(s.draft.config), env = { ...s.draft.env };
  await configureRouting(config, env, s.screen);
  s.draft.config.routingMode = config.routingMode;
  s.draft.config.router = config.router;
  s.draft.env = env;
  s.screen.mark('routing', config.routingMode !== s.original.routing || config.router.provider !== s.original.provider ? 'changed' : undefined);
  return undefined;
}

interface ModelRow { id?: string; preset?: typeof presets[number] }

function modelRows(s: Session): ModelRow[] {
  const installed = s.queue!.installed;
  const ids = [
    ...presets.map(preset => preset.id),
    ...installed.map(model => model.name).filter(name => !isTeapilotAlias(name)),
    ...s.queue!.jobs.map(job => job.id),
  ];
  return [...new Set(ids)].map(id => ({ id, preset: presets.find(preset => preset.id === id) }));
}

function rowLabel(s: Session, row: ModelRow): string {
  if (!row.id) return 'Custom local Ollama model';
  const id = row.id, preset = row.preset;
  const roles = physicalModels.filter(role => s.assignments[role]?.id === id);
  const job = roles.length ? s.assignments[roles[0]!] : s.queue!.jobs.findLast(item => item.id === id && (item.state === 'running' || item.state === 'queued'));
  const installed = s.queue!.installed.some(model => model.name === id);
  const state = job
    ? job.state === 'running' ? `${job.phase.split(' ')[0]!.toLowerCase()}${job.percent === undefined ? '' : ` ${job.percent}%`}`
      : job.state === 'done' ? 'ready' : job.state
    : installed ? 'installed'
    : preset ? `about ${(preset.bytes / 1e9).toFixed(1)} GB download, ${preset.memoryGiB}+ GiB RAM suggested` : 'not installed';
  const current = physicalModels.filter(role => s.original.models[role].enabled && s.original.models[role].provider === 'ollama' && s.original.models[role].id === ollamaAlias(id));
  const use = roles.length ? ` → ${roles.join(' + ')}` : current.length && s.source !== 'endpoint' ? ` · currently ${current.join(' + ')}` : '';
  return `${preset?.label ?? id} · ${state}${use}`;
}

/** Give a job the roles listed, taking them from whichever job had them. */
function assign(s: Session, job: InstallJob, roles: PhysicalModel[]): void {
  for (const role of physicalModels) {
    const previous = s.assignments[role];
    if (roles.includes(role)) {
      s.assignments[role] = job;
      if (previous && previous !== job) { note(s, `${previous.id} no longer handles ${role}.`); release(s, previous); }
    } else if (previous === job) delete s.assignments[role];
  }
  s.screen.mark('install', Object.keys(s.assignments).length ? 'changed' : undefined);
}
/** Stop installing a model once no role needs it. */
function release(s: Session, job: InstallJob): void {
  if (!Object.values(s.assignments).includes(job) && job.state !== 'done') s.queue!.cancel(job);
}

async function chooseRoles(s: Session, id: string, preset?: typeof presets[number]): Promise<PhysicalModel[]> {
  const fallback = preset ? roleChoices.findIndex(roles => roles.length === 1 && roles[0] === preset.role) : 0;
  return roleChoices[await s.screen.choose(`Role for ${id}`, roleChoices.map(roleLabel), fallback)]!;
}

async function install(s: Session, signal: AbortSignal): Promise<TabResult> {
  const { screen } = s;
  if (!usesOllama(s)) {
    screen.log(`Models run at ${s.draft.config.models.capable.baseUrl}. Installing models applies to Local Ollama.`);
    return await screen.choose('Install models', ['Continue to Usage limits', 'Switch to Local Ollama'], 0) === 1 ? 'source' : 'limits';
  }
  await readyOllama(s);
  if (!s.queue) {
    const tags = await during(screen, 'Inspecting local models...', () => ollamaJSON<{ models: OllamaModel[] }>('/api/tags', signal));
    s.hardware = await during(screen, 'Checking memory...', () => hardware(signal));
    s.queue = new InstallQueue(s.signal, tags.models.filter(model => !model.remote_model && !model.name.includes('cloud')), { verbose: s.verbose });
    s.queue.subscribe(() => { screen.refresh(); updateMarks(s); });
  }
  for (;;) {
    screen.clear();
    for (const line of s.hardware!.lines) screen.log(line);
    screen.log('Choose a model to use it. Downloads run in the background, one at a time, while you configure other tabs.');
    for (const line of s.notes) screen.log(line);
    const rows = [...modelRows(s), {}];
    const choice = await screen.chooseLive('Install models', () => ['Continue to Usage limits', ...rows.map(row => rowLabel(s, row))], 0);
    if (choice === 0) return 'limits';
    try { await modelAction(s, rows[choice - 1]!); }
    catch (error) {
      if (error instanceof Navigation || signal.aborted) throw error;
      note(s, error instanceof Error ? error.message : String(error));
    }
  }
}

async function modelAction(s: Session, row: ModelRow): Promise<void> {
  const { screen } = s;
  const queue = s.queue!;
  const id = row.id ?? await screen.input('Local Ollama model name');
  if (!/^[a-zA-Z0-9][a-zA-Z0-9._:/-]*$/.test(id) || id.includes('cloud')) throw new Error('Enter a local Ollama model name; cloud models are not a fully local setup.');
  const preset = presets.find(item => item.id === id);
  const roles = physicalModels.filter(role => s.assignments[role]?.id === id);
  const job = roles.length ? s.assignments[roles[0]!]! : undefined;
  if (job) {
    if (job.error) screen.log(`Last error: ${job.error}`);
    const retry = job.state === 'failed' || job.state === 'cancelled';
    const action = await screen.choose(`${id} → ${roles.join(' + ')}`, ['Keep as is', 'Change role', `Stop using this model${job.state === 'done' ? '' : ' (cancels its install)'}`, ...retry ? ['Retry install'] : []], retry ? 3 : 0);
    if (action === 1) assign(s, job, await chooseRoles(s, id, preset));
    else if (action === 2) { assign(s, job, []); note(s, `Stopped using ${id}.`); }
    else if (action === 3) { queue.retry(job); note(s, `Queued ${id} again.`); }
    return;
  }
  const chosen = await chooseRoles(s, id, preset);
  const context = await configureOllamaModel(screen, id, preset, queue.installed, s.hardware!.memory, queue.reservedBytes);
  const queued = queue.add(id, context, preset?.bytes ?? 0);
  assign(s, queued, chosen);
  note(s, `Queued ${id} for ${chosen.join(' + ')}${queue.pending.length > 1 ? ` (${queue.pending.length - 1} ahead)` : ''}.`);
}

async function limits(s: Session): Promise<TabResult> {
  const { screen } = s;
  const policy = s.draft.config.policy;
  const fields = [
    { key: 'requestUsd', label: 'Per-request budget', prompt: 'Per-request budget in USD' },
    { key: 'dailyUsd', label: 'Daily budget (UTC day)', prompt: 'Daily budget in USD' },
    { key: 'approvalThresholdUsd', label: 'Ask before a request that could cost', prompt: 'Ask for approval at or above, in USD' },
  ] as const;
  for (;;) {
    screen.clear();
    screen.log('Set budget caps for paid inference and routing?');
    const choice = await screen.choose('Usage limits', ['Continue to Routing', ...fields.map(field => `${field.label}: $${policy.budget[field.key]}`), 'Restore saved limits'], 0);
    if (choice === 0) return 'routing';
    if (choice === fields.length + 1) policy.budget = { ...s.original.budget };
    else {
      const field = fields[choice - 1]!;
      const value = await numberInput(screen, field.prompt, policy.budget[field.key], 0);
      policySchema.parse({ ...policy, budget: { ...policy.budget, [field.key]: value } });
      policy.budget[field.key] = value;
    }
    screen.mark('limits', JSON.stringify(policy.budget) === JSON.stringify(s.original.budget) ? undefined : 'changed');
  }
}

async function checks(s: Session, signal: AbortSignal): Promise<TabResult> {
  const { screen } = s;
  const c = candidate(s);
  if (c.problems.length) {
    for (const problem of c.problems) screen.log(problem);
    return await screen.choose('Run Checks', ['Open Install models', 'Skip checks for now'], 0) === 0 ? 'install' : 'search';
  }
  if (c.pending.length) {
    screen.log(`Waiting for ${c.pending.map(job => job.id).join(', ')} to install. You can keep configuring other tabs meanwhile.`);
    if (await screen.choose('Run Checks', ['Wait here, then run checks', 'Skip checks for now'], 0) === 1) return 'search';
    await during(screen, 'Waiting for installs to finish...', () => s.queue!.settle(c.pending, signal));
    return 'checks';
  }
  const print = fingerprint(c);
  if (s.checks?.fingerprint === print) {
    for (const [role, report] of s.checks.reports) screen.log(`  ${role}: ${checksLine(report)}`);
    if (c.config.routingMode !== 'direct') screen.log(`  Routing check: ${s.checks.routingReady ? 'Passed' : 'Not verified'}`);
    if (await screen.choose('Run Checks', ['Continue to Configure Search', 'Run checks again'], 0) === 0) return;
    screen.clear();
  } else {
    if (s.checks) screen.log('Settings changed since the last checks.');
    screen.log('Checks verify answers, tool use and a file edit to decide who\'s allowed to handle what jobs.');
    if (await screen.choose('Run Checks', [c.changed ? 'Re-run checks' : 'Run checks', 'Skip'], 0) === 1) return;
  }
  const reports = await checkModels(c.config, c.roles, screen, signal);
  const routingReady = c.config.routingMode === 'direct' || await during(screen, 'Verifying hosted routing...', () => routingCheck(c.config, screen.confirm, screen.log, signal));
  s.checks = { fingerprint: print, reports, routingReady };
  updateMarks(s);
  return await screen.choose('Checks finished', ['Continue to Configure Search', 'Run checks again'], 0) === 1 ? 'checks' : undefined;
}

async function search(s: Session, signal: AbortSignal): Promise<TabResult> {
  const config = cloneConfig(s.draft.config), env = { ...s.draft.env };
  const status = await configureSearch(config, env, s.draft.directory, s.screen, signal);
  s.searchStatus = status;
  s.draft.config.searchUrl = config.searchUrl;
  s.draft.config.policy.permissions = config.policy.permissions;
  s.draft.env = env;
  s.screen.mark('search', config.searchUrl !== s.original.search ? 'changed' : undefined);
  return undefined;
}

async function save(s: Session, signal: AbortSignal): Promise<TabResult> {
  const { screen, draft } = s;
  const c = candidate(s);
  if (c.pending.length) {
    screen.log(`Waiting for ${c.pending.map(job => job.id).join(', ')} to install before the settings can be saved.`);
    if (await screen.choose('Save?', ['Wait here, then review', 'Leave without saving'], 0) === 1) return await leave(s);
    await during(screen, 'Waiting for installs to finish...', () => s.queue!.settle(c.pending, signal));
    return 'save';
  }
  if (c.problems.length) {
    for (const problem of c.problems) screen.log(problem);
    const choice = await screen.choose('Save?', ['Open Model source', 'Open Install models', 'Leave without saving'], 0);
    return choice === 2 ? await leave(s) : choice === 0 ? 'source' : 'install';
  }
  const fresh = s.checks?.fingerprint === fingerprint(c) ? s.checks : undefined;
  const report = fresh?.reports.get('capable') ?? fresh?.reports.get('fast');
  const routingReady = fresh?.routingReady ?? c.config.routingMode === 'direct';
  const lines = summaryLines(draft, c.config, c.roles, {
    displayModel: c.displayModel, routingReady, searchStatus: s.searchStatus,
    checks: fresh ? checksLine(report) : c.changed ? 'not run · coding stays disabled until checks pass' : 'not run · current models kept',
  });
  for (const line of lines) screen.log(line);
  const changed = setupTabs.filter(tab => ['source', 'install', 'limits', 'routing', 'search'].includes(tab.id) && screen.markOf(tab.id) === 'changed').map(tab => tab.label);
  screen.log(changed.length ? `Changed: ${changed.join(', ')}.` : 'Nothing has changed yet. Use ←/→ to revisit any tab.');
  const choice = await screen.choose(draft.hasConfiguration ? 'Save these settings? The previous configuration is kept for rollback.' : 'Save these settings?', ['Save settings', 'Leave without saving'], 0);
  if (choice === 1) return await leave(s);
  if (c.changed) applyReports(c.config, c.roles, fresh?.reports ?? new Map());
  // Saving is never interrupted by a tab change.
  await screen.lock('Saving configuration...', () => persist(draft, c.config, c.env, screen, s.signal, s.credentials));
  return { end: { ready: Boolean(report?.ask && report.coding && routingReady), coding: Boolean(report?.coding) }, summary: lines };
}

async function leave(s: Session): Promise<TabResult> {
  const installing = s.queue?.pending.length;
  if (!await s.screen.confirm(`Leave without saving?${installing ? ' Unfinished downloads stop; Ollama resumes them next time.' : ''}`)) return 'save';
  return { end: undefined };
}
