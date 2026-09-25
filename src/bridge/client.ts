import { isIPv4 } from 'node:net';
import { WebSocket } from 'ws';
import type { TerminalPresentation } from '../presentation.js';
import type { SetupUI } from '../setup/terminal.js';
import type { ComposerContext } from '../composer.js';
import { BRIDGE_PROTOCOL, DEFAULT_BRIDGE_PORT, hostMessage, MAX_MESSAGE_BYTES, type ClientMessage } from './protocol.js';

const loopback = (host: string) => host === 'localhost' || host === '[::1]' || host === '::1' || /^127\./.test(host);
/** Tailscale addresses (100.64.0.0/10) are already end-to-end encrypted by WireGuard. */
const tailnetAddress = (host: string) => isIPv4(host) && (() => { const [a, b] = host.split('.').map(Number); return a === 100 && b! >= 64 && b! <= 127; })();

/**
 * Accepts a port, `host`, `host:port` or an http(s)/ws(s) URL. Plain ws:// is only allowed to this
 * machine or a Tailscale address; anything else must be wss://, which is what tailscale serve provides.
 */
export function bridgeUrl(target?: string): string {
  if (!target) return `ws://127.0.0.1:${DEFAULT_BRIDGE_PORT}`;
  if (/^\d+$/.test(target)) {
    const port = Number(target);
    if (port < 1 || port > 65535) throw new Error(`${target} is not a valid port.`);
    return `ws://127.0.0.1:${port}`;
  }
  const explicit = target.match(/^(https?|wss?):\/\//i)?.[1]?.toLowerCase();
  let url: URL;
  try { url = new URL(explicit ? target : `wss://${target}`); } catch { throw new Error(`Cannot understand bridge address "${target}". Use a port, host[:port] or https://host.`); }
  const local = loopback(url.hostname) || tailnetAddress(url.hostname);
  const secure = explicit ? explicit === 'https' || explicit === 'wss' : !local;
  if (!secure && !local) throw new Error('Refusing an unencrypted connection. Use https:// (tailscale serve provides it), or a Tailscale 100.x address.');
  url.protocol = secure ? 'wss:' : 'ws:';
  url.pathname = '/'; url.search = ''; url.hash = '';
  return url.toString();
}

const refusal: Record<number, string> = {
  401: 'The bridge token was refused. Use the token shown when the host first started (or run teapilot bridge host --rotate-token).',
  403: 'The host refused this connection.',
  409: 'The host already has a client connected.',
  429: 'Too many wrong tokens were sent; the host is refusing attempts for a minute.',
};

export interface BridgeClientOptions {
  url: string;
  token: string;
  ui: SetupUI & { prompt(message: string, cwd: string, context?: ComposerContext): Promise<string> };
  presentation: TerminalPresentation;
  signal: AbortSignal;
}

/** A thin terminal for a remote session. Resolves 0 when the session ends normally, 2 if the connection drops. */
export function connectBridge({ url, token, ui, presentation, signal }: BridgeClientOptions): Promise<number> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(url, { headers: { Authorization: `Bearer ${token}` }, maxPayload: MAX_MESSAGE_BYTES, handshakeTimeout: 15_000 });
    const send = (message: ClientMessage) => { if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(message)); };
    let root = '';
    let routingMode: 'hosted' | 'direct' = 'hosted';
    let ended = false;
    let queue: Promise<void> = Promise.resolve();
    const stop = () => ws.close(1000);
    signal.addEventListener('abort', stop, { once: true });

    ws.on('unexpected-response', (_request, response) => {
      response.resume();
      reject(new Error(refusal[response.statusCode ?? 0] ?? `The host answered HTTP ${response.statusCode}. Is this a teapilot bridge?`));
    });
    ws.on('error', error => reject(new Error(`Cannot reach the bridge at ${url}: ${(error as NodeJS.ErrnoException).code ?? error.message}`)));
    ws.on('close', () => {
      signal.removeEventListener('abort', stop);
      void queue.finally(() => {
        if (ended || signal.aborted) resolve(0);
        else { presentation.log('Connection to the bridge was lost. Any running turn was stopped; edits already made remain on the host.'); resolve(2); }
      });
    });
    ws.on('message', (data, binary) => {
      const parsed = binary ? undefined : hostMessage.safeParse(safeJson(data.toString()));
      if (!parsed?.success) { ws.close(1008, 'Invalid message'); return; }
      const message = parsed.data;
      // Prompts and approvals wait on the user, so handle messages strictly in order.
      queue = queue.then(async () => {
        if (message.t === 'hello') {
          if (message.version !== BRIDGE_PROTOCOL) { presentation.log('This host speaks a different bridge protocol version; update teapilot on both machines.'); ended = true; ws.close(1000); return; }
          root = message.root; routingMode = message.routingMode;
          presentation.log(`Connected. Host repository root: ${root}\nType /exit or /quit to leave; Ctrl+C disconnects and stops any running turn.`);
        } else if (message.t === 'input') {
          const text = await ui.prompt('>', message.state.cwd ?? root, { ...message.state, routingMode } as ComposerContext);
          send({ t: 'input', text });
        } else if (message.t === 'turn') presentation.start();
        else if (message.t === 'activity') presentation.setActivity(message.activity);
        else if (message.t === 'event') presentation.event(message.event);
        else if (message.t === 'log') presentation.log(message.text);
        else if (message.t === 'approval') {
          presentation.approval(message.text);
          send({ t: 'approval', id: message.id, approved: await ui.confirm('Approve this action?', signal) });
        } else if (message.t === 'answer') {
          presentation.answer(message.result.text);
          presentation.log(`\nResult: ${message.result.status}; accounted $${message.result.spentUsd.toFixed(6)}${message.result.requestId ? `; request ${message.result.requestId}` : ''}${message.result.receipts.length ? `\nReceipts: ${message.result.receipts.join(', ')}` : ''}`);
        } else if (message.t === 'end') { ended = true; presentation.log(message.reason); ws.close(1000); }
      }).catch(() => { ws.close(1000); });
    });
  });
}

function safeJson(text: string): unknown { try { return JSON.parse(text); } catch { return undefined; } }
