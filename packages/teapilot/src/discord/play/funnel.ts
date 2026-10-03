import { spawn, type ChildProcess } from 'node:child_process';
import { setTimeout as delay } from 'node:timers/promises';
import { tailscaleBinary, tailscaleExec, tailscaleState, type TailscaleExec } from '../../bridge/tailscale.js';

interface ServeConfig {
  TCP?: Record<string, unknown>;
  Web?: Record<string, { Handlers?: Record<string, { Proxy?: string }> }>;
  AllowFunnel?: Record<string, boolean>;
  Foreground?: Record<string, ServeConfig>;
}

/** Reuse a matching public Funnel, or own a foreground one. Existing services are never replaced. */
export async function publishPlay(options: {
  port: number; signal?: AbortSignal; log(text: string): void; changed(origin?: string): void;
  exec?: TailscaleExec; start?: (args: string[]) => ChildProcess;
}): Promise<() => Promise<void>> {
  const exec = options.exec ?? tailscaleExec;
  const status = async () => {
    const result = await exec(['serve', 'status', '--json'], options.signal);
    if (result.code !== 0) throw new Error('could not read tailscale serve status');
    const config = JSON.parse(result.stdout || '{}') as ServeConfig;
    if (!config || typeof config !== 'object') throw new Error('could not read tailscale serve status');
    return [config, ...Object.values(config.Foreground ?? {})];
  };
  const state = await tailscaleState(exec, options.signal);
  if (state.kind === 'missing') throw new Error('tailscale was not found, so nothing was published');
  if (state.kind !== 'running') throw new Error(`tailscale is ${state.kind.replace('-', ' ')}, so nothing was published`);
  const publicPort = 10000;
  const site = `${state.dnsName}:${publicPort}`;
  const origin = `https://${site}`;
  const published = (config: ServeConfig) => config.AllowFunnel?.[site] && config.Web?.[site]?.Handlers?.['/']?.Proxy === `http://127.0.0.1:${options.port}`;
  const existing = await status();
  options.signal?.throwIfAborted();
  if (existing.some(published)) {
    options.changed(origin);
    return async () => { options.changed(); };
  }
  if (existing.some(config => config.TCP?.[String(publicPort)] || Object.keys(config.Web ?? {}).some(name => name.endsWith(`:${publicPort}`)))) throw new Error(`tailscale port ${publicPort} is already in use`);
  options.signal?.throwIfAborted();
  const child = (options.start ?? (args => spawn(tailscaleBinary(), args, { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] })))(['funnel', `--https=${publicPort}`, String(options.port)]);
  let ended = false, stopping = false;
  const exited = new Promise<void>(resolve => {
    const end = () => { ended = true; options.changed(); if (!stopping) options.log('browser play: funnel stopped.'); resolve(); };
    child.once('exit', end); child.once('error', end);
  });
  const abort = () => { stopping = true; child.kill(); };
  options.signal?.addEventListener('abort', abort, { once: true });
  const stop = async () => {
    stopping = true; options.signal?.removeEventListener('abort', abort);
    if (!ended) { child.kill(); await Promise.race([exited, delay(3000, undefined, { ref: false })]); }
    options.changed();
  };
  const relay = (chunk: Buffer) => { for (const line of chunk.toString().split(/\r?\n/)) if (line.trim()) options.log(`funnel: ${line.trim()}`); };
  child.stdout?.on('data', relay); child.stderr?.on('data', relay);
  try {
    for (let attempt = 0; attempt < 20 && !ended; attempt++) {
      options.signal?.throwIfAborted();
      const configs = await status();
      if (!ended && configs.some(published)) {
        options.changed(origin); return stop;
      }
      await delay(250, undefined, { signal: options.signal });
    }
    throw new Error('funnel is not ready; check the tailscale setup link above');
  } catch (error) { await stop(); throw error; }
}
