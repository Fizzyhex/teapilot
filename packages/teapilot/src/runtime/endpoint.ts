import type { RuntimeDriver } from './types.js';

export interface Endpoint { baseUrl: string; id: string; contextTokens: number; key?: string }

export const endpointLabel = 'An existing local OpenAI-compatible endpoint';

/**
 * A server someone else runs. TeaPilot only connects to it: nothing is installed,
 * started or stopped, and whether it works is left to the endpoint and live checks.
 */
export function endpointDriver(endpoint: Endpoint): RuntimeDriver {
  return {
    id: 'endpoint', label: endpointLabel, ownership: 'unmanaged',
    async suitability() { return { suitable: true, summary: `Connects to ${endpoint.baseUrl}.` }; },
    async inspect(signal) {
      try {
        const response = await fetch(`${endpoint.baseUrl.replace(/\/$/, '')}/models`, { headers: endpoint.key ? { Authorization: `Bearer ${endpoint.key}` } : {}, signal: AbortSignal.any([signal, AbortSignal.timeout(5000)]), redirect: 'error' });
        await response.body?.cancel();
        return { ownership: 'unmanaged', ready: response.ok, baseUrl: endpoint.baseUrl };
      } catch { signal.throwIfAborted(); return { ownership: 'unmanaged', ready: false, baseUrl: endpoint.baseUrl }; }
    },
    async ensure() {},
    async provision() {
      // Reasoning is unknown for an arbitrary server, so none is requested.
      return [{
        roles: ['capable'], source: endpoint.id, apiKey: endpoint.key || undefined,
        model: { id: endpoint.id, provider: 'local', baseUrl: endpoint.baseUrl, contextTokens: endpoint.contextTokens, maxOutputTokens: Math.min(16384, Math.floor(endpoint.contextTokens / 4)), toolCalling: true, reasoning: undefined },
      }];
    },
  };
}
