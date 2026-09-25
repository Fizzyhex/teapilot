// Opt-in local quality observation. Uses an installed model; no downloads,
// cloud calls, user configuration changes, or arbitrary shell approvals.
import { mkdtemp, mkdir, readdir, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { loadConfig } from '../dist/config.js';
import { runHost } from '../dist/host.js';

const base = process.env.OLLAMA_TEST_URL ?? 'http://127.0.0.1:11434';
const model = process.env.TEAPILOT_TEST_MODEL;
if (!model) throw new Error('Set TEAPILOT_TEST_MODEL to an already installed, context-configured Ollama model.');
const scratch = await mkdtemp(join(tmpdir(), 'teapilot-ux-'));
const cwd = join(scratch, 'pong'); await mkdir(cwd);
const config = await loadConfig(scratch, {});
config.routingMode = 'direct'; config.stateDir = join(scratch, 'state');
config.models.fast.enabled = false;
Object.assign(config.models.capable, { enabled: true, id: model, provider: 'ollama', baseUrl: `${base}/v1`, contextTokens: 16384, maxOutputTokens: 2048, temperature: 0.2, reasoningEfforts: ['off'], reasoning: { type: 'reasoning_effort', values: { off: 'none' } } });
config.policy.budget.requestUsd = 0; config.policy.budget.dailyUsd = 0;
config.policy.limits.requestTimeoutMs = 120000;
config.secrets = { fast: undefined, capable: undefined };
let approvals = 0;
const start = performance.now();
console.log(`Disposable workspace: ${cwd}`);
const result = await runHost(config, {
  cwd, workload: 'coder', prompt: 'Create a basic web application for a Pong game, using Javascript/html/css.', signal: AbortSignal.timeout(300000),
}, {
  onProgress: console.log,
  onEvent: event => { if (event.type === 'tool_execution_end') console.log(`Tool: ${event.tool}${event.isError ? ' (failed)' : ''}`); },
  approve: async approval => {
    approvals++; console.log(`Approval requested: ${approval.kind}: ${approval.details}`);
    // Allow initialization of this disposable repository, or syntax-check one
    // repository-relative JS file. No shell operators or general execution.
    return approval.kind === 'shell' && (approval.details === 'git init' || /^node --check [a-zA-Z0-9_-]+\.js$/.test(approval.details ?? ''));
  },
});
const elapsedSeconds = Math.round((performance.now() - start) / 1000);
const files = await readdir(cwd);
const syntaxChecks = files.filter(file => file.endsWith('.js')).map(file => {
  const check = spawnSync(process.execPath, ['--check', join(cwd, file)], { encoding: 'utf8', windowsHide: true, timeout: 10000 });
  return { file, passed: check.status === 0, output: check.stderr };
});
const outcomes = (await readFile(join(config.stateDir, 'outcomes.jsonl'), 'utf8')).trim().split('\n').map(line => JSON.parse(line));
const inspectionCalls = outcomes.filter(event => event.type === 'repository_inventory' || (event.type === 'tool' && ['repo_list', 'repo_search'].includes(event.name))).length;
const report = { model, elapsedSeconds, approvals, inspectionCalls, files, syntaxChecks, result,
  acceptance: 'Host completion and JS syntax only; visual gameplay requires browser/human review.' };
await writeFile(join(scratch, 'report.json'), JSON.stringify(report, null, 2));
console.log(JSON.stringify(report, null, 2));
console.log(`Retained report and generated files: ${scratch}`);
if (!result.success || syntaxChecks.some(check => !check.passed)) process.exitCode = 2;
