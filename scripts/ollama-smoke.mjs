import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadConfig } from '../dist/config.js';
import { liveCheck, modelStatus } from '../dist/diagnostics.js';
import { runHost } from '../dist/host.js';
import { presets, selectOllamaModel } from '../dist/setup/ollama.js';

const model = process.env.TEAPILOT_TEST_MODEL ?? presets[0].id;
const selection = presets.findIndex(preset => preset.id === model);
assert(selection >= 0, 'TEAPILOT_TEST_MODEL must name a bundled preset');
const base = process.env.OLLAMA_TEST_URL ?? 'http://127.0.0.1:11434';
const scratch = await mkdtemp(join(tmpdir(), 'teapilot-ollama-test-'));
const signal = AbortSignal.timeout(30 * 60 * 1000);
try {
  console.log(`Validating ${model} on ${process.platform}/${process.arch}`);
  const configured = await selectOllamaModel({ log: console.log, choose: async () => 0, confirm: async () => true, input: async (message, fallback) => {
    if (message.startsWith('Choose one or more')) return String(selection + 1);
    if (fallback !== undefined) return fallback;
    throw new Error('Unexpected custom model prompt');
  } }, signal, base);
  const config = await loadConfig(scratch, {});
  config.routingMode = 'direct'; config.stateDir = join(scratch, 'state');
  config.models.economy.enabled = false; config.models.strong.enabled = false;
  Object.assign(config.models.local, { provider: 'ollama', baseUrl: `${base}/v1`, id: configured.id, contextTokens: configured.context, toolCalling: configured.tools, temperature: 0.2 });
  config.policy.budget.requestUsd = 0; config.policy.budget.dailyUsd = 0;
  config.policy.limits.requestTimeoutMs = 120000;
  config.policy.limits.attemptTimeoutMs = 600000;
  assert.equal(await modelStatus(config, 'local', signal), undefined);
  const report = await liveCheck(config, 'local', signal, console.log);
  console.log(JSON.stringify({ model, platform: process.platform, ...report }));
  assert.deepEqual(report, { ask: true, tools: true, coding: true, spentUsd: 0 });
  console.log('Checking the production coding workload...');
  await writeFile(join(scratch, 'add.js'), 'export const add = (a, b) => a - b;\n');
  let toolCalls = 0;
  const result = await runHost(config, { cwd: scratch, workload: 'coder', prompt: 'Read add.js. Fix its subtraction to addition by changing only the minus sign to a plus sign. Preserve every other character. Then read the updated add.js to verify it. After verification, create a new directory web-pong by writing web-pong/index.html with a self-contained Pong game using inline JavaScript and CSS. Read that file to verify it exists. Do not run shell commands. Then briefly summarize the edits. /no_think', signal }, { approve: async () => false, onProgress: console.log, onEvent: event => { if (event.type === 'tool_execution_end') toolCalls++; } });
  assert.equal(result.success, true, `Coding stopped: ${result.status}`);
  assert.equal(await readFile(join(scratch, 'add.js'), 'utf8'), 'export const add = (a, b) => a + b;\n');
  assert.equal(result.spentUsd, 0);
  assert(toolCalls >= 5, `Expected several tool round trips, got ${toolCalls} calls`);
  assert.match(await readFile(join(scratch, 'web-pong/index.html'), 'utf8'), /<script[\s>]/i);
  console.log('Production coding workload passed with zero API spend.');
} finally { await rm(scratch, { recursive: true, force: true }); }
