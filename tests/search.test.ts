import { afterEach, expect, it } from 'vitest';
import { checkSearch } from '../src/search.js';
import { runHost } from '../src/host.js';
import { SessionGrants } from '../src/execution/grants.js';
import { completion, fixture, jev, mockServer } from './helpers.js';

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

const routed = async (web: Parameters<typeof jev>[4], webConfidence: number, ceiling = true) => {
  const f = await fixture(); cleanup.push(f.cleanup);
  const server = await mockServer((_body, req, res) => {
    if (req.url === '/jev') jev(res, 'ask.normal', 0.99, undefined, web, webConfidence);
    else if (req.url?.startsWith('/search?')) res.end('{"results":[]}');
    else completion(res, { text: 'answered' });
  }); cleanup.push(server.close);
  f.config.router.endpoint = `${server.url}/jev`;
  f.config.models.fast.baseUrl = server.url; f.config.models.capable.baseUrl = server.url; f.config.searchUrl = server.url;
  if (!f.config.policy.permissions.includes('web.search') && ceiling) f.config.policy.permissions.push('web.search');
  if (!ceiling) f.config.policy.permissions = f.config.policy.permissions.filter(permission => permission !== 'web.search');
  const grants = await SessionGrants.create(f.cwd, f.config, 'ask');
  const approvals: string[] = [];
  const result = await runHost(f.config, { cwd: f.cwd, prompt: 'What is the weather now?', mode: 'ask', authorization: grants },
    { approve: async approval => { approvals.push(approval.kind); return false; }, localProbe: async () => true });
  return { result, approvals, grants };
};

it.each(['web.explicit', 'web.volatile', 'web.low_risk'] as const)('grants web.search without a prompt when Jev is confident about %s', async key => {
  const { result, approvals, grants } = await routed({ [key]: 'yes' }, 0.9);
  expect(approvals).toEqual([]);
  expect(result.success).toBe(true);
  expect(grants.list()).toContain('web.search');
});

it('prompts as before when web.search is needed but no auto-grant condition is confident above 0.75', async () => {
  const { result, approvals, grants } = await routed({ 'web.search': 'yes', 'web.volatile': 'yes' }, 0.75);
  expect(approvals).toEqual(['capability']);
  expect(result.status).toBe('approval_denied');
  expect(grants.list()).not.toContain('web.search');
});

it('never auto-grants web.search that the policy ceiling disallows', async () => {
  const { result, approvals, grants } = await routed({ 'web.volatile': 'yes' }, 0.9, false);
  expect(approvals).toEqual([]);
  expect(grants.list()).not.toContain('web.search');
  expect(result.success).toBe(true);
});
