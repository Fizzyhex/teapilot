import type { ModelConfig } from '../config.js';
import { ollamaDriver } from './ollama.js';
import { tabbyDriver } from './tabby.js';
import type { RuntimeDriver } from './types.js';

export type { ProvisionedModel, RuntimeContext, RuntimeDriver, RuntimeFailureKind, Suitability } from './types.js';
export { isRuntimeError, RuntimeError } from './types.js';
export { endpointDriver, endpointLabel, type Endpoint } from './endpoint.js';

/** The runtimes TeaPilot can install and run itself. Tests pass their own. */
export interface Runtimes { ollama: RuntimeDriver; nvidia?: RuntimeDriver }
export function managedRuntimes(): Runtimes { return { ollama: ollamaDriver, nvidia: tabbyDriver() }; }

/** What the runtimes can tell about a configured model whose endpoint check failed. */
export async function runtimeHints(model: ModelConfig, signal: AbortSignal, runtimes: Runtimes = managedRuntimes()): Promise<string[]> {
  const hints = await Promise.all(Object.values(runtimes).map(driver => driver?.hint?.(model, signal).catch(() => { signal.throwIfAborted(); return undefined; })));
  return hints.filter((hint): hint is string => Boolean(hint));
}
