#!/usr/bin/env node
// Runs a declarative challenge case against the simulated Discord and captures what it did.
//
//   node packages/teapilot/scripts/bench/challenge/case.mjs list
//   node packages/teapilot/scripts/bench/challenge/case.mjs show <case> [--json]
//   node packages/teapilot/scripts/bench/challenge/case.mjs run <case> --name <session> --out <dir>
//                              [--config-dir DIR] [--reps N] [--label L] [--seed S] [--dry-run]
//                              [--keep-going] [--only 1,3] [--timeout S] [--step-timeout S]
//
// A case is prose plus steps. `say`/`slash`/`click`/`select`/`submit`/`advance`/`restart` are the actions
// the driver takes; `expect` names checks from checks.mjs and `judged` stays prose for the agent to score.
// Control ids are looked up by label or id from the live dump, so a case does not rot as m4 becomes m9.
// Every interaction is appended to interactions.jsonl, which evidence.mjs then captures with the session.
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { connect } from 'node:net';
import { join, resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { require as requireTs } from 'tsx/cjs/api';

import { call, capture, sessionDir } from './evidence.mjs';
import { names as checkNames, run as runChecks } from './checks.mjs';
import { validators } from './validation.mjs';

const here = resolve(import.meta.dirname);
export const caseDir = join(here, 'cases');

/**
 * Every case file, by id: the challenge cases, then the tooling fixtures. Fixtures live beside them
 * rather than in `cases/` so a report that walks one directory scores challenges only.
 */
export function loadCases({ fixtures = true, directory = caseDir, fixtureDirectory = join(here, 'fixtures') } = {}) {
  const directories = fixtures ? [directory, fixtureDirectory] : [directory];
  const cases = Object.create(null);
  const sources = new Map();
  for (const directory of directories.filter(existsSync)) {
    for (const file of readdirSync(directory).filter(file => file.endsWith('.ts') && !file.endsWith('.d.ts')).sort()) {
      const source = resolve(directory, file);
      let value;
      try { value = requireTs(source, import.meta.url).default; }
      catch (error) { throw new Error(`could not load case ${source}: ${error.message}`, { cause: error }); }
      if (!value || typeof value !== 'object' || Array.isArray(value) ||
          typeof value.id !== 'string' || !value.id.trim() || !Array.isArray(value.steps) || !value.steps.length) {
        throw new Error(`invalid case ${source}: default export must have a non-empty id and steps`);
      }
      if (value.expect !== undefined && !Array.isArray(value.expect)) throw new Error(`invalid case ${source}: expect must be an array`);
      for (const entry of value.expect ?? []) {
        const check = typeof entry === 'string' ? entry : entry?.check;
        if (!checkNames.includes(check)) throw new Error(`invalid case ${source}: unknown check ${check}`);
      }
      if (sources.has(value.id)) throw new Error(`duplicate case id ${value.id}: ${sources.get(value.id)} and ${source}`);
      sources.set(value.id, source);
      cases[value.id] = value;
    }
  }
  return cases;
}

/**
 * The live dump, as data, for resolving controls and app ids. Returns the whole payload, so callers
 * read `dump(name).snapshot.messages` and `dump(name).apps`.
 */
const dump = name => {
  const { text } = call(name, ['dump', name], { allowFailure: true });
  try {
    const value = JSON.parse(text);
    return value?.snapshot ? value : { snapshot: { messages: [], warnings: [], forms: [] }, apps: [] };
  } catch { return { snapshot: { messages: [], warnings: [], forms: [] }, apps: [] }; }
};

/**
 * A case's mechanical expectations, run over the evidence just captured. `controlsAreValid` gets the
 * simulator's own checks so the payload is re-validated here rather than trusted from the session.
 */
export async function scoreOut(evidenceDir, value) {
  const wanted = (value?.expect ?? []).map(entry => (typeof entry === 'string' ? entry : entry.check)).filter(name => checkNames.includes(name));
  if (!wanted.length) return [];
  const validate = wanted.includes('controlsAreValid') ? validators() : undefined;
  return runChecks(evidenceDir, wanted, {
    options: Object.fromEntries((value.expect ?? []).map(entry => {
      const { check, options } = typeof entry === 'string' ? { check: entry } : entry;
      return [check, check === 'controlsAreValid' ? { ...options, validate } : options];
    })),
  });
}

/** Finds a control by label, id, emoji or custom id, on the newest message that carries it. */
/** A control on the live dump, by id, label, emoji or custom id. Takes the snapshot itself. */
export function findControl(snapshot, wanted, messageHint) {
  const messages = snapshot?.messages ?? [];
  const chosen = messageHint ? messages.filter(message => message.id === messageHint) : messages;
  for (const message of [...chosen].reverse()) {
    for (const control of message.controls ?? []) {
      if (control.id === wanted || control.customId === wanted) return { message: message.id, control };
      if (control.label && control.label === wanted) return { message: message.id, control };
      if (control.emoji?.name && control.emoji.name === wanted) return { message: message.id, control };
    }
  }
  return undefined;
}

const write = (path, data) => { mkdirSync(join(path, '..'), { recursive: true }); writeFileSync(path, data); };

/**
 * One case, one repetition. Returns { manifest, checks, judged, steps, outcome }.
 * `outcome` is `complete`, `blocked` or `invalid`: a run that could not be scored must say so rather
 * than report a total, which is the discipline the benchmark specs ask for.
 */
export async function runCase(value, options) {
  const {
    name, out, configDir, label, seed, fixture, trace = true, dryRun = false, keepGoing = false,
    only, timeout = 900, stepTimeout = 600, root, frozen = true,
  } = options;
  const startedAt = new Date().toISOString();
  const steps = value.steps.filter((_, index) => !only || only.includes(index + 1));
  if (dryRun) {
    for (const [index, step] of steps.entries()) console.log(`  step ${index + 1}/${steps.length} (dry run): ${JSON.stringify(step)}`);
    return { outcome: 'complete', manifest: null, checks: [], judged: value.judged ?? [], steps: steps.length, failed: [], unscored: [], blocked: null };
  }
  const interactions = [];
  if (!dryRun) {
    const start = ['start', '--name', name, '--frozen'];
    if (configDir) start.push('--config-dir', configDir);
    if (fixture) start.push('--fixture', fixture, ...(value.fixtureName ? ['--fixture-name', value.fixtureName] : []), ...(value.fixtureDescription ? ['--fixture-description', value.fixtureDescription] : []));
    if (root) start.push('--root', root);
    if (trace) start.push('--trace');
    if (value.scratchpad) start.push('--scratchpad', value.scratchpad);
    if (value.compactHistory) start.push('--compact-history');
    if (value.historyTokens) start.push('--history-tokens', String(value.historyTokens));
    if (value.forceRetry) start.push('--force-retry', value.forceRetry);
    call(name, start);
  }

  let outcome = 'complete';
  let blockedReason = null;
  const blocked = why => { outcome = 'blocked'; blockedReason = why; };
  // What each `record: true` step saw, so a check can be told what came before it without a human
  // transcribing ids: the apps alive before a restart, and the first trace file after a clear.
  const stages = [];
  let cleared = 0;
  try {
    for (const [index, step] of steps.entries()) {
      const at = new Date().toISOString();
      // The action is the step's own key; `note` and `record` are annotations, not something to press.
      const action = ['say', 'slash', 'click', 'select', 'submit', 'approve', 'advance', 'restart', 'sleep', 'inspect'].find(key => key in step) ?? 'inspect';
      const record = { step: index + 1, at, action, note: step.note ?? null };
      try {
        record.result = await perform(name, step, { timeout, stepTimeout });
      } catch (error) {
        record.error = error.message;
        blocked(`step ${index + 1} (${record.action}) failed: ${error.message}`);
        interactions.push({ ...record });
        if (!keepGoing) break;
      }
      // Apps and trace files recorded as they stand, so a later stage can be compared against them.
      if (step.record) {
        const snapshot = dump(name);
        const seen = traceFiles(name);
        record.recorded = {
          apps: snapshot.apps.map(app => ({ id: app.id, title: app.title, status: app.status, messageId: app.messageId })),
          trace: seen, clear: cleared,
          // The first model call written since the conversation was cleared, if this stage followed one.
          firstAfterClear: cleared ? seen.find(file => seen.indexOf(file) >= cleared) ?? null : null,
        };
        stages.push(record.recorded);
      }
      if (step.slash !== undefined && /\/convo clear\b/.test(step.slash)) cleared = traceFiles(name).length;
      interactions.push(record);
      write(join(out, 'stages.jsonl'), `${interactions.map(entry => JSON.stringify(entry)).join('\n')}\n`);
      console.log(`  step ${index + 1}/${steps.length} ${record.action}${record.error ? ' ✗' : ''}${step.note ? ` — ${step.note}` : ''}`);
    }
  } finally {
    if (!dryRun) {
      write(join(out, 'interactions.jsonl'), interactions.map(entry => JSON.stringify(entry)).join('\n') + '\n');
      if (value.capture !== false && !outcome.startsWith('skipped')) {
        try { capture(name, out, { caseId: value.id, label, seed, fixture, startedAt, interactions, notes: outcome === 'complete' ? undefined : blockedReason }); }
        catch (error) { console.error(`  capture failed: ${error.message}`); }
      }
    }
  }

  // Scored against whatever was captured: a run that could not be captured reports unscored, not passed.
  // The stages recorded along the way supply the "before" that survival and history checks need.
  const results = await scoreOut(out, withStageContext(value, stages));
  return {
    outcome, manifest: existsSync(join(out, 'manifest.json')) ? JSON.parse(readFileSync(join(out, 'manifest.json'), 'utf8')) : null,
    checks: results, judged: value.judged ?? [], steps: interactions.length,
    failed: results.filter(result => result.pass === false).map(result => result.name),
    unscored: results.filter(result => result.pass === null).map(result => `${result.name}: ${result.detail}`),
    blocked: blockedReason,
  };
}

/**
 * Fills in the options a case does not have to write down. `appSurvivesRestart` gets the app ids that
 * were alive at the last stage before a restart, and `historyLacksOldTurns` the first trace file written
 * after a `/convo clear`, which is the call being judged. Anything the case states itself wins.
 */
function withStageContext(value, stages) {
  if (!stages.length) return value;
  const restart = value.steps.findIndex(step => step.restart !== undefined);
  const before = (restart === -1 ? stages : stages.slice(0, restart)).at(-1);
  const afterClear = stages.findLast(stage => stage.firstAfterClear);
  return { ...value, expect: (value.expect ?? []).map(entry => {
    const { check, options } = typeof entry === 'string' ? { check: entry, options: undefined } : entry;
    if (check === 'appSurvivesRestart' && !options?.before && before) return { check, options: { ...options, before: before.apps.map(app => app.id) } };
    if (check === 'historyLacksOldTurns' && !options?.after && afterClear) return { check, options: { ...options, after: afterClear.firstAfterClear } };
    return entry;
  }) };
}

/** The trace files written so far, so a stage can pin the first call after it for historyLacksOldTurns. */
const traceFiles = name => {
  const dir = join(sessionDir(name), 'trace');
  return existsSync(dir) ? readdirSync(dir).filter(file => file.endsWith('.json')).sort() : [];
};

/** One action, with control resolution and the bounded waits a real turn needs. */
async function perform(name, step, { timeout, stepTimeout }) {
  if (step.say !== undefined) {
    const args = ['say', name, step.say, '--as', step.as ?? 'op'];
    for (const file of step.attach ?? []) args.push('--attach', file);
    if (step.in) args.push('--in', step.in);
    const sent = call(name, args).text;
    return { sent: sent.trim(), ...(step.wait === false ? {} : { waited: await waitTurn(name, timeout) }) };
  }
  if (step.slash !== undefined) {
    const args = ['slash', name, step.slash, '--as', step.as ?? 'op'];
    if (step.choose !== undefined) args.push('--choose', String(step.choose));
    if (step.oneShot) args.push('--one-shot');
    if (step.in) args.push('--in', step.in);
    const replied = call(name, args);
    return { replied: replied.text.trim(), ...(step.wait === true ? { waited: await waitTurn(name, timeout) } : {}) };
  }
  if (step.click !== undefined) {
    const { message, control, guessed } = locate(name, step);
    const result = call(name, ['click', name, message, control.id, '--as', step.as ?? 'op']);
    if (step.wait === true) await waitTurn(name, timeout);
    return { message, control, guessed: guessed ?? false, result: result.text.trim(), ok: result.ok };
  }
  if (step.select !== undefined) {
    const { message, control, guessed } = locate(name, step);
    const values = step.select.values;
    const result = call(name, ['select', name, message, control.id, ...values, '--as', step.as ?? 'op']);
    return { message, control, guessed: guessed ?? false, result: result.text.trim(), ok: result.ok };
  }
  if (step.submit !== undefined) {
    const result = call(name, ['submit', name, ...Object.entries(step.submit).flatMap(([field, value]) => ['--field', `${field}=${value}`]), '--as', step.as ?? 'op'], { allowFailure: true });
    return { result: result.text.trim(), ok: result.ok };
  }
  if (step.approve !== undefined) return { result: call(name, ['approve', name, ...(step.approve === false ? ['--deny'] : []), '--as', step.as ?? 'op'], { allowFailure: true }).text.trim() };
  if (step.advance !== undefined) return { result: call(name, ['advance', name, step.advance]).text.trim() };
  if (step.restart !== undefined) return { result: call(name, ['restart', name]).text.trim() };
  if (step.sleep !== undefined) { execFileSync(process.execPath, ['-e', `setTimeout(() => {}, ${Number(step.sleep)})`]); return { slept: step.sleep }; }
  if (step.inspect !== undefined) return { screen: call(name, ['screen', name], { allowFailure: true }).text };
  return { skipped: 'no action in this step' };
}

/** Resolves a control reference to the ids `click`/`select` take, at the moment of use. */
function locate(name, step) {
  const snapshot = dump(name);
  const wanted = step.click ?? step.select.control;
  const found = findControl(snapshot.snapshot, wanted, step.message);
  const recent = (snapshot.snapshot.messages ?? []).slice(-3)
    .map(message => `${message.id} (${message.author}): ${(message.controls ?? []).map(control => control.id).join(', ') || 'no controls'}`).join(' | ');
  if (!found) throw new Error(`no control "${wanted}" on screen. Recent: ${recent || 'nothing has happened yet'}`);
  return found;
}

/** One open socket awaits the daemon's event subscription. No sleeping or timed polling. */
export function waitTurn(name, timeout = 900) {
  const socketPath = process.platform === 'win32'
    ? `\\\\.\\pipe\\teapilot-discord-${name}` : join(sessionDir(name), 'socket');
  return new Promise((resolve, reject) => {
    const socket = connect(socketPath);
    let data = '';
    socket.setEncoding('utf8');
    socket.on('connect', () => socket.write(`${JSON.stringify({ op: 'wait-turn', timeout })}\n`));
    socket.on('data', chunk => { data += chunk; });
    socket.on('error', reject);
    socket.on('end', () => {
      try {
        const result = JSON.parse(data);
        if (result.event === 'turn_end' && result.status === 'completed') return resolve(result);
        reject(new Error(result.event === 'approval'
          ? `approval needs operator review: ${result.text}`
          : `turn did not complete: ${result.status ?? result.event ?? result.error}`));
      } catch (error) { reject(error); }
    });
  });
}

const usage = `Usage: node scripts/bench/challenge/case.mjs <command>

  list                            every case, with its steps and expectations
  show <case> [--json]            one case in full
  run <case> --name N --out DIR   run it against the simulator and capture the evidence

Options: --config-dir DIR  --reps N  --label L  --seed S  --fixture FILE  --root DIR
         --only 1,3  --keep-going  --dry-run  --timeout S  --step-timeout S`;

if (process.argv[1] && resolve(process.argv[1]) === resolve(import.meta.filename)) {
  const [command, ...rest] = process.argv.slice(2);
  const { values, positionals } = parseArgs({ args: rest, allowPositionals: true, options: {
    name: { type: 'string' }, out: { type: 'string' }, 'config-dir': { type: 'string' }, reps: { type: 'string', default: '1' },
    label: { type: 'string' }, seed: { type: 'string' }, fixture: { type: 'string' }, root: { type: 'string' },
    only: { type: 'string' }, 'keep-going': { type: 'boolean', default: false }, 'dry-run': { type: 'boolean', default: false },
    timeout: { type: 'string', default: '900' }, 'step-timeout': { type: 'string', default: '600' }, json: { type: 'boolean', default: false },
  } });
  const only = values.only ? values.only.split(',').map(Number) : undefined;
  try {
    const cases = loadCases();
    if (command === 'list') {
      for (const [id, value] of Object.entries(cases)) {
        console.log(`${id}  ${value.tags?.join(' ') ?? ''}`);
        console.log(`  ${value.title ?? value.summary ?? ''}`);
        console.log(`  ${value.steps.length} step(s); expects ${(value.expect ?? []).map(entry => typeof entry === 'string' ? entry : entry.check).join(', ') || 'nothing mechanical'}; ${(value.judged ?? []).length} judged by hand`);
      }
    } else if (command === 'show') {
      const value = cases[positionals[0]];
      if (!value) throw new Error(`No case ${positionals[0]}. Try list.`);
      console.log(values.json ? JSON.stringify(value, null, 2) : `${value.id}\n\n${value.prose ?? value.summary ?? ''}\n\n${JSON.stringify(value.steps, null, 2)}`);
    } else if (command === 'run') {
      const value = cases[positionals[0]];
      if (!value) throw new Error(`No case ${positionals[0]}. Try list.`);
      const reps = Math.max(1, Number(values.reps) || 1);
      for (let rep = 1; rep <= reps; rep++) {
        const name = `${values.name}-r${rep}`;
        const out = values.reps && reps > 1 ? join(values.out, `rep-${rep}`) : values.out;
        if (!values['dry-run']) mkdirSync(out, { recursive: true });
        console.log(`\n== ${value.id} ${rep}/${reps} (${name})`);
        const result = await runCase(value, { ...values, name, out, only, configDir: values['config-dir'], timeout: Number(values.timeout), stepTimeout: Number(values['step-timeout']), keepGoing: values['keep-going'], dryRun: values['dry-run'], root: values.root });
        for (const check of result.checks) console.log(`  ${check.pass === null ? '?' : check.pass ? '✓' : '✗'} ${check.name}${check.severity === 'info' ? ' (info)' : ''}: ${check.detail}`);
        if (result.unscored.length) console.log(`  unscored: ${result.unscored.join('; ')}`);
        if (result.judged.length) console.log(`  judged by hand: ${result.judged.join('; ')}`);
        console.log(`  outcome: ${result.outcome}${result.failed.length ? ` — failed: ${result.failed.join(', ')}` : ''}${result.blocked ? ` — ${result.blocked}` : ''}`);
        if (!values['dry-run']) {
          try { call(name, ['stop', name], { allowFailure: true }); } catch { /* already gone */ }
        }
      }
    } else console.log(usage);
  } catch (error) { console.error(`case: ${error.message}`); process.exitCode = 1; }
}
