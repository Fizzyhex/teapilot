#!/usr/bin/env node
// Scores and compares captured runs, and guards a batch against tuning that only works for one case.
//
//   node packages/teapilot/scripts/bench/challenge/report.mjs score --dir <evidence> [--json]
//   node packages/teapilot/scripts/bench/challenge/report.mjs batch --out <batch dir> [--label baseline|tuned]
//   node packages/teapilot/scripts/bench/challenge/report.mjs compare --before <dir> --after <dir>
//   node packages/teapilot/scripts/bench/challenge/report.mjs cheat-check --before <dir> --after <dir>
//
// `batch` reads every capture in a directory and writes batch.json plus a markdown table. `compare`
// refuses to claim an improvement unless both batches ran against a frozen revision, and says which
// dimensions have no machine verdict so they are not silently averaged in. `cheat-check` greps the diff
// between two batches for fixture names, seeds and challenge strings.
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { parseArgs } from 'node:util';

import { loadCases, caseDir } from './case.mjs';
import { names as checkNames, run as runChecks } from './checks.mjs';
import { validators } from './validation.mjs';

const json = (path, fallback) => { try { return JSON.parse(readFileSync(path, 'utf8')); } catch { return fallback; } };
const write = (path, data) => writeFileSync(path, typeof data === 'string' ? data : `${JSON.stringify(data, null, 2)}\n`, 'utf8');
const repoRoot = resolve(import.meta.dirname, '..', '..', '..', '..');

/** Every capture under a directory, whether it is one run or a batch of repetitions. */
export function captures(dir, found = []) {
  const directory = resolve(dir);
  if (!existsSync(directory)) return found;
  if (existsSync(join(directory, 'manifest.json'))) found.push(directory);
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    if (entry.isDirectory() && entry.name !== 'git' && entry.name !== 'apps' && entry.name !== 'trace' && entry.name !== 'files') captures(join(directory, entry.name), found);
  }
  return found;
}

/** One capture, scored: its machine verdicts, its manifest, and what only an agent can judge. */
export function score(dir, { options = {}, value } = {}) {
  const evidence = resolve(dir);
  const manifest = json(join(evidence, 'manifest.json'), {});
  value ??= loadCases()[manifest.case];
  const requested = value?.expect?.map(entry => (typeof entry === 'string' ? entry : entry.check)).filter(name => checkNames.includes(name)) ?? [];
  const results = requested.length
    ? runChecks(evidence, requested, { options: Object.fromEntries((value?.expect ?? []).map(entry => {
      const { check, options: configured } = typeof entry === 'string' ? { check: entry } : entry;
      return [check, { ...configured, ...options[check], ...(check === 'controlsAreValid' ? { validate: validators() } : {}) }];
    })) })
    : [];
  const failures = results.filter(result => result.pass === false);
  return {
    dir: evidence, case: manifest.case, label: manifest.label, revision: manifest.revision?.trim().split('\n')[0], patchSha256: manifest.patchSha256,
    models: manifest.models, apps: manifest.apps?.length ?? 0, warnings: manifest.warnings ?? 0, requests: manifest.requests ?? 0,
    checks: results, failed: failures.map(failure => failure.name), passed: results.filter(result => result.pass === true).length,
    unscored: results.filter(result => result.pass === null).map(result => `${result.name}: ${result.detail}`),
    judged: value?.judged ?? [], outcome: manifest.notes ? 'blocked' : 'complete',
  };
}

const row = entry => `| ${entry.case ?? '—'} | ${entry.label ?? '—'} | ${entry.passed} | ${entry.failed.length ? `✗ ${entry.failed.join(', ')}` : '✓'} | ${entry.unscored.length ? entry.unscored.length : '0'} | ${entry.warnings} | ${entry.requests} | ${entry.apps} | ${entry.revision?.slice(0, 8) ?? '—'} |`;
const table = entries => ['| case | label | passed | failures | unscored | rejections | requests | apps | revision |', '| --- | --- | ---: | --- | ---: | ---: | ---: | ---: | --- |', ...entries.map(row)].join('\n');

/** A batch: every capture in a directory, scored and summarised. */
export function batch(dir, { label } = {}) {
  const cases = loadCases();
  const entries = captures(dir).map(evidence => score(evidence, { value: cases[json(join(evidence, 'manifest.json'), {}).case] }));
  const revision = [...new Set(entries.map(entry => entry.revision))];
  const patches = [...new Set(entries.map(entry => entry.patchSha256))];
  const summary = {
    label: label ?? null, dir: resolve(dir), runs: entries.length,
    revision, frozen: revision.length === 1, patchSha256: patches, frozenPatch: patches.length === 1,
    cases: [...new Set(entries.map(entry => entry.case))], entries,
    failures: [...new Set(entries.flatMap(entry => entry.failed))],
    unscored: [...new Set(entries.flatMap(entry => entry.unscored))],
    models: [...new Set(entries.flatMap(entry => entry.models ?? []))],
  };
  write(join(resolve(dir), 'batch.json'), summary);
  write(join(resolve(dir), 'batch.md'), `# ${label ?? 'batch'} — ${new Date().toISOString().slice(0, 10)}\n\n${table(entries)}\n\n${
    summary.frozen ? `frozen at revision ${revision[0]?.slice(0, 12)}` : `NOT frozen: ${revision.length} revisions in this batch`
  }${summary.frozenPatch ? '' : '; NOT frozen: the patch changed between runs'}.\n\n${
    summary.unscored.length ? `Unscored, so not counted either way:\n${summary.unscored.map(entry => `- ${entry}`).join('\n')}\n\n` : ''
  }${
    summary.failures.length ? `Failed:\n${summary.failures.map(entry => `- ${entry}`).join('\n')}` : 'No mechanical failures.'
  }\n\nScored from captures only. Dimensions a case leaves to \`judged\` need an agent's reading of the evidence directory named in the table.\n`);
  return summary;
}

/** Before and after, with the honesty rules the reports ask for. */
export function compare(beforeDir, afterDir) {
  const before = json(join(resolve(beforeDir), 'batch.json')) ?? batch(beforeDir, { label: 'before' });
  const after = json(join(resolve(afterDir), 'batch.json')) ?? batch(afterDir, { label: 'after' });
  const rate = (summary, name) => {
    const withCheck = summary.entries.map(entry => entry.checks.find(check => check.name === name)).filter(Boolean);
    return withCheck.length ? `${withCheck.filter(check => check.pass === true).length}/${withCheck.length}` : 'not run';
  };
  const allChecks = [...new Set([...before.failures, ...after.failures, ...checkNames])];
  const rows = allChecks.map(name => ({ name, before: rate(before, name), after: rate(after, name) }));
  const caveats = [];
  if (!before.frozen || !after.frozen) caveats.push('a batch ran against more than one revision, so it is not frozen');
  if (!before.frozenPatch || !after.frozenPatch) caveats.push('a batch ran against more than one working-tree patch, so its implementation is not frozen');
  if (before.runs !== after.runs) caveats.push(`unequal batch sizes (${before.runs} vs ${after.runs}): no aggregate improvement can be claimed`);
  if (before.models.join() !== after.models.join()) caveats.push(`different models (${before.models.join(', ')} vs ${after.models.join(', ')})`);
  if (before.cases.join() !== after.cases.join()) caveats.push(`different cases (${before.cases.join(', ')} vs ${after.cases.join(', ')})`);
  const report = { before, after, checks: rows, caveats, comparable: caveats.length === 0, verdict: caveats.length ? 'not comparable as an aggregate' : 'same case, frozen implementation and profile' };
  write(join(resolve(afterDir), 'comparison.md'), `# before / after\n\n${table(before.entries)}\n\n${table(after.entries)}\n\n${
    caveats.length ? `**Not comparable.** ${caveats.join('; ')}.\n` : 'Both batches are frozen and comparable as smoke evidence, not as statistical proof.\n'
  }\n\n| check | before | after |\n| --- | --- | --- |\n${rows.map(row => `| ${row.name} | ${row.before} | ${row.after} |`).join('\n')}\n`);
  return report;
}

/** Fixture names, seeds and challenge strings must not appear in the implementation between batches. */
export function cheatCheck(beforeDir, afterDir) {
  const before = json(join(resolve(beforeDir), 'batch.json'));
  const after = json(join(resolve(afterDir), 'batch.json'));
  const diff = (() => {
    try { return execFileSync('git', ['-C', repoRoot, 'diff'], { encoding: 'utf8', maxBuffer: 32 * 1024 * 1024 }); }
    catch { return ''; }
  })();
  const added = diff.split('\n').filter(line => line.startsWith('+') && !line.startsWith('+++')).map(line => line.slice(1)).join('\n');
  const manifests = [...captures(beforeDir), ...captures(afterDir)].map(dir => json(join(dir, 'manifest.json'), {}));
  const needles = [...new Set([
    ...manifests.map(manifest => manifest.fixture).filter(Boolean),
    ...manifests.map(manifest => manifest.seed).filter(Boolean),
    ...[...Object.values(loadCases())].flatMap(value => [value.id, value.fixtureName, ...(value.judged ?? []).map(entry => entry.needle)].filter(Boolean)),
  ])];
  const hits = needles.filter(needle => added.includes(String(needle)));
  return { patchChanged: before?.patchSha256?.join() !== after?.patchSha256?.join(), needles: needles.length, hits, clean: hits.length === 0, note: 'Checked the working-tree diff only; a committed change needs its own batch.' };
}

const usage = `Usage: node scripts/bench/challenge/report.mjs <command>

  score --dir <evidence>            one capture, scored
  batch --out <dir> [--label L]    every capture in a directory, scored into batch.json and batch.md
  compare --before <dir> --after <dir>   the before/after table, with comparability caveats
  cheat-check --before <dir> --after <dir>   challenge data found in the implementation diff`;

if (process.argv[1] && resolve(process.argv[1]) === resolve(import.meta.filename)) {
  const [command, ...rest] = process.argv.slice(2);
  const { values } = parseArgs({ args: rest, options: {
    dir: { type: 'string' }, out: { type: 'string' }, before: { type: 'string' }, after: { type: 'string' },
    label: { type: 'string' }, json: { type: 'boolean', default: false },
  } });
  try {
    let result;
    if (command === 'score') result = score(values.dir);
    else if (command === 'batch') result = batch(values.out ?? values.dir, { label: values.label });
    else if (command === 'compare') result = compare(values.before, values.after);
    else if (command === 'cheat-check') result = cheatCheck(values.before, values.after);
    else { console.log(usage); process.exit(0); }
    if (command === 'batch' && !values.json) { console.log(readFileSync(join(resolve(values.out ?? values.dir), 'batch.md'), 'utf8')); }
    else console.log(JSON.stringify(result, null, 2));
  } catch (error) { console.error(`report: ${error.message}`); process.exitCode = 1; }
}
