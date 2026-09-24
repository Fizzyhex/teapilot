import { afterEach, describe, expect, it, vi } from 'vitest';
import { readFile, writeFile, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { runHost } from '../src/host.js';
import { completion, events, fixture, jev, mockServer, type Handler } from './helpers.js';

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => { vi.unstubAllGlobals(); for (const cleanup of cleanups.splice(0).reverse()) await cleanup(); });

async function setup(handler: Handler) {
  const f = await fixture(); cleanups.push(f.cleanup);
  const server = await mockServer(handler); cleanups.push(server.close);
  f.config.router.endpoint = `${server.url}/jev`;
  f.config.models.fast.baseUrl = `${server.url}/fast/v1`;
  f.config.models.capable.baseUrl = `${server.url}/capable/v1`;
  return f;
}

describe('real JevRouter SDK + pi loop with mock HTTP providers', () => {
  it('routes follow-ups using recent history while dropping oversized older turns', async () => {
    let routedHistory: unknown;
    const recent = { user: 'Suggest two changes to this repository.', assistant: 'First: rename a variable. Second: add validation.' };
    const f = await setup((body, req, res) => {
      if (req.url === '/jev') { routedHistory = body.state.context.history; jev(res, 'coder.normal'); }
      else completion(res, { text: 'Inspected the requested change.' });
    });
    f.config.policy.limits.maxPromptChars = 20000;
    f.config.models.capable.contextTokens = 32768;
    const result = await runHost(f.config, {
      cwd: f.cwd, prompt: 'Implement the second option',
      history: [{ user: '旧'.repeat(14000), assistant: 'Earlier discussion' }, recent],
    }, { approve: async () => false, localProbe: async () => true });
    expect(result.success, JSON.stringify(result)).toBe(true);
    expect(routedHistory).toEqual([recent]);
  });

  it('cancels pending routing, releases the lock, and retains the charge despite a late reply', async () => {
    const f = await fixture(); cleanups.push(f.cleanup);
    const controller = new AbortController();
    let resolveRoute!: (value: any) => void;
    let markStarted!: () => void;
    const started = new Promise<void>(resolve => { markStarted = resolve; });
    const approve = vi.fn(async () => true);
    const pending = runHost(f.config, { cwd: f.cwd, prompt: 'Explain a topic', workload: 'ask', signal: controller.signal }, {
      approve, localProbe: async () => true,
      provider: { name: 'pending', decide: (_request, signal) => {
        expect(signal).toBe(controller.signal);
        markStarted();
        return new Promise(resolve => { resolveRoute = resolve; });
      } },
    });
    await started;
    controller.abort();
    const result = await pending;
    expect(result.status).toBe('cancelled');
    expect(result.attempts).toBe(0);
    expect(result.spentUsd).toBe(f.config.router.maxCallUsd);
    expect(approve).not.toHaveBeenCalled();
    await expect(stat(join(f.config.stateDir, 'run.lock'))).rejects.toMatchObject({ code: 'ENOENT' });
    const ledger = await readFile(join(f.config.stateDir, 'spend.jsonl'), 'utf8');
    resolveRoute({ answers: {}, usage: { cost: 0 } });
    await new Promise(resolve => setImmediate(resolve));
    expect(await readFile(join(f.config.stateDir, 'spend.jsonl'), 'utf8')).toBe(ledger);
  });

  it('routes ask with no filesystem/shell tools, records receipts and actual usage', async () => {
    let sentTools: string[] = [];
    const f = await setup((body, req, res) => {
      if (req.url === '/jev') { expect(body.questions.tool.criteria['ask.normal']).toContain('context_tokens'); jev(res, 'ask.normal'); }
      else if (req.url?.endsWith('/models')) { res.end('{}'); }
      else { sentTools = body.tools.map((tool: any) => tool.function.name); completion(res, { text: 'A clear explanation.', cost: 0 }); }
    });
    const result = await runHost(f.config, { cwd: f.cwd, prompt: 'Explain dependency injection' }, { approve: async () => false });
    expect(result.success).toBe(true);
    expect(result.capability).toBe('ask.normal');
    expect(sentTools).toEqual(['request_escalation']);
    const receipt = JSON.parse(await readFile(result.receipts[0]!, 'utf8'));
    expect(receipt.provenance.candidate_snapshot_hash).toMatch(/^sha256:/);
    expect(receipt.raw_jev.answers.tool.choice).toBe('ask.normal');
    expect((await events(f.config)).find(e => e.type === 'usage' && e.stage === 'inference').usage.totalTokens).toBe(140);
  });

  it('coder uses pi read/write tools and receives AGENTS.md', async () => {
    let calls = 0;
    const f = await setup((body, req, res) => {
      if (req.url === '/jev') jev(res, 'coder.normal');
      else if (req.url?.endsWith('/models')) res.end('{}');
      else {
        expect(JSON.stringify(body.messages)).toContain('Use semicolons in this project');
        calls++;
        if (calls === 1) completion(res, { tool: { name: 'read', arguments: { path: 'input.txt' } } });
        else if (calls === 2) { expect(JSON.stringify(body.messages)).toContain('old value'); completion(res, { tool: { name: 'write', arguments: { path: 'output.txt', content: 'updated value' } } }); }
        else completion(res, { text: 'Created output.txt; tests were not run.' });
      }
    });
    await writeFile(join(f.cwd, 'AGENTS.md'), 'Use semicolons in this project');
    await writeFile(join(f.cwd, 'input.txt'), 'old value');
    const result = await runHost(f.config, { cwd: f.cwd, prompt: 'Implement the requested change' }, { approve: async () => false });
    expect(result.success).toBe(true);
    expect(result.capability).toBe('coder.normal');
    expect(await readFile(join(f.cwd, 'output.txt'), 'utf8')).toBe('updated value');
    expect(calls).toBe(3);
  });

  it.each([false, true])('requires verification after test failures escalate (repair: %s)', async repair => {
    let routes = 0, localCalls = 0, cloudCalls = 0;
    const command = 'node --test failing.test.cjs';
    const f = await setup((body, req, res) => {
      if (req.url === '/jev') jev(res, ++routes === 1 ? 'coder.normal' : 'coder.reasoning');
      else if (req.url?.endsWith('/models')) res.end('{}');
      else if (body.reasoning_effort === 'none') { localCalls++; completion(res, { tool: { name: process.platform === 'win32' ? 'powershell' : 'bash', arguments: { command } } }); }
      else {
        cloudCalls++;
        expect(body.model).toBe('capable-test');
        expect(body.reasoning_effort).toBe('medium');
        expect(JSON.stringify(body.messages)).toContain('Previous attempt stopped');
        if (repair && cloudCalls === 1) completion(res, { tool: { name: 'write', arguments: { path: 'failing.test.cjs', content: '// repaired' } } });
        else if (repair && cloudCalls === 2) completion(res, { tool: { name: process.platform === 'win32' ? 'powershell' : 'bash', arguments: { command } } });
        else completion(res, { text: 'Resolved using the economy model.', cost: 0.00004 });
      }
    });
    f.config.policy.execution.trustedCommands = [command];
    f.config.policy.escalation.maxEscalations = 1;
    await writeFile(join(f.cwd, 'failing.test.cjs'), 'throw new Error("test failed");');
    const result = await runHost(f.config, { cwd: f.cwd, prompt: 'Fix the failing tests' }, { approve: async () => false });
    expect(result.success).toBe(repair);
    expect(result.check).toBe(repair ? 'passed' : 'failed');
    expect(result.status).toBe(repair ? 'completed' : 'test_failures');
    expect(result.capability).toBe('coder.reasoning');
    expect(localCalls).toBe(2);
    expect(cloudCalls).toBe(repair ? 3 : 1);
    expect(result.receipts).toHaveLength(2);
    expect((await events(f.config)).find(e => e.type === 'escalation')).toMatchObject({ from: 'coder.normal', to: 'coder.reasoning', reason: 'test_failures' });
  });

  it('does not escalate a successful difficult local request', async () => {
    let routes = 0;
    const f = await setup((_body, req, res) => {
      if (req.url === '/jev') { routes++; jev(res, 'coder.normal'); }
      else if (req.url?.endsWith('/models')) res.end('{}');
      else completion(res, { text: 'Completed the difficult analysis.' });
    });
    const result = await runHost(f.config, { cwd: f.cwd, prompt: 'Solve a very difficult architecture problem' }, { approve: async () => false });
    expect(result.success).toBe(true);
    expect(routes).toBe(1);
    expect((await events(f.config)).some(e => e.type === 'escalation')).toBe(false);
  });

  it('keeps local reasoning profiles available within the routing budget', async () => {
    let inference = 0;
    const f = await setup((_body, req, res) => {
      if (req.url === '/jev') jev(res, 'coder.reasoning', 0.99, { 'coder.reasoning': 0.9, 'coder.normal': 0.1 });
      else if (req.url?.endsWith('/models')) res.end('{}');
      else { inference++; expect(req.url).toContain('/capable'); completion(res, { text: 'Local fallback.' }); }
    });
    f.config.policy.budget.requestUsd = 0.01;
    const result = await runHost(f.config, { cwd: f.cwd, prompt: 'Inspect code' }, { approve: async () => false });
    expect(result.capability).toBe('coder.reasoning');
    expect(inference).toBe(1);
    const receipt = JSON.parse(await readFile(result.receipts[0]!, 'utf8'));
    expect(receipt.decision.candidates.find((c: any) => c.id === 'coder.reasoning').router.filtered).toBe(false);
  });

  it('low confidence falls back within an explicit workload', async () => {
    let inference = 0;
    const f = await setup((_body, req, res) => {
      if (req.url === '/jev') jev(res, 'coder.normal', 0.1);
      else if (req.url?.endsWith('/models')) res.end('{}');
      else { inference++; completion(res, { text: 'Completed with host fallback.' }); }
    });

    const result = await runHost(f.config, { cwd: f.cwd, prompt: 'Edit code', workload: 'coder' }, { approve: async () => true });
    expect(result.success).toBe(true);
    expect(result.capability).toBe('coder.normal');
    expect(inference).toBe(1);
    expect((await events(f.config)).find(e => e.type === 'routing_fallback')).toMatchObject({ capability: 'coder.normal', reason: 'low_confidence' });
  });

  it('low confidence continues a bare hosted prompt as dialogue without asking for access', async () => {
    let inference = 0, approvals = 0;
    const f = await setup((_body, req, res) => {
      if (req.url === '/jev') jev(res, 'coder.normal', 0.1);
      else if (req.url?.endsWith('/models')) res.end('{}');
      else { inference++; completion(res, { text: 'Hi!' }); }
    });

    const result = await runHost(f.config, { cwd: f.cwd, prompt: 'hi!' }, { approve: async () => { approvals++; return true; } });
    expect(result.success).toBe(true);
    expect(result.capability?.startsWith('ask.')).toBe(true);
    expect(inference).toBe(1);
    expect(approvals).toBe(0);
    expect((await events(f.config)).find(e => e.type === 'routing_fallback')).toMatchObject({ reason: 'low_confidence' });
  });

  it('missing permissions prevent execution even when routing is confident', async () => {
    let inference = 0;
    const f = await setup((_body, req, res) => {
      if (req.url === '/jev') jev(res, 'coder.normal', 0.99);
      else if (req.url?.endsWith('/models')) res.end('{}');
      else { inference++; completion(res, {}); }
    });

    f.config.policy.permissions = [];
    const result = await runHost(f.config, { cwd: f.cwd, prompt: 'Edit code', workload: 'coder' }, { approve: async () => true });
    expect(result.success).toBe(false);
    expect(inference).toBe(0);
  });

  it('honors JevRouter confirmation and denies noninteractive execution', async () => {
    let inference = 0, approvals = 0;
    const f = await setup((_body, req, res) => {
      if (req.url === '/jev') jev(res, 'coder.normal');
      else if (req.url?.endsWith('/models')) res.end('{}');
      else { inference++; completion(res, {}); }
    });
    f.config.policy.router.confirmation_risk_levels.push('medium');
    const result = await runHost(f.config, { cwd: f.cwd, prompt: 'Edit code' }, { approve: async () => { approvals++; return false; } });
    expect(result.status).toBe('approval_denied');
    expect(approvals).toBe(1);
    expect(inference).toBe(0);
  });

  it('bounds an endless model loop and never executes a denied shell command', async () => {
    let inference = 0;
    const f = await setup((_body, req, res) => {
      if (req.url === '/jev') jev(res, 'coder.normal');
      else if (req.url?.endsWith('/models')) res.end('{}');
      else { inference++; completion(res, { tool: { name: process.platform === 'win32' ? 'powershell' : 'bash', arguments: { command: 'echo unsafe' } } }); }
    });
    const result = await runHost(f.config, { cwd: f.cwd, prompt: 'Run a command' }, { approve: async () => false });
    expect(result.status).toBe('approval_denied');
    expect(inference).toBe(1);
    expect(result.attempts).toBe(1);
  });

  it('stops repeated ineffective reads and enforces a hard turn limit', async () => {
    let calls = 0;
    const f = await setup((_body, req, res) => {
      if (req.url === '/jev') jev(res, 'coder.normal');
      else if (req.url?.endsWith('/models')) res.end('{}');
      else { calls++; completion(res, { tool: { name: 'read', arguments: { path: 'input.txt' } } }); }
    });
    await writeFile(join(f.cwd, 'input.txt'), 'same content');
    f.config.policy.limits.maxTurns = 2;
    f.config.policy.escalation.maxEscalations = 0;
    const result = await runHost(f.config, { cwd: f.cwd, prompt: 'Inspect files' }, { approve: async () => false });
    expect(result.status).toBe('turn_limit');
    expect(calls).toBe(2);
  });

  it('reports unavailable local execution without charging an execution fee', async () => {
    let calls = 0;
    const f = await setup((_body, req, res) => {
      if (req.url === '/jev') jev(res, 'coder.reasoning');
      else if (req.url?.endsWith('/models')) { res.writeHead(503); res.end('{}'); }
      else { calls++; completion(res, { noUsage: true, tool: { name: 'read', arguments: { path: 'input.txt' } } }); }
    });
    await writeFile(join(f.cwd, 'input.txt'), 'hello');
    f.config.router.maxCallUsd = 0.00001;
    f.config.policy.budget.requestUsd = 0.01;
    const result = await runHost(f.config, { cwd: f.cwd, prompt: 'Inspect files' }, { approve: async () => false });
    expect(result.status).toBe('unavailable');
    expect(calls).toBe(0);
    expect(result.spentUsd).toBeCloseTo(0.00001);
  });

  it('uses JevRouter OpenRouter Decisions adapter and preserves its envelope', async () => {
    const f = await setup((body, req, res) => {
      if (req.url === '/jev') {
        expect(body.model).toBe('~typesafe/jev-latest');
        expect(req.headers.authorization).toBe('Bearer fixture-jev-secret');
        jev(res, 'ask.normal');
      } else if (req.url?.endsWith('/models')) res.end('{}');
      else completion(res, { text: 'OpenRouter route worked.' });
    });
    f.config.router.provider = 'openrouter';
    const nativeFetch = globalThis.fetch;
    vi.stubGlobal('fetch', (input: string | URL | Request, init?: RequestInit) => nativeFetch(String(input) === 'https://openrouter.ai/api/alpha/decisions' ? f.config.router.endpoint! : input, init));
    const result = await runHost(f.config, { cwd: f.cwd, prompt: 'Explain a topic' }, { approve: async () => false });
    expect(result.success).toBe(true);
    const receipt = JSON.parse(await readFile(result.receipts[0]!, 'utf8'));
    expect(receipt.raw_jev._openrouter.provider).toBe('openrouter');
  });

  it('bounds oversized project instructions before model execution', async () => {
    let calls = 0;
    const f = await setup((_body, req, res) => {
      if (req.url === '/jev') jev(res, 'coder.normal');
      else if (req.url?.endsWith('/models')) res.end('{}');
      else { calls++; completion(res, {}); }
    });
    await writeFile(join(f.cwd, 'AGENTS.md'), 'Project guidance. '.repeat(2000));
    f.config.models.capable.contextTokens = 16384;
    f.config.policy.escalation.maxEscalations = 0;
    const result = await runHost(f.config, { cwd: f.cwd, prompt: 'Inspect code' }, { approve: async () => false });
    expect(result.status).toBe('completed');
    expect(calls).toBe(1);
    expect(result.spentUsd).toBe(0.00001);
  });

  it('blocks tools after the tool-call limit without another model turn', async () => {
    let calls = 0;
    const f = await setup((_body, req, res) => {
      if (req.url === '/jev') jev(res, 'coder.normal');
      else if (req.url?.endsWith('/models')) res.end('{}');
      else { calls++; completion(res, { tool: { name: 'read', arguments: { path: 'input.txt' } } }); }
    });
    await writeFile(join(f.cwd, 'input.txt'), 'hello');
    f.config.policy.limits.maxToolCalls = 1;
    const result = await runHost(f.config, { cwd: f.cwd, prompt: 'Inspect code' }, { approve: async () => false });
    expect(result.status).toBe('tool_limit');
    expect(calls).toBe(2);
    expect((await events(f.config)).filter(e => e.type === 'tool')).toHaveLength(1);
  });

  it('scales reasoning effort without changing the capable model identity', async () => {
    let routes = 0, approvals = 0;
    const efforts: string[] = [];
    const f = await setup((body, req, res) => {
      if (req.url === '/jev') jev(res, ['ask.normal', 'ask.reasoning', 'ask.deep'][routes++]!);
      else if (req.url?.endsWith('/models')) res.end('{}');
      else {
        efforts.push(body.reasoning_effort);
        completion(res, body.reasoning_effort === 'xhigh' ? { text: 'Answered with evidence.' } : { tool: { name: 'request_escalation', arguments: { reason: 'uncertainty' } } });
      }
    });
    const result = await runHost(f.config, { cwd: f.cwd, prompt: 'Answer a question' }, { approve: async approval => { expect(approval.kind).toBe('route'); approvals++; return true; } });
    expect(result.success).toBe(true);
    expect(result.capability).toBe('ask.deep');
    expect(approvals).toBe(0);
    expect(efforts).toEqual(['none', 'medium', 'xhigh']);
    expect(result.attempts).toBe(3);
  });

  it('exposes search only on opt-in and passes source snippets back to ask', async () => {
    let calls = 0, searches = 0;
    const f = await setup((body, req, res) => {
      if (req.url === '/jev') jev(res, 'ask.normal');
      else if (req.url?.endsWith('/models')) res.end('{}');
      else if (req.url?.startsWith('/search?')) { searches++; res.end(JSON.stringify({ results: [{ title: 'Source', url: 'https://example.com/source', content: 'Evidence' }] })); }
      else if (++calls === 1) {
        expect(body.tools.map((tool: any) => tool.function.name)).toEqual(['web_search', 'request_escalation']);
        completion(res, { tool: { name: 'web_search', arguments: { query: 'current facts' } } });
      } else { expect(JSON.stringify(body.messages)).toContain('https://example.com/source'); completion(res, { text: 'Evidence [Source](https://example.com/source)' }); }
    });
    f.config.searchUrl = new URL(f.config.router.endpoint!).origin;
    const result = await runHost(f.config, { cwd: f.cwd, prompt: 'Research current facts', web: true }, { approve: async () => false });
    expect(result.success).toBe(true);
    expect(searches).toBe(2);
  });

  it('does not retry an interrupted local request or expose provider errors', async () => {
    let calls = 0;
    const f = await setup((_body, req, res) => {
      if (req.url === '/jev') jev(res, 'ask.reasoning');
      else if (req.url?.endsWith('/models')) res.end('{}');
      else { calls++; res.writeHead(500); res.end('upstream failed fixture-cloud-secret'); }
    });
    f.config.policy.escalation.maxEscalations = 0;
    const result = await runHost(f.config, { cwd: f.cwd, prompt: 'Answer a question' }, { approve: async () => false });
    expect(result.success).toBe(false);
    expect(calls).toBe(1);
    expect(result.spentUsd).toBeCloseTo(0.00001);
    expect(JSON.stringify(await events(f.config))).not.toContain('fixture-cloud-secret');
    expect(result.text).not.toContain('fixture-cloud-secret');
  });
});
