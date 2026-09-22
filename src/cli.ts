import { parseArgs } from 'node:util';
import { createInterface } from 'node:readline/promises';
import { realpath } from 'node:fs/promises';
import { resolve } from 'node:path';
import { loadConfig, tiers, type Config } from './config.js';
import { runHost } from './host.js';
import { callCeiling } from './inference/budget.js';
import { localAvailable } from './inference/providers.js';
import type { Approve } from './execution/policy.js';

const help = `teapilot — JevRouter + pi agent host

npm start -- --cwd <repository> "Your request"
npm start -- --web "Research a topic with sources"
npm start -- --correction "The previous change missed X" "Fix X"
npm run doctor

Options: --cwd PATH  --config-dir PATH  --prompt TEXT  --web  --json
         --correction TEXT  --help
No prompt opens a single-request prompt. Approvals require an interactive terminal.
Exit codes: 0 completed/doctor healthy; 1 configuration/runtime error; 2 incomplete/blocked.
`;

async function doctor(config: Config, cwd: string): Promise<boolean> {
  const [major = 0, minor = 0] = process.versions.node.split('.').map(Number);
  const runtime = major > 22 || (major === 22 && minor >= 19);
  const local = await localAvailable(config);
  const credentials = Boolean(config.router.apiKey);
  console.log(`Node ${process.versions.node}: ${runtime ? 'OK' : 'requires >=22.19.0'}`);
  console.log(`Working directory: ${await realpath(cwd)}`);
  console.log(`JevRouter ${config.router.provider}: ${credentials ? 'credential configured (not live-tested)' : 'MISSING credential'}`);
  for (const tier of tiers) {
    const model = config.models[tier];
    const status = !model.enabled ? 'disabled' : tier === 'local' ? local ? 'reachable' : 'UNREACHABLE /models' : config.secrets[tier] ? 'configured (not live-tested)' : 'MISSING credential';
    console.log(`${tier}: ${status}; ${model.id}; maximum $${callCeiling(model).toFixed(6)}/turn`);
  }
  console.log(`Budgets: $${config.policy.budget.requestUsd}/request; $${config.policy.budget.dailyUsd}/UTC day; state: ${config.stateDir}`);
  console.log(`Shell: ${process.platform === 'win32' ? 'PowerShell' : 'bash'}; arbitrary commands require approval; trusted commands: ${config.policy.execution.trustedCommands.length}`);
  console.log(`Search: ${config.searchUrl ? 'configured; opt in with --web' : 'disabled'}`);
  return runtime && credentials && (local || tiers.some(tier => tier !== 'local' && config.models[tier].enabled && config.secrets[tier]));
}

async function main(): Promise<void> {
  const { values, positionals } = parseArgs({ allowPositionals: true, options: {
    cwd: { type: 'string', default: process.cwd() }, 'config-dir': { type: 'string', default: process.cwd() },
    prompt: { type: 'string' }, correction: { type: 'string' }, web: { type: 'boolean' }, json: { type: 'boolean' }, help: { type: 'boolean', short: 'h' },
  } });
  if (values.help) { console.log(help); return; }
  const config = await loadConfig(resolve(values['config-dir']));
  if (positionals[0] === 'doctor') { process.exitCode = await doctor(config, values.cwd) ? 0 : 1; return; }
  const interactive = Boolean(process.stdin.isTTY && process.stderr.isTTY);
  const terminal = interactive ? createInterface({ input: process.stdin, output: process.stderr }) : undefined;
  const controller = new AbortController();
  const onInterrupt = () => { controller.abort(); terminal?.close(); };
  process.once('SIGINT', onInterrupt);
  terminal?.on('SIGINT', onInterrupt);
  const approve: Approve = async approval => {
    if (!terminal || controller.signal.aborted) return false;
    const secrets = [config.router.apiKey, ...Object.values(config.secrets)].filter((value): value is string => Boolean(value));
    let description = `\n${approval.summary}\n${approval.details ?? ''}`;
    for (const secret of secrets) description = description.split(secret).join('[REDACTED]');
    console.error(description);
    const signal = approval.signal ? AbortSignal.any([approval.signal, controller.signal]) : controller.signal;
    try { return (await terminal.question('Type yes to approve this action: ', { signal })).trim().toLowerCase() === 'yes'; }
    catch { return false; }
  };
  try {
    const prompt = values.prompt ?? (positionals.length ? positionals.join(' ') : terminal ? await terminal.question('teapilot> ', { signal: controller.signal }) : '');
    if (!prompt.trim()) throw new Error('Supply a prompt; use --help for examples');
    const result = await runHost(config, { prompt, cwd: values.cwd, web: values.web, correction: values.correction, signal: controller.signal }, { approve, onProgress: message => console.error(message) });
    console.log(values.json ? JSON.stringify(result, null, 2) : result.text);
    if (!values.json) console.error(`\n${result.status}; accounted $${result.spentUsd.toFixed(6)}; request ${result.requestId}\nReceipts: ${result.receipts.join(', ')}`);
    process.exitCode = result.success ? 0 : 2;
  } finally { terminal?.close(); process.removeListener('SIGINT', onInterrupt); }
}

main().catch(error => {
  // Zod errors contain configuration values; only expose the safe validation path.
  if (error && typeof error === 'object' && 'issues' in error) console.error('Invalid configuration. Check model rates, endpoint URLs, and policy field types.');
  else console.error(error instanceof Error ? error.message : 'teapilot failed');
  process.exitCode = 1;
});
