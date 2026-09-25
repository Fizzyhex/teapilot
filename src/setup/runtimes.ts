import { ensureOllama, ollamaURL, presets, selectOllamaModel } from './ollama.js';
import { TabbyRuntime, TABBY_BASE_URL, optimizedNvidiaPreset } from './tabby.js';
import type { LocalRuntimeDriver, RuntimeContext } from './runtime.js';

async function numericInput(context: RuntimeContext, label: string, fallback: number, minimum: number): Promise<number> {
  for (;;) {
    const value = Number(await context.ui.input(label, String(fallback)));
    if (Number.isFinite(value) && value >= minimum) return value;
    context.ui.log(`Enter a number of at least ${minimum}.`);
  }
}

const optimizedNvidia: LocalRuntimeDriver = {
  id: 'tabby',
  label: 'Optimized NVIDIA (managed local inference)',
  managed: true,
  async availability(context) {
    return context.hardware.optimizedNvidia
      ? { available: true }
      : { available: false, reason: context.hardware.reason ?? 'No suitable NVIDIA GPU was detected.' };
  },
  async prepare(context) {
    const runtime = new TabbyRuntime(context.stateDir);
    context.ui.log('Optimized NVIDIA uses an isolated TeaPilot-owned TabbyAPI/ExLlamaV3 runtime. It does not install system-wide packages or require administrator changes.');
    await runtime.ensureInstalled(context.hardware, context.signal);
    const keys = await runtime.provision(context.ui, context.signal);
    return {
      tier: 'normal',
      displayModel: optimizedNvidiaPreset.label,
      apiKey: keys.apiKey,
      requestTimeoutMs: 300_000,
      model: {
        id: optimizedNvidiaPreset.modelFolder,
        provider: 'local',
        baseUrl: `${TABBY_BASE_URL}/v1`,
        apiKeyEnv: 'LOCAL_API_KEY',
        contextTokens: optimizedNvidiaPreset.contextTokens,
        maxOutputTokens: optimizedNvidiaPreset.maxOutputTokens,
        vision: false,
        toolCalling: true,
        supportsDeveloperRole: false,
        supportsUsage: true,
        reasoningEfforts: ['off', 'medium', 'xhigh'],
        reasoning: {
          type: 'reasoning_effort',
          values: {
            off: { templateVars: { enable_thinking: false } },
            medium: 'medium',
            xhigh: 'xhigh',
          },
        },
      },
    };
  },
};

const ollama: LocalRuntimeDriver = {
  id: 'ollama',
  label: 'Local Ollama (managed local inference)',
  managed: true,
  async availability() { return { available: true }; },
  async prepare(context) {
    await ensureOllama(context.ui, context.signal);
    const selected = await selectOllamaModel(context.ui, context.signal, undefined, context.options.verbose);
    const tier = selected.source === presets[0]?.id ? 'fast' as const : 'normal' as const;
    return {
      tier,
      displayModel: selected.source,
      clearApiKey: true,
      requestTimeoutMs: 120_000,
      model: {
        id: selected.id,
        provider: 'ollama',
        baseUrl: `${ollamaURL}/v1`,
        apiKeyEnv: 'LOCAL_API_KEY',
        contextTokens: selected.context,
        maxOutputTokens: tier === 'fast' ? 2048 : Math.min(8192, Math.floor(selected.context / 4)),
        toolCalling: selected.tools,
        vision: false,
        supportsDeveloperRole: false,
        supportsUsage: true,
        temperature: 0.2,
        reasoningEfforts: ['off'],
        reasoning: { type: 'reasoning_effort', values: { off: 'none' } },
      },
    };
  },
};

const endpoint: LocalRuntimeDriver = {
  id: 'openai-compatible',
  label: 'Existing OpenAI-compatible local endpoint',
  managed: false,
  async availability() { return { available: true }; },
  async prepare(context) {
    const baseUrl = context.options.endpoint ?? await context.ui.input('API base URL including /v1', 'http://127.0.0.1:8080/v1');
    const id = context.options.model ?? await context.ui.input('Exact model ID');
    const contextTokens = context.options.contextTokens ?? await numericInput(context, 'Actual server context tokens', 16384, 8192);
    const key = context.options.nonInteractive
      ? process.env.LOCAL_API_KEY ?? context.existingApiKey ?? ''
      : await context.ui.input('API key if required (hidden; blank keeps existing)', context.existingApiKey ?? '', true);
    return {
      tier: 'normal',
      displayModel: id,
      apiKey: key || undefined,
      model: {
        id,
        provider: 'local',
        baseUrl,
        apiKeyEnv: 'LOCAL_API_KEY',
        contextTokens,
        maxOutputTokens: Math.min(2048, Math.floor(contextTokens / 4)),
        toolCalling: true,
        vision: false,
        supportsDeveloperRole: false,
        supportsUsage: true,
        reasoningEfforts: ['off'],
      },
    };
  },
};

export const localRuntimeDrivers: readonly LocalRuntimeDriver[] = [optimizedNvidia, ollama, endpoint];

export async function discoverRuntimeDrivers(context: RuntimeContext): Promise<LocalRuntimeDriver[]> {
  const available: LocalRuntimeDriver[] = [];
  for (const driver of localRuntimeDrivers) {
    const result = await driver.availability(context);
    if (result.available) available.push(driver);
  }
  return available;
}

export function runtimeDriver(id: LocalRuntimeDriver['id']): LocalRuntimeDriver {
  const driver = localRuntimeDrivers.find(candidate => candidate.id === id);
  if (!driver) throw new Error(`Unknown local runtime: ${id}`);
  return driver;
}
