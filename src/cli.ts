#!/usr/bin/env node
import { parseArgs } from 'node:util';
import { resolve } from 'node:path';
import { configDirectory, loadConfig, type Workload } from './config.js';
import { runHost, type HostRequest } from './host.js';
import { runChat } from './chat.js';
import { doctor } from './diagnostics.js';
import { setup } from './setup/index.js';
import { ManagedSearch } from './setup/searxng.js';
import { terminalUI } from './setup/terminal.js';
import type { Approve } from './execution/policy.js';
import { serve } from './integration/service.js';
import { SearchSetupError } from './search.js';
import { TerminalPresentation } from './presentation.js';
import { SessionGrants, type Mode } from './execution/grants.js';

const help = `teapilot — local and hosted personal agent

teapilot setup
teapilot ask "Explain dependency injection"
teapilot chat ["Help me think through an idea"]
teapilot code --cwd <repository> "Fix the failing tests"
teapilot doctor [--live]
teapilot search status|start|stop|remove
teapilot serve --stdio

  Options: --cwd PATH  --config-dir PATH  --prompt TEXT  --web  --json  --tier auto|fast|normal|reasoning|deep
         --correction TEXT  --no-motion  --verbose (setup progress)  --help
Hosted routing also accepts a bare prompt. Direct routing uses ask/chat/code.
Chat requires an interactive terminal; /exit or /quit ends the session.
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
    stdio: { type: 'boolean' }, tier: { type: 'string' },
    'no-motion': { type: 'boolean' },
    verbose: { type: 'boolean' },
  } });
  if (values.help) { console.log(help); return; }
  const [major = 0, minor = 0] = process.versions.node.split('.').map(Number);
  if (major < 22 || (major === 22 && minor < 19)) throw new Error('TeaPilot requires Node >=22.19.0.');
  const command = ['setup', 'doctor', 'ask', 'chat', 'code', 'serve', 'search'].includes(positionals[0] ?? '') ? positionals.shift() : undefined;
  if (command === 'serve') { if (!values.stdio) throw new Error('serve requires --stdio'); await serve(); return; }
  if (values.stdio) throw new Error('--stdio requires serve');
  if (command !== 'setup' && [values['non-interactive'], values.endpoint, values.model, values['context-tokens']].some(value => value !== undefined)) throw new Error('Endpoint/model and unattended setup options require the setup command.');
  if (values.live && command !== 'doctor') throw new Error('--live requires the doctor command.');
  const interactive = Boolean(process.stdin.isTTY && process.stderr.isTTY);
  if (command === 'chat' && (!interactive || values.json)) throw new Error('Chat requires an interactive terminal and does not support --json. Use ask for one-shot or scripted requests.');
  const controller = new AbortController();
  const presentation = new TerminalPresentation(Boolean(values.json), Boolean(values['no-motion'] || values['non-interactive']));
  const ui = interactive ? terminalUI(controller.signal, presentation) : undefined;
  const onInterrupt = () => { presentation.close(); controller.abort(); ui?.close(); };
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
      const ready = await setup({ directory: values['config-dir'], verbose: values.verbose, nonInteractive: values['non-interactive'], endpoint: values.endpoint, model: values.model, contextTokens: values['context-tokens'] === undefined ? undefined : Number(values['context-tokens']) }, ui ?? headless, controller.signal);
      process.exitCode = ready ? 0 : 2;
      return;
    }
    const directory = await configDirectory(values['config-dir']);
    if (command === 'search') {
      const action = positionals.shift() ?? 'status';
      if (positionals.length) throw new Error('Use teapilot search status|start|stop|remove.');
      const serviceUI = ui ?? { log: (text: string) => console.error(text), confirm: async () => { throw new Error('Starting or removing search requires an interactive terminal.'); }, input: async () => '', choose: async () => 0 };
      process.exitCode = await new ManagedSearch(directory, controller.signal).manage(action, serviceUI) ? 0 : 2;
      return;
    }
    let config;
    try { config = await loadConfig(values['config-dir'], { ...process.env }); }
    catch (error) {
      console.error(`Configuration: ${directory} (${values['config-dir'] ? 'explicit --config-dir' : directory === process.cwd() ? 'launch directory' : 'personal profile'}). Repair: teapilot setup --config-dir "${directory}"`);
      throw error;
    }
    const secrets = [config.router.apiKey, ...Object.values(config.secrets)].filter((value): value is string => Boolean(value));
    const redact = (message: string) => secrets.reduce((text, secret) => text.split(secret).join('[REDACTED]'), message);
    const approve: Approve = async approval => {
      if (!ui || controller.signal.aborted || approval.signal?.aborted) return false;
      presentation.approval(redact(`${approval.summary}\n${approval.details ?? ''}`));
      return await ui.confirm('Approve this action?', approval.signal);
    };
    if (command === 'doctor') {
      process.exitCode = await doctor(config, values.cwd, { live: values.live, signal: controller.signal, consent: async message => ui ? ui.confirm(redact(message)) : false, activity: presentation.activity, log: text => presentation.write(redact(text) + '\n', 'stdout') }) ? 0 : 1;
      return;
    }
    let workload: Workload | undefined = command === 'code' ? 'coder' : (command === 'ask' || command === 'chat') ? 'ask' : undefined;
    if (config.routingMode === 'direct' && !workload) {
      if (!ui) throw new Error('Direct routing requires teapilot ask or teapilot code.');
      workload = await ui.choose('What would you like to do?', ['Ask a question (no repository tools)', 'Work on code in the selected repository']) === 0 ? 'ask' : 'coder';
    }
    const prompt = values.prompt ?? (positionals.length ? positionals.join(' ') : ui && command !== 'chat' ? await ui.prompt('teapilot', resolve(values.cwd)) : '');
    if (command !== 'chat' && !prompt.trim()) throw new Error('Supply a prompt; use teapilot setup for first use or --help for examples.');
    const tier = values.tier === undefined ? undefined : ['auto', 'fast', 'normal', 'reasoning', 'deep'].includes(values.tier) ? values.tier as HostRequest['tier'] : (() => { throw new Error('--tier must be auto, fast, normal, reasoning, or deep.'); })();
    const request = { prompt, workload, cwd: resolve(values.cwd), web: values.web, correction: values.correction, tier, signal: controller.signal };
    const sessionMode: Mode = command === 'code' ? 'code' : command === 'ask' ? 'ask' : 'chat';
    const authorization = command === 'chat' || command === 'code' ? await SessionGrants.create(request.cwd, config, sessionMode, Boolean(values.web)) : undefined;
    const sessionRequest = authorization ? { ...request, authorization, mode: sessionMode, conversational: command === 'chat' } : request;
    const dependencies = { approve, onActivity: presentation.setActivity, onProgress: (message: string) => presentation.log(redact(message)), onEvent: (event: import('./integration/events.js').HostEvent) => presentation.event(event) };
    const execute = async (request: HostRequest) => {
      let result;
      presentation.start();
      try { result = await runHost(config, request, dependencies); }
      catch (error) {
        if (!(error instanceof SearchSetupError) || !ui || values.json) throw error;
        presentation.pause();
        presentation.log(error.message);
        if (!await ui.confirm('Continue without web search? The answer will be unverified against current sources.')) throw error;
        presentation.start();
        result = await runHost(config, { ...request, web: false }, dependencies);
        result.text = `Web search was unavailable. This answer is unverified against current sources.\n\n${result.text}`;
      }
      if (values.json) console.log(JSON.stringify(result, null, 2));
      else presentation.answer(result.text);
      if (!values.json) presentation.log(`\nResult: ${result.status}; accounted $${result.spentUsd.toFixed(6)}; request ${result.requestId}${result.receipts.length ? `\nReceipts: ${result.receipts.join(', ')}` : ''}`);
      return result;
    };
    if (command === 'chat') {
      presentation.log('Chat started. Type /exit or /quit to leave.');
      process.exitCode = await runChat({ request: sessionRequest, maxPromptChars: config.policy.limits.maxPromptChars, input: state => ui!.prompt('>', resolve(values.cwd), { ...state, routingMode: config.routingMode ?? 'hosted' }), run: execute });
    } else {
      const result = await execute(sessionRequest);
      process.exitCode = result.success ? 0 : 2;
    }
  } finally { presentation.close(); ui?.close(); process.removeListener('SIGINT', onInterrupt); }
}

main().catch(error => {
  if (error && typeof error === 'object' && 'issues' in error) console.error('Invalid configuration. Check model rates, endpoint URLs, context sizes, and policy field types. Run teapilot setup.');
  else if (error?.name === 'AbortError') console.error('Cancelled.');
  else console.error(error instanceof Error ? error.message : 'teapilot failed');
  process.exitCode = 1;
});
