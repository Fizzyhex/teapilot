import type { Config } from './config.js';

export class SearchSetupError extends Error {}
export function searchRepair(config: Config): string {
  return `Configuration: ${config.source?.directory ?? 'provided settings'}. Run teapilot setup${config.source ? ` --config-dir "${config.source.directory}"` : ''} and choose Reconfigure, then configure search. See docs/02-commands.md#web-research.`;
}
export async function searchQuery(base: string, query: string, signal?: AbortSignal): Promise<Array<{ title: string; url: string; snippet: string }>> {
  try {
    const endpoint = new URL(base);
    if (!['http:', 'https:'].includes(endpoint.protocol) || endpoint.username || endpoint.password || endpoint.search || endpoint.hash) throw new Error('Invalid search URL');
    const url = new URL(`${base.replace(/\/$/, '')}/search`);
    url.searchParams.set('q', query); url.searchParams.set('format', 'json');
    const response = await fetch(url, { signal: AbortSignal.any([signal ?? new AbortController().signal, AbortSignal.timeout(15000)]), redirect: 'error' });
    if (!response.ok || !response.body) throw new Error('Search HTTP failure');
    const reader = response.body.getReader();
    const chunks: Uint8Array[] = []; let size = 0;
    try {
      for (;;) {
        const next = await reader.read(); if (next.done) break;
        size += next.value.length;
        if (size > 1_000_000) throw new Error('Search response too large');
        chunks.push(next.value);
      }
    } finally { await reader.cancel(); }
    const data = JSON.parse(Buffer.concat(chunks).toString('utf8')) as { results?: unknown };
    if (!Array.isArray(data.results)) throw new Error('Search requires a JSON results array');
    return data.results.slice(0, 5).map(result => ({
      title: String(result?.title ?? '').slice(0, 300),
      url: typeof result?.url === 'string' && /^https?:\/\//.test(result.url) ? result.url.slice(0, 2000) : '',
      snippet: String(result?.content ?? '').slice(0, 1500),
    }));
  } catch {
    signal?.throwIfAborted();
    throw new SearchSetupError('Search service unavailable or incompatible. Check its URL, connectivity, and SearXNG JSON output.');
  }
}

export async function checkSearch(config: Config, signal?: AbortSignal): Promise<void> {
  // Permissions are checked before any network request, including connectivity checks.
  if (!config.policy.permissions.includes('web.search')) throw new SearchSetupError(`Search is disallowed by the active policy. Enable web.search only if you intend to allow queries to your search service. ${searchRepair(config)}`);
  if (!config.searchUrl) throw new SearchSetupError(`No search endpoint configured (SEARCH_BASE_URL). ${searchRepair(config)}`);
  try { await searchQuery(config.searchUrl, 'teapilot connectivity check', signal); }
  catch (error) {
    if (!(error instanceof SearchSetupError)) throw error;
    throw new SearchSetupError(`${error.message} ${searchRepair(config)}`);
  }
}
