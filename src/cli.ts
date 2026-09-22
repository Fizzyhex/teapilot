#!/usr/bin/env node
import { parseArgs } from 'node:util';
import { resolve } from 'node:path';
import { loadConfig, type Workload } from './config.js';
import { runHost } from './host.js';
import { doctor } from './diagnostics.js';
import { setup } from './setup/index.js';
import { terminalUI } from './setup/terminal.js';
import type { Approve } from './execution/policy.js';

const help = `teapilot — local and hosted personal agent

teapilot setup
teapilot ask "Explain dependency injection"
teapilot code --cwd <repository> "Fix the failing tests"
teapilot doctor [--live]

Options: --cwd PATH  --config-dir PATH  --prompt TEXT  --web  --json
         --correction TEXT  --help
Hosted routing also accepts a bare prompt. Direct routing uses ask/code.
Approvals require an interactive terminal. Local setup needs no API key.

Unattended setup (existing local endpoint, new config only):
teapilot setup --non-interactive --endpoint URL --model ID --context-tokens N
Credentials are accepted through LOCAL_API_KEY, never a command-line flag.

Exit codes: 0 completed/healthy; 1 configuration/runtime error; 2 incomplete/blocked.
`;

async function main(): Promise<void> {
  const { values, positionals } = parseArgs({ allowPositionals: true, options: {
    cwd: { type: 'string', default: process.cwd() }, 'config-dir': { type: 'string' },
    prompt: { type: 'string' }, correction: { type: 'string' }, web: { type: 'boolean' }, json: { type: 'boolean' }, help: { type: 'boolean', short: 'h' },
    live: { type: 'boolean' }, 'non-interactive': { type: 'boolean' }, endpoint: { type: 'string' }, model: { type: 'string' }, 'context-tokens': { type: 'string' },
  } });
  if (values.help) { console.log(help); return; }
  const [major = 0, minor = 0] = process.versions.node.split('.').map(Number);
  if (major < 22 || (major === 22 && minor < 19)) throw new Error('TeaPilot requires Node >=22.19.0.');
  const command = ['setup', 'doctor', 'ask', 'code'].includes(positionals[0] ?? '') ? positionals.shift() : undefined;
  if (command !== 'setup' && [values['non-interactive'], values.endpoint, values.model, values['context-tokens']].some(value => value !== undefined)) throw new Error('Endpoint/model and unattended setup options require the setup command.');
  if (values.live && command !== 'doctor') throw new Error('--live requires the doctor command.');
  const interactive = Boolean(process.stdin.isTTY && process.stderr.isTTY);
  const controller = new AbortController();
  const ui = interactive ? terminalUI(controller.signal) : undefined;
  const onInterrupt = () => { controller.abort(); ui?.close(); };
  process.once('SIGINT', onInterrupt);
  try {
    if (command === 'setup') {
      if (!interactive && !values['non-interactive']) throw new Error('Setup needs an interactive terminal, or --non-interactive with an existing endpoint.');
      const headless = {
        log: (text: string) => console.error(text),
        input: async (): Promise<string> => { throw new Error('Unattended setup requires --endpoint, --model, and --context-tokens.'); },
        choose: async (): Promise<number> => { throw new Error('This setup choice requires an interactive terminal.'); },
        confirm: async () => false,
      };
      const ready = await setup({ directory: values['config-dir'], nonInteractive: values['non-interactive'], endpoint: values.endpoint, model: values.model, contextTokens: values['context-tokens'] === undefined ? undefined : Number(values['context-tokens']) }, ui ?? headless, controller.signal);
      process.exitCode = ready ? 0 : 2;
      return;
    }
    const config = await loadConfig(values['config-dir'], { ...process.env });
    const secrets = [config.router.apiKey, ...Object.values(config.secrets)].filter((value): value is string => Boolean(value));
    const redact = (message: string) => secrets.reduce((text, secret) => text.split(secret).join('[REDACTED]'), message);
    const approve: Approve = async approval => {
      if (!ui || controller.signal.aborted || approval.signal?.aborted) return false;
      console.error(redact(`${approval.summary}\n${approval.details ?? ''}`));
      return ui.confirm('Approve this action?', approval.signal);
    };
    if (command === 'doctor') {
      process.exitCode = await doctor(config, values.cwd, { live: values.live, signal: controller.signal, consent: async message => ui ? ui.confirm(redact(message)) : false, log: text => console.log(redact(text)) }) ? 0 : 1;
      return;
    }
    let workload: Workload | undefined = command === 'code' ? 'coder' : command === 'ask' ? 'ask' : undefined;
    if (config.routingMode === 'direct' && !workload) {
      if (!ui) throw new Error('Direct routing requires teapilot ask or teapilot code.');
      workload = await ui.choose('What would you like to do?', ['Ask a question (no repository tools)', 'Work on code in the selected repository']) === 0 ? 'ask' : 'coder';
    }
    const prompt = values.prompt ?? (positionals.length ? positionals.join(' ') : ui ? await ui.input('teapilot') : '');
    if (!prompt.trim()) throw new Error('Supply a prompt; use teapilot setup for first use or --help for examples.');
    const result = await runHost(config, { prompt, workload, cwd: resolve(values.cwd), web: values.web, correction: values.correction, signal: controller.signal }, { approve, onProgress: message => console.error(redact(message)) });
    console.log(values.json ? JSON.stringify(result, null, 2) : result.text);
    if (!values.json) console.error(`\n${result.status}; accounted $${result.spentUsd.toFixed(6)}; request ${result.requestId}${result.receipts.length ? `\nReceipts: ${result.receipts.join(', ')}` : ''}`);
    process.exitCode = result.success ? 0 : 2;
  } finally { ui?.close(); process.removeListener('SIGINT', onInterrupt); }
}

main().catch(error => {
  if (error && typeof error === 'object' && 'issues' in error) console.error('Invalid configuration. Check model rates, endpoint URLs, context sizes, and policy field types. Run teapilot setup.');
  else if (error?.name === 'AbortError') console.error('Cancelled. Rerun setup to reuse completed downloads and saved settings.');
  else console.error(error instanceof Error ? error.message : 'teapilot failed');
  process.exitCode = 1;
});
