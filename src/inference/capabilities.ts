import type { ModelConfig } from '../config.js';

export interface DiscoveredModelCapabilities {
  contextTokens?: number;
  vision?: boolean;
}

function headers(apiKey?: string): HeadersInit | undefined {
  return apiKey ? { Authorization: `Bearer ${apiKey}` } : undefined;
}

function positiveInteger(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isInteger(value) && value > 0 ? value : undefined;
}

/**
 * Discover portable model metadata exposed by OpenAI-compatible/local-model
 * APIs. Absence of optional metadata is not an error; live TeaPilot checks
 * remain authoritative for behavioral capabilities such as tool use/coding.
 */
export async function discoverModelCapabilities(model: ModelConfig, apiKey?: string, signal?: AbortSignal): Promise<DiscoveredModelCapabilities> {
  const result: DiscoveredModelCapabilities = {};
  const requestSignal = signal ?? AbortSignal.timeout(5000);
  try {
    const response = await fetch(`${model.baseUrl.replace(/\/$/, '')}/models`, { headers: headers(apiKey), signal: requestSignal, redirect: 'error' });
    if (response.ok) {
      const body = await response.json() as { data?: Array<Record<string, unknown>> };
      const card = body.data?.find(item => item.id === model.id);
      const meta = card?.meta as Record<string, unknown> | undefined;
      const parameters = card?.parameters as Record<string, unknown> | undefined;
      result.contextTokens = positiveInteger(meta?.n_ctx) ?? positiveInteger(parameters?.max_seq_len);
    }
  } catch { signal?.throwIfAborted(); }

  const root = model.baseUrl.replace(/\/v1\/?$/, '');
  try {
    const response = await fetch(`${root}/props`, { headers: headers(apiKey), signal: requestSignal, redirect: 'error' });
    if (response.ok) {
      const body = await response.json() as {
        default_generation_settings?: { n_ctx?: unknown };
        modalities?: { vision?: unknown };
      };
      result.contextTokens = positiveInteger(body.default_generation_settings?.n_ctx) ?? result.contextTokens;
      if (typeof body.modalities?.vision === 'boolean') result.vision = body.modalities.vision;
    }
  } catch { signal?.throwIfAborted(); }
  return result;
}
