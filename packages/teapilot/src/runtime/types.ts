import type { ModelConfig, PhysicalModel } from '../config.js';
import type { SetupUI } from '../setup/terminal.js';

// Runtime drivers manage inference services during setup and diagnostics only.
// Normal execution depends on the saved ModelConfig (an OpenAI-compatible API
// contract plus verified capabilities), never on how its server was installed.

/**
 * Failure layers setup and doctor report without matching message text.
 * Generation failures (streamed answer, tool continuation, coding) are
 * reported by live checks, not by drivers.
 */
export type RuntimeFailureKind =
  | 'hardware'        // hardware unavailable or unsupported
  | 'runtime'         // runtime missing or broken
  | 'not-ready'       // server did not become ready
  | 'model-missing'   // model not present on the server
  | 'download'        // model or drafter download failed
  | 'load'            // model load failed
  | 'api'             // OpenAI API incompatible
  | 'declined';       // the user declined a required step

export class RuntimeError extends Error {
  constructor(readonly kind: RuntimeFailureKind, message: string, readonly detail?: string) {
    super(message);
    this.name = 'RuntimeError';
  }
}
export const isRuntimeError = (error: unknown, kind?: RuntimeFailureKind): error is RuntimeError =>
  error instanceof RuntimeError && (kind === undefined || error.kind === kind);

/** Whether TeaPilot installs/starts the service or only connects to it. */
export type RuntimeOwnership = 'managed' | 'unmanaged';

export type Suitability =
  | { suitable: true; summary: string; notes?: string[] }
  | { suitable: false; reason: string; kind: RuntimeFailureKind };

/**
 * A model the runtime has made available, as the fields of an ordinary
 * OpenAI-compatible ModelConfig. Nothing here says how the server was installed.
 */
export interface ProvisionedModel {
  roles: PhysicalModel[];
  /** What the user chose, for display (e.g. the upstream repository). */
  source: string;
  /**
   * toolCalling is advertised support only and never enables coding by itself.
   * reasoning lists every level the server can be asked for: candidates, which
   * live checks decide. reasoningEfforts is never set here.
   */
  model: Pick<ModelConfig, 'id' | 'provider' | 'baseUrl' | 'contextTokens' | 'maxOutputTokens' | 'toolCalling'> & Partial<Omit<ModelConfig, 'enabled' | 'reasoningEfforts'>>;
  /** Environment variable holding the credential; the existing one is kept when unset. */
  apiKeyEnv?: string;
  /** Credential to save outside ModelConfig: a value to store, null for none, or undefined to keep. */
  apiKey?: string | null;
}

export interface RuntimeInspection { ownership: RuntimeOwnership; ready: boolean; version?: string; baseUrl?: string; detail?: string }

export interface RuntimeContext { ui: SetupUI; signal: AbortSignal; verbose?: boolean }

export interface RuntimeDriver {
  /** Stable identifier, also used for managed-runtime metadata. */
  readonly id: string;
  /** Label shown in normal setup (e.g. "Optimized NVIDIA"). */
  readonly label: string;
  readonly ownership: RuntimeOwnership;
  /** Stall timeout the runtime needs, e.g. for a slow first token; saved to policy. */
  readonly requestTimeoutMs?: number;
  /** Cheap check: can this runtime be offered on this machine? */
  suitability(signal: AbortSignal): Promise<Suitability>;
  /** Cheap check for doctor: process and API metadata only, never generation. */
  inspect(signal: AbortSignal): Promise<RuntimeInspection>;
  /** Install or reuse, then start if needed, until the server is ready. */
  ensure(context: RuntimeContext): Promise<void>;
  /** Discover or provision models; loads happen here, not on the first real request. */
  provision(context: RuntimeContext): Promise<ProvisionedModel[]>;
  /** Start an existing install, e.g. after a reboot, without installing or downloading anything. */
  start?(context: RuntimeContext): Promise<void>;
  /** Stop a managed service. Unmanaged drivers leave the service alone. */
  stop?(signal: AbortSignal): Promise<void>;
  /** A hint for a configured model whose endpoint check failed, if this runtime can explain it. */
  hint?(model: ModelConfig, signal: AbortSignal): Promise<string | undefined>;
}
