import { execFile, spawn, type ChildProcess } from 'node:child_process';
import { existsSync } from 'node:fs';
import { DEFAULT_BRIDGE_PORT } from './protocol.js';

export interface ExecResult { code: number; stdout: string; stderr: string }
/** Runs `tailscale <args>`; resolves code -1 when the CLI is not installed. Injected so tests never touch a real tailnet. */
export type TailscaleExec = (args: string[], signal?: AbortSignal) => Promise<ExecResult>;

const candidates = process.platform === 'win32'
  ? ['tailscale', 'C:\\Program Files\\Tailscale\\tailscale.exe']
  : process.platform === 'darwin' ? ['tailscale', '/Applications/Tailscale.app/Contents/MacOS/Tailscale'] : ['tailscale'];

export function tailscaleBinary(): string { return candidates.find(path => path === 'tailscale' || existsSync(path)) ?? 'tailscale'; }

export const tailscaleExec: TailscaleExec = async (args, signal) => {
  const attempts = [...new Set([candidates[0]!, tailscaleBinary()])];
  for (const path of attempts) {
    const result = await new Promise<ExecResult | undefined>(resolve => {
      execFile(path, args, { windowsHide: true, timeout: 15_000, signal, maxBuffer: 1024 * 1024 }, (error, stdout, stderr) => {
        if (error && (error as NodeJS.ErrnoException).code === 'ENOENT') return resolve(undefined);
        const code = (error as NodeJS.ErrnoException | null)?.code;
        resolve({ code: error ? (typeof code === 'number' ? code : 1) : 0, stdout, stderr });
      });
    });
    if (result) return result;
  }
  return { code: -1, stdout: '', stderr: 'tailscale not found' };
};

export type TailscaleState =
  | { kind: 'missing' }
  | { kind: 'needs-login' | 'stopped' | 'starting' | 'unknown'; detail?: string }
  | { kind: 'running'; dnsName: string };

const json = (text: string): any => { try { return JSON.parse(text); } catch { return undefined; } };

export async function tailscaleState(exec: TailscaleExec, signal?: AbortSignal): Promise<TailscaleState> {
  const result = await exec(['status', '--json'], signal);
  if (result.code === -1) return { kind: 'missing' };
  const status = json(result.stdout);
  // A stopped or logged-out daemon still prints status JSON on most versions; anything else is unknown.
  if (!status) return { kind: 'unknown', detail: result.stderr.trim().split('\n')[0] };
  const dnsName = String(status.Self?.DNSName ?? '').replace(/\.$/, '');
  if (status.BackendState === 'Running' && dnsName) return { kind: 'running', dnsName };
  if (status.BackendState === 'NeedsLogin') return { kind: 'needs-login' };
  if (status.BackendState === 'Stopped') return { kind: 'stopped' };
  if (status.BackendState === 'Starting') return { kind: 'starting' };
  return { kind: 'unknown' };
}

export interface ServeState {
  /** Whether this port is already published, another target is, or nothing is. */
  mapping: 'this' | 'other' | 'none' | 'unknown';
  /** True when Funnel (the public internet) is enabled for the served name. */
  funnel: boolean;
}

export async function serveState(exec: TailscaleExec, port: number, signal?: AbortSignal): Promise<ServeState> {
  const result = await exec(['serve', 'status', '--json'], signal);
  const status = result.code === 0 ? json(result.stdout || '{}') : undefined;
  if (!status || typeof status !== 'object') return { mapping: 'unknown', funnel: false };
  // Foreground `tailscale serve` sessions (another terminal) keep their config under Foreground, not the top level.
  const configs: any[] = [status, ...Object.values<any>(status.Foreground ?? {})];
  // The bridge is published on the HTTPS port matching its own, so only a site on that port can conflict.
  const sites = configs.flatMap(config => Object.entries<any>(config?.Web ?? {})).filter(([name]) => name.endsWith(`:${port}`)).map(([, site]) => site);
  const proxies: string[] = sites.flatMap(site => Object.values<any>(site?.Handlers ?? {}).map(handler => String(handler?.Proxy ?? '')));
  const funnel = configs.some(config => Object.values(config?.AllowFunnel ?? {}).some(Boolean));
  const mapping = proxies.some(proxy => new RegExp(`:${port}(/|$)`).test(proxy)) ? 'this' : sites.length ? 'other' : 'none';
  return { mapping, funnel };
}

export const serveArgs = (port: number, persistent = true) => ['serve', ...(persistent ? ['--bg'] : []), `--https=${port}`, String(port)];
export const serveCommand = (port: number, persistent = true) => `tailscale ${serveArgs(port, persistent).join(' ')}`;

/** Lines telling the user how to reach this host from their tailnet, given what is already configured. */
export async function tailnetTip(exec: TailscaleExec, port: number, signal?: AbortSignal): Promise<string[]> {
  const state = await tailscaleState(exec, signal);
  if (state.kind === 'missing') return ['Tailscale: the tailscale command was not found. Install Tailscale, then run: ' + serveCommand(port)];
  if (state.kind !== 'running') return [`Tailscale: ${state.kind === 'needs-login' ? 'not logged in' : state.kind === 'stopped' ? 'stopped' : 'status unknown'}. Run tailscale up (or restart with --ts), then: ${serveCommand(port)}`];
  const serve = await serveState(exec, port, signal);
  const url = `https://${state.dnsName}:${port}`;
  const lines: string[] = [];
  if (serve.mapping === 'this') lines.push(`Tailscale: already serving port ${port} at ${url}`);
  else if (serve.mapping === 'other') lines.push(`Tailscale: ${state.dnsName} is serving something else on port ${port}. Publish the bridge with: ${serveCommand(port)} (this replaces the existing mapping)`);
  else lines.push(`Tailscale: connected as ${state.dnsName}. Publish to your tailnet with: ${serveCommand(port)}`);
  if (serve.funnel) lines.push('Warning: Tailscale Funnel is enabled for this machine, which exposes served ports to the public internet. Bridge access still needs the token, see: tailscale funnel status');
  lines.push(`Connect from another device on your tailnet: teapilot bridge connect ${state.dnsName}${port === DEFAULT_BRIDGE_PORT ? '' : `:${port}`}`);
  return lines;
}

/**
 * `--ts`: make sure the machine is logged in, then publish the port with a foreground `tailscale serve`
 * that ends with this process, so nothing stays exposed after the host stops.
 */
export async function publishToTailnet(options: {
  exec: TailscaleExec; port: number; signal: AbortSignal; log: (text: string) => void;
  login: () => Promise<number>;
  spawnServe?: (port: number) => ChildProcess;
}): Promise<{ url?: string; stop(): void }> {
  const { exec, port, signal, log } = options;
  let state = await tailscaleState(exec, signal);
  if (state.kind === 'missing') throw new Error('--ts needs the Tailscale CLI, which was not found. Install Tailscale first.');
  if (state.kind === 'needs-login' || state.kind === 'stopped') {
    log('Tailscale is not connected. Running: tailscale up');
    if (await options.login() !== 0) throw new Error('tailscale up did not complete. Fix Tailscale, then retry.');
    state = await tailscaleState(exec, signal);
  }
  if (state.kind !== 'running') throw new Error('Tailscale is not running yet. Check tailscale status, then retry.');
  const url = `https://${state.dnsName}:${port}`;
  const existing = await serveState(exec, port, signal);
  if (existing.mapping === 'this') { log(`Tailscale is already serving port ${port} at ${url}; leaving it as it is.`); return { url, stop() {} }; }
  if (existing.mapping === 'other') throw new Error(`Tailscale is already serving something else on ${state.dnsName}:${port}. Not replacing it; to publish this port yourself run: ${serveCommand(port)}`);
  log(`Running: ${serveCommand(port, false)} (stops when this host stops)`);
  const child = (options.spawnServe ?? (value => spawn(tailscaleBinary(), serveArgs(value, false), { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] })))(port);
  const relay = (data: Buffer) => { for (const line of data.toString().split(/\r?\n/)) if (line.trim()) log(`tailscale: ${line.trim()}`); };
  child.stdout?.on('data', relay); child.stderr?.on('data', relay);
  let exited = false;
  child.on('exit', code => { exited = true; if (!signal.aborted) log(`tailscale serve exited (code ${code}). The bridge is no longer reachable from your tailnet.`); });
  child.on('error', error => log(`tailscale serve failed: ${error.message}`));
  signal.addEventListener('abort', () => child.kill(), { once: true });
  // Serve may wait for the user to enable it in the admin console; the relayed output shows the link.
  for (let attempt = 0; attempt < 20 && !signal.aborted; attempt++) {
    if ((await serveState(exec, port, signal)).mapping === 'this') return { url, stop: () => void child.kill() };
    if (exited) return { stop() {} };
    await new Promise(resolve => setTimeout(resolve, 500));
  }
  log('Tailscale has not published the port yet. If it printed a link above, open it to enable Serve, then keep this running.');
  return { url, stop: () => void child.kill() };
}
