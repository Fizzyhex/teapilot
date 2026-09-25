import type { ModelConfig, Tier } from '../config.js';
import type { SetupUI } from './terminal.js';
import type { HardwareReport } from './hardware.js';

export type RuntimeFailureLayer =
  | 'hardware_unavailable'
  | 'runtime_unavailable'
  | 'server_not_ready'
  | 'model_unavailable'
  | 'api_incompatible'
  | 'verification_failed';

export class RuntimeFailure extends Error {
  constructor(public readonly layer: RuntimeFailureLayer, message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = 'RuntimeFailure';
  }
}

export interface RuntimeSetupOptions {
  nonInteractive?: boolean;
  endpoint?: string;
  model?: string;
  contextTokens?: number;
  verbose?: boolean;
}

export interface RuntimeContext {
  ui: SetupUI;
  signal: AbortSignal;
  stateDir: string;
  hardware: HardwareReport;
  options: RuntimeSetupOptions;
  existingApiKey?: string;
}

export type RuntimeModelConfig = Pick<ModelConfig,
  'id' | 'provider' | 'baseUrl' | 'apiKeyEnv' | 'contextTokens' | 'maxOutputTokens' |
  'vision' | 'toolCalling' | 'supportsDeveloperRole' | 'supportsUsage' | 'reasoningEfforts' | 'reasoning'
> & Pick<Partial<ModelConfig>, 'temperature'>;

export interface RuntimeSelection {
  tier: Tier;
  displayModel: string;
  model: RuntimeModelConfig;
  apiKey?: string;
  clearApiKey?: boolean;
  requestTimeoutMs?: number;
}

export interface RuntimeAvailability { available: boolean; reason?: string }

export interface LocalRuntimeDriver {
  readonly id: 'tabby' | 'ollama' | 'openai-compatible';
  readonly label: string;
  readonly managed: boolean;
  availability(context: RuntimeContext): Promise<RuntimeAvailability>;
  prepare(context: RuntimeContext): Promise<RuntimeSelection>;
}
