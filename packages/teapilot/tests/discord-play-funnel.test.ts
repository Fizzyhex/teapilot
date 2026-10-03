import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import type { ChildProcess } from 'node:child_process';
import { expect, it, vi } from 'vitest';
import { publishPlay } from '../src/discord/play/funnel.js';

function fixture(existing: unknown = {}) {
  const child = Object.assign(new EventEmitter(), { stdout: new PassThrough(), stderr: new PassThrough(), kill: vi.fn(() => { child.emit('exit', 0); return true; }) });
  let started = false;
  const exec = vi.fn(async (args: string[]) => ({ code: 0, stderr: '', stdout: JSON.stringify(args[0] === 'status' ? { BackendState: 'Running', Self: { DNSName: 'tea.example.ts.net.' } } : started ? {
    Foreground: { ours: { TCP: { '10000': { HTTPS: true } }, Web: { 'tea.example.ts.net:10000': { Handlers: { '/': { Proxy: 'http://127.0.0.1:2048' } } } }, AllowFunnel: { 'tea.example.ts.net:10000': true } } },
  } : existing) }));
  const start = vi.fn(() => { started = true; return child as unknown as ChildProcess; });
  const changed = vi.fn(), log = vi.fn();
  return { child, exec, start, changed, log, port: 2048 };
}

it('publishes the local port with a foreground process and shuts down only that process', async () => {
  const f = fixture();
  const stop = await publishPlay(f);
  expect(f.start).toHaveBeenCalledWith(['funnel', '--https=10000', '2048']);
  expect(f.changed).toHaveBeenCalledWith('https://tea.example.ts.net:10000');
  await stop();
  expect(f.child.kill).toHaveBeenCalledOnce();
  expect(f.exec.mock.calls.every(([args]) => args.includes('status'))).toBe(true);
});

it.each([
  { TCP: { '10000': { HTTPS: true } } },
  { Foreground: { another: { Web: { 'tea.example.ts.net:10000': { Handlers: { '/': { Proxy: 'http://127.0.0.1:9000' } } } } } } },
])('leaves an existing publication untouched', async config => {
  const f = fixture(config);
  await expect(publishPlay(f)).rejects.toThrow('already in use');
  expect(f.start).not.toHaveBeenCalled();
});

const publication = (port = 2048, publicAccess = true) => ({
  TCP: { '10000': { HTTPS: true } },
  Web: { 'tea.example.ts.net:10000': { Handlers: { '/': { Proxy: `http://127.0.0.1:${port}` } } } },
  AllowFunnel: { 'tea.example.ts.net:10000': publicAccess },
});

it.each([publication(), { Foreground: { another: publication() } }])('reuses an existing public Funnel without starting or stopping it', async config => {
  const f = fixture(config);
  const stop = await publishPlay(f);
  expect(f.changed).toHaveBeenCalledWith('https://tea.example.ts.net:10000');
  expect(f.start).not.toHaveBeenCalled();
  await stop();
  expect(f.child.kill).not.toHaveBeenCalled();
  expect(f.exec.mock.calls.every(([args]) => args.includes('status'))).toBe(true);
  expect(f.changed).toHaveBeenLastCalledWith();
});

it.each([publication(9000), publication(2048, false)])('does not reuse an unrelated Funnel or a tailnet-only Serve', async config => {
  const f = fixture(config);
  await expect(publishPlay(f)).rejects.toThrow('already in use');
  expect(f.changed).not.toHaveBeenCalled();
  expect(f.start).not.toHaveBeenCalled();
});

it('stops the owned process when the bot aborts', async () => {
  const f = fixture(); const controller = new AbortController();
  const stop = await publishPlay({ ...f, signal: controller.signal });
  controller.abort();
  expect(f.child.kill).toHaveBeenCalledOnce();
  expect(f.changed).toHaveBeenLastCalledWith();
  await stop();
});

it('can publish on 10000 while another service holds 443', async () => {
  const f = fixture({ TCP: { '443': { HTTPS: true } }, Web: { 'tea.example.ts.net:443': { Handlers: { '/': { Proxy: 'http://127.0.0.1:9000' } } } } });
  const stop = await publishPlay(f);
  expect(f.start).toHaveBeenCalledWith(['funnel', '--https=10000', '2048']);
  expect(f.changed).toHaveBeenCalledWith('https://tea.example.ts.net:10000');
  await stop();
});
