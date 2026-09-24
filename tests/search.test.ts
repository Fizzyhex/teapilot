import { afterEach, expect, it } from 'vitest';
import { checkSearch } from '../src/search.js';
import { runHost } from '../src/host.js';
import { completion, fixture, mockServer } from './helpers.js';

const cleanup: Array<() => Promise<void>> = [];
afterEach(async () => { for (const fn of cleanup.splice(0).reverse()) await fn(); });

it('distinguishes missing configuration, denied permission, invalid service, and working JSON', async () => {
  const f = await fixture(); cleanup.push(f.cleanup);
  f.config.searchUrl = undefined;
  await expect(checkSearch(f.config)).rejects.toThrow('No search endpoint');
  let calls = 0;
  const server = await mockServer((_body, _req, res) => { calls++; res.end(calls === 1 ? '<html>not json</html>' : '{"results":[]}'); }); cleanup.push(server.close);
  f.config.searchUrl = server.url;
  f.config.policy.permissions = ['inference'];
  await expect(checkSearch(f.config)).rejects.toThrow('disallowed');
  expect(calls).toBe(0);
  f.config.policy.permissions.push('web.search');
  await expect(checkSearch(f.config)).rejects.toThrow('unavailable or incompatible');
  await expect(checkSearch(f.config)).resolves.toBeUndefined();
  f.config.searchUrl = 'http://127.0.0.1:1';
  await expect(checkSearch(f.config)).rejects.toThrow('Configuration:');
});

it('a search outage during execution cannot produce a successful unverified answer', async () => {
  const f = await fixture(); cleanup.push(f.cleanup);
  let searches = 0, inference = 0;
  const server = await mockServer((_body, req, res) => {
    if (req.url?.startsWith('/search?')) {
      if (++searches === 1) res.end('{"results":[]}');
      else { res.writeHead(503); res.end('{}'); }
    } else if (req.url?.endsWith('/models')) res.end('{}');
    else { inference++; completion(res, { tool: { name: 'web_search', arguments: { query: 'current facts' } } }); }
  }); cleanup.push(server.close);
  f.config.routingMode = 'direct'; f.config.models.capable.baseUrl = server.url; f.config.searchUrl = server.url;
  const result = await runHost(f.config, { cwd: f.cwd, workload: 'ask', web: true, prompt: 'Research current facts' }, { approve: async () => false });
  expect(result).toMatchObject({ success: false, status: 'search_unavailable', attempts: 1 });
  expect(inference).toBe(1);
  expect(result.text).toContain('Check the search service');
});
