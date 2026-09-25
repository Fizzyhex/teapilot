import { afterEach, expect, it } from 'vitest';
import { WebSocket } from 'ws';
import { mkdtemp, readFile, realpath, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fixture } from './helpers.js';
import { startBridgeHost, type BridgeHost } from '../src/bridge/host.js';
import { bridgeUrl } from '../src/bridge/client.js';
import { bridgePort } from '../src/bridge/index.js';
import { loadToken, tokenMatches, FailureLimiter } from '../src/bridge/auth.js';
import { publishToTailnet, serveState, tailnetTip, tailscaleState, type TailscaleExec } from '../src/bridge/tailscale.js';
import type { HostResult } from '../src/host.js';

const cleanup: Array<() => Promise<void>> = [];
afterEach(async () => { for (const run of cleanup.splice(0).reverse()) await run(); });
const TOKEN = 'a'.repeat(43);
const result = (text: string): HostResult => ({ requestId: 'r1', success: true, status: 'completed', text, spentUsd: 0.5, receipts: [], attempts: 1 });

async function start(run?: Parameters<typeof startBridgeHost>[0]['run'], extra: Partial<Parameters<typeof startBridgeHost>[0]> = {}) {
  const f = await fixture(); cleanup.push(f.cleanup);
  const controller = new AbortController();
  const logs: string[] = [];
  const host: BridgeHost = await startBridgeHost({ config: f.config, root: f.cwd, port: 0, token: TOKEN, signal: controller.signal, log: text => logs.push(text), run, ...extra });
  cleanup.push(async () => { controller.abort(); await host.close(); });
  return { host, logs, cwd: f.cwd };
}

/** A raw protocol client that records every message the host sends. */
async function client(port: number, token = TOKEN, headers: Record<string, string> = {}) {
  const ws = new WebSocket(`ws://127.0.0.1:${port}`, { headers: { ...(token ? { Authorization: `Bearer ${token}` } : {}), ...headers } });
  const messages: any[] = [];
  const waiters: Array<() => void> = [];
  ws.on('message', data => { messages.push(JSON.parse(data.toString())); waiters.splice(0).forEach(wake => wake()); });
  const rejected = new Promise<number>(resolve => ws.on('unexpected-response', (_request, response) => { response.resume(); resolve(response.statusCode ?? 0); }));
  ws.on('error', () => {});
  ws.on('close', () => waiters.splice(0).forEach(wake => wake()));
  cleanup.push(async () => ws.terminate());
  const next = async (type: string): Promise<any> => {
    for (;;) {
      const index = messages.findIndex(message => message.t === type);
      if (index >= 0) return messages.splice(index, 1)[0];
      if (ws.readyState === WebSocket.CLOSED) throw new Error(`closed while waiting for ${type}`);
      await new Promise<void>(resolve => { waiters.push(resolve); setTimeout(resolve, 5000); });
    }
  };
  return { ws, rejected, next, send: (value: unknown) => ws.send(JSON.stringify(value)) };
}

it('parses connect targets and refuses unencrypted remote hosts', () => {
  expect(bridgeUrl()).toBe('ws://127.0.0.1:8377');
  expect(bridgeUrl('9000')).toBe('ws://127.0.0.1:9000');
  expect(bridgeUrl('box.tail1234.ts.net')).toBe('wss://box.tail1234.ts.net/');
  expect(bridgeUrl('https://box.tail1234.ts.net')).toBe('wss://box.tail1234.ts.net/');
  expect(bridgeUrl('100.101.102.103:8377')).toBe('ws://100.101.102.103:8377/');
  expect(bridgeUrl('localhost:9000')).toBe('ws://localhost:9000/');
  expect(() => bridgeUrl('http://example.com')).toThrow('unencrypted');
  expect(() => bridgeUrl('ws://8.8.8.8:8377')).toThrow('unencrypted');
  expect(() => bridgePort('70000')).toThrow('valid port');
  expect(bridgePort(undefined)).toBe(8377);
});

it('creates, reuses and rotates a private token', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'teapilot-token-')); cleanup.push(() => rm(dir, { recursive: true, force: true }));
  const first = await loadToken(dir);
  expect(first.created).toBe(true);
  expect(first.token).toMatch(/^[A-Za-z0-9_-]{43}$/);
  if (process.platform !== 'win32') expect((await stat(join(dir, 'bridge-token'))).mode & 0o077).toBe(0);
  expect(await loadToken(dir)).toEqual({ token: first.token, created: false });
  expect((await readFile(join(dir, 'bridge-token'), 'utf8')).trim()).toBe(first.token);
  const rotated = await loadToken(dir, true);
  expect(rotated.created).toBe(true);
  expect(rotated.token).not.toBe(first.token);
  expect(tokenMatches('abc', 'abc')).toBe(true);
  expect(tokenMatches('abc', 'abd')).toBe(false);
  expect(tokenMatches('abc', undefined)).toBe(false);
  let now = 0; const limiter = new FailureLimiter(2, 1000, () => now);
  limiter.fail(); limiter.fail(); expect(limiter.blocked()).toBe(true);
  now = 1001; expect(limiter.blocked()).toBe(false);
});

it('rejects missing or wrong tokens, browser origins and a second client', async () => {
  const { host, logs } = await start(async () => result('x'));
  expect(await (await client(host.port, 'wrong')).rejected).toBe(401);
  expect(await (await client(host.port, '')).rejected).toBe(401);
  expect(await (await client(host.port, TOKEN, { Origin: 'https://evil.example' })).rejected).toBe(403);
  expect(logs.some(line => line.includes('wrong token'))).toBe(true);
  const first = await client(host.port);
  expect((await first.next('hello')).version).toBe(1);
  expect(await (await client(host.port)).rejected).toBe(409);
});

it('locks out repeated wrong tokens even for the right one', async () => {
  const { host } = await start(async () => result('x'));
  for (let attempt = 0; attempt < 5; attempt++) expect(await (await client(host.port, 'wrong')).rejected).toBe(401);
  expect(await (await client(host.port)).rejected).toBe(429);
});

it('runs a session: input, a turn, and a fixed root', async () => {
  const seen: any[] = [];
  const { host, cwd } = await start(async (_config, request, dependencies) => {
    seen.push(request); dependencies.onEvent?.({ type: 'text', text: 'hi' }); return result(`echo: ${request.prompt}`);
  });
  const c = await client(host.port);
  expect((await c.next('hello')).root).toBe(await realpath(cwd));
  await c.next('input');
  c.send({ t: 'input', text: '/cd ..' });
  expect((await c.next('log')).text).toContain('fixed');
  await c.next('input');
  c.send({ t: 'input', text: 'hello there' });
  await c.next('turn');
  expect((await c.next('event')).event.text).toBe('hi');
  expect((await c.next('answer')).result.text).toBe('echo: hello there');
  expect(seen[0].mode).toBe('chat');
  expect((await c.next('input')).state.spentUsd).toBe(0.5);
  c.send({ t: 'input', text: '/exit' });
  expect((await c.next('end')).reason).toBe('Session ended.');
});

it('forwards approvals to the client and denies them on disconnect', async () => {
  const approvals: boolean[] = [];
  let finished!: () => void; const done = new Promise<void>(resolve => { finished = resolve; });
  const { host } = await start(async (_config, _request, dependencies) => {
    approvals.push(await dependencies.approve({ kind: 'shell', summary: 'Run ls', details: 'ls -la' }));
    approvals.push(await dependencies.approve({ kind: 'shell', summary: 'Run rm', details: 'rm x' }));
    finished(); return result('done');
  });
  const c = await client(host.port);
  await c.next('input'); c.send({ t: 'input', text: 'go' });
  const first = await c.next('approval');
  expect(first.text).toContain('Run ls');
  c.send({ t: 'approval', id: first.id, approved: true });
  const second = await c.next('approval');
  c.ws.close();
  await done;
  expect(approvals).toEqual([true, false]);
  expect(second.id).not.toBe(first.id);
});

it('aborts the running turn when the client disconnects', async () => {
  let aborted!: () => void; const stopped = new Promise<void>(resolve => { aborted = resolve; });
  let started!: () => void; const running = new Promise<void>(resolve => { started = resolve; });
  const { host } = await start((_config, request) => new Promise((_resolve, reject) => {
    started(); request.signal?.addEventListener('abort', () => { aborted(); reject(new Error('aborted')); });
  }));
  const c = await client(host.port);
  await c.next('input'); c.send({ t: 'input', text: 'long task' });
  await running; c.ws.close();
  await stopped;
});

it('redacts secrets and closes on a malformed client message', async () => {
  const { host } = await start(async () => result('key is s3cr3t-value'), { redact: text => text.split('s3cr3t-value').join('[REDACTED]') });
  const c = await client(host.port);
  await c.next('input'); c.send({ t: 'input', text: 'tell me' });
  expect((await c.next('answer')).result.text).toBe('key is [REDACTED]');
  const closed = new Promise<number>(resolve => c.ws.once('close', code => resolve(code)));
  c.ws.send('{"t":"cd","path":"/"}');
  expect(await closed).toBe(1008);
});

// --- Tailscale ---------------------------------------------------------------------------------

const status = (state: string, dns = 'box.tail1234.ts.net.') => JSON.stringify({ BackendState: state, Self: { DNSName: dns } });
const missing: TailscaleExec = async () => ({ code: -1, stdout: '', stderr: '' });
function fake(replies: Record<string, { code?: number; stdout?: string }>): TailscaleExec {
  return async args => {
    const reply = replies[args.join(' ')];
    return reply ? { code: reply.code ?? 0, stdout: reply.stdout ?? '', stderr: '' } : { code: 1, stdout: '', stderr: 'unexpected' };
  };
}
const serving = (proxy: string, funnel = false) => JSON.stringify({ Web: { 'box.tail1234.ts.net:443': { Handlers: { '/': { Proxy: proxy } } } }, ...(funnel ? { AllowFunnel: { 'box.tail1234.ts.net:443': true } } : {}) });

it('reads Tailscale login and serve state', async () => {
  expect(await tailscaleState(missing)).toEqual({ kind: 'missing' });
  expect(await tailscaleState(fake({ 'status --json': { stdout: status('Running') } }))).toEqual({ kind: 'running', dnsName: 'box.tail1234.ts.net' });
  expect((await tailscaleState(fake({ 'status --json': { stdout: status('NeedsLogin', '') } }))).kind).toBe('needs-login');
  expect((await serveState(fake({ 'serve status --json': { stdout: '{}' } }), 8377)).mapping).toBe('none');
  expect((await serveState(fake({ 'serve status --json': { stdout: serving('http://127.0.0.1:8377') } }), 8377)).mapping).toBe('this');
  expect((await serveState(fake({ 'serve status --json': { stdout: serving('http://127.0.0.1:3000') } }), 8377)).mapping).toBe('other');
  expect((await serveState(fake({ 'serve status --json': { code: 1 } }), 8377)).mapping).toBe('unknown');
});

it('tips the exact serve command, and notices when it is already running or public', async () => {
  const idle = await tailnetTip(fake({ 'status --json': { stdout: status('Running') }, 'serve status --json': { stdout: '{}' } }), 8377);
  expect(idle.join('\n')).toContain('tailscale serve --bg 8377');
  expect(idle.join('\n')).toContain('teapilot bridge connect box.tail1234.ts.net');
  const running = await tailnetTip(fake({ 'status --json': { stdout: status('Running') }, 'serve status --json': { stdout: serving('http://127.0.0.1:8377') } }), 8377);
  expect(running[0]).toContain('already serving port 8377 at https://box.tail1234.ts.net');
  const funnel = await tailnetTip(fake({ 'status --json': { stdout: status('Running') }, 'serve status --json': { stdout: serving('http://127.0.0.1:8377', true) } }), 8377);
  expect(funnel.join('\n')).toContain('Funnel');
  expect((await tailnetTip(missing, 8377))[0]).toContain('not found');
});

it('--ts leaves an existing mapping alone, refuses to replace another, and logs in only when needed', async () => {
  const controller = new AbortController(); const logs: string[] = [];
  const opts = { port: 8377, signal: controller.signal, log: (text: string) => logs.push(text), login: async () => 0 };
  const same = fake({ 'status --json': { stdout: status('Running') }, 'serve status --json': { stdout: serving('http://127.0.0.1:8377') } });
  expect((await publishToTailnet({ ...opts, exec: same })).url).toBe('https://box.tail1234.ts.net');
  expect(logs.join('\n')).toContain('leaving it as it is');
  const other = fake({ 'status --json': { stdout: status('Running') }, 'serve status --json': { stdout: serving('http://127.0.0.1:3000') } });
  await expect(publishToTailnet({ ...opts, exec: other })).rejects.toThrow('Not replacing');
  await expect(publishToTailnet({ ...opts, exec: missing })).rejects.toThrow('not found');
  let logins = 0;
  const states = [status('NeedsLogin', ''), status('Running')];
  const relog: TailscaleExec = async args => args[0] === 'status' ? { code: 0, stdout: states.shift() ?? status('Running'), stderr: '' } : { code: 0, stdout: serving('http://127.0.0.1:8377'), stderr: '' };
  await publishToTailnet({ ...opts, exec: relog, login: async () => { logins++; return 0; } });
  expect(logins).toBe(1);
  await expect(publishToTailnet({ ...opts, exec: fake({ 'status --json': { stdout: status('NeedsLogin', '') } }), login: async () => 1 })).rejects.toThrow('did not complete');
});

it('needs no token by default, but still refuses browsers and a second client', async () => {
  const { host, logs } = await start(async () => result('x'), { token: undefined });
  const first = await client(host.port, '');
  expect((await first.next('hello')).version).toBe(1);
  expect(await (await client(host.port, '')).rejected).toBe(409);
  first.ws.close();
  expect(await (await client(host.port, '', { Origin: 'https://evil.example' })).rejected).toBe(403);
  expect(logs.some(line => line.includes('wrong token'))).toBe(false);
});
