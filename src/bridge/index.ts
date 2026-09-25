import { spawn } from 'node:child_process';
import { realpath } from 'node:fs/promises';
import { loadConfig } from '../config.js';
import { terminalHandoff } from '../activity.js';
import type { TerminalPresentation } from '../presentation.js';
import type { ComposerContext } from '../composer.js';
import type { SetupUI } from '../setup/terminal.js';
import { loadToken, tokenPath } from './auth.js';
import { bridgeUrl, connectBridge } from './client.js';
import { startBridgeHost } from './host.js';
import { DEFAULT_BRIDGE_PORT, TOKEN_ENV } from './protocol.js';
import { publishToTailnet, tailnetTip, tailscaleBinary, tailscaleExec, type TailscaleExec } from './tailscale.js';

export const bridgeActions = ['host', 'connect'] as const;
type BridgeUI = SetupUI & { prompt?(message: string, cwd: string, context?: ComposerContext): Promise<string> };
export interface BridgeCommand {
  directory: string;
  cwd: string;
  ui: BridgeUI;
  presentation: TerminalPresentation;
  signal: AbortSignal;
  /** `--ts`: log in to and publish through Tailscale for the user. */
  tailscale?: boolean;
  rotateToken?: boolean;
  exec?: TailscaleExec;
  env?: NodeJS.ProcessEnv;
}

export function bridgePort(text: string | undefined): number {
  if (text === undefined) return DEFAULT_BRIDGE_PORT;
  const port = Number(text);
  if (!/^\d+$/.test(text) || port < 1 || port > 65535) throw new Error(`${text} is not a valid port.`);
  return port;
}

/** teapilot bridge host|connect — reach this computer's teapilot from another device on your tailnet. */
export async function bridge(action: string, target: string | undefined, options: BridgeCommand): Promise<boolean> {
  if (action === 'host') return hostBridge(bridgePort(target), options);
  if (action === 'connect') return connect(target, options);
  throw new Error(`Use teapilot bridge ${bridgeActions.join('|')}.`);
}

async function hostBridge(port: number, { directory, cwd, ui, signal, tailscale, rotateToken, exec = tailscaleExec, env = process.env }: BridgeCommand): Promise<boolean> {
  const config = await loadConfig(directory, { ...env });
  const root = await realpath(cwd);
  const secrets = [config.router.apiKey, ...Object.values(config.secrets)].filter((value): value is string => Boolean(value));
  const redact = (text: string) => secrets.reduce((result, secret) => result.split(secret).join('[REDACTED]'), text);
  const log = (text: string) => ui.log(`${new Date().toLocaleTimeString()} ${redact(text)}`);
  const { token, created } = await loadToken(config.stateDir, rotateToken);
  const host = await startBridgeHost({ config, root, port, token, signal, log, redact });
  ui.log(`Bridge listening on 127.0.0.1:${host.port} for ${root}`);
  ui.log(created ? `New bridge token (shown once, also stored in ${tokenPath(config.stateDir)}):\n  ${token}` : `Bridge token: stored in ${tokenPath(config.stateDir)}; run with --rotate-token to replace it.`);
  ui.log(`Anyone with the token who can reach this port can approve actions on this computer. Keep it private.`);
  let published: { stop(): void } | undefined;
  try {
    if (tailscale) {
      const result = await publishToTailnet({ exec, port: host.port, signal, log, login: () => terminalHandoff(ui, () => new Promise<number>(resolve => {
        const child = spawn(tailscaleBinary(), ['up'], { stdio: 'inherit', windowsHide: true });
        child.on('error', () => resolve(1)); child.on('exit', code => resolve(code ?? 1));
      })) });
      published = result;
      if (result.url) ui.log(`Reachable on your tailnet at ${result.url}\nConnect with: teapilot bridge connect ${result.url.replace('https://', '')}`);
    } else for (const line of await tailnetTip(exec, host.port, signal)) ui.log(line);
    ui.log('Press Ctrl+C to stop.');
    if (!signal.aborted) await new Promise(resolve => signal.addEventListener('abort', resolve, { once: true }));
  } finally {
    published?.stop();
    log('Stopping: pending approvals are denied.');
    await host.close();
  }
  return true;
}

async function connect(target: string | undefined, { ui, presentation, signal, env = process.env }: BridgeCommand): Promise<boolean> {
  if (!ui.prompt) throw new Error('teapilot bridge connect needs an interactive terminal.');
  const url = bridgeUrl(target);
  const token = env[TOKEN_ENV]?.trim() || (await ui.input('Bridge token', '', true, signal)).trim();
  if (!token) throw new Error(`No bridge token. Set ${TOKEN_ENV} or enter it when asked.`);
  return await connectBridge({ url, token, ui: { ...ui, prompt: ui.prompt.bind(ui) }, presentation, signal }) === 0;
}
