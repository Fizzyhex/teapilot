import { randomUUID } from 'node:crypto';
import { createServer } from 'node:http';
import type { Duplex } from 'node:stream';
import { WebSocket, WebSocketServer, type RawData } from 'ws';
import type { Config } from '../config.js';
import { SessionGrants } from '../execution/grants.js';
import type { Approval, Approve } from '../execution/policy.js';
import { runHost, type HostDependencies, type HostRequest, type HostResult } from '../host.js';
import { runSession } from '../chat.js';
import type { TeachatService } from '../teachat/service.js';
import { headlessTeachat } from '../teachat/session.js';
import { bearer, FailureLimiter, tokenMatches } from './auth.js';
import { BRIDGE_PROTOCOL, clientMessage, MAX_MESSAGE_BYTES, type HostMessage } from './protocol.js';

export interface BridgeHostOptions {
  config: Config;
  root: string;
  port: number;
  /** When set, clients must present it. Without one, access rests on the loopback bind and whatever publishes the port (tailscale serve). */
  token?: string;
  signal: AbortSignal;
  log: (text: string) => void;
  redact?: (text: string) => string;
  /** Loopback by default: a tunnel such as tailscale serve connects from this machine. */
  host?: string;
  run?: (config: Config, request: HostRequest, dependencies: HostDependencies) => Promise<HostResult>;
  approvalTimeoutMs?: number;
  /** Gossips while the session is idle; turns preempt it. */
  teachat?: TeachatService;
}

export interface BridgeHost { port: number; close(): Promise<void> }

const closed = () => Object.assign(new Error('closed'), { name: 'TerminalClosedError' });
const HEARTBEAT_MS = 20_000;

/**
 * Serves one authenticated teapilot session at a time. The host owns the repository root, grants,
 * configuration and secrets; the client only sends lines of input and approval answers.
 */
export async function startBridgeHost(options: BridgeHostOptions): Promise<BridgeHost> {
  const { config, root, token, log } = options;
  const redact = options.redact ?? (text => text);
  const host = options.run ?? runHost;
  const run: typeof host = (config, request, dependencies) => options.teachat ? options.teachat.work(() => host(config, request, dependencies)) : host(config, request, dependencies);
  const limiter = new FailureLimiter();
  const sockets = new Set<WebSocket>();
  const wss = new WebSocketServer({ noServer: true, maxPayload: MAX_MESSAGE_BYTES });

  const server = createServer((_request, response) => { response.writeHead(404).end(); });
  const refuse = (socket: Duplex, status: number, reason: string) => {
    socket.end(`HTTP/1.1 ${status} ${reason}\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`);
  };
  server.on('upgrade', (request, socket, head) => {
    // Browsers attach Origin; a page in the user's browser must never be able to drive this.
    if (request.headers.origin !== undefined) return refuse(socket, 403, 'Forbidden');
    if (token !== undefined && limiter.blocked()) return refuse(socket, 429, 'Too Many Requests');
    if (token !== undefined && !tokenMatches(token, bearer(request.headers.authorization))) {
      limiter.fail(); log('Refused a connection with a missing or wrong token.');
      return refuse(socket, 401, 'Unauthorized');
    }
    if (sockets.size) return refuse(socket, 409, 'Conflict');
    wss.handleUpgrade(request, socket, head, ws => { sockets.add(ws); void serveSession(ws); });
  });

  async function serveSession(ws: WebSocket): Promise<void> {
    const controller = new AbortController();
    const signal = AbortSignal.any([controller.signal, options.signal]);
    const send = (message: HostMessage) => { if (ws.readyState === WebSocket.OPEN) ws.send(redact(JSON.stringify(message))); };
    const inbox: string[] = [];
    let waiting: ((text: string) => void) | undefined;
    const approvals = new Map<string, (approved: boolean) => void>();
    let alive = true;
    ws.on('pong', () => { alive = true; });
    const heartbeat = setInterval(() => { if (!alive) { ws.terminate(); return; } alive = false; ws.ping(); }, HEARTBEAT_MS);
    heartbeat.unref();
    ws.on('close', () => { controller.abort(); clearInterval(heartbeat); for (const answer of approvals.values()) answer(false); approvals.clear(); });
    ws.on('error', () => ws.terminate());
    ws.on('message', (data: RawData, binary: boolean) => {
      const message = binary ? undefined : clientMessage.safeParse(safeJson(data.toString()));
      if (!message?.success) { ws.close(1008, 'Invalid message'); return; }
      if (message.data.t === 'approval') { approvals.get(message.data.id)?.(message.data.approved); return; }
      if (waiting) { const deliver = waiting; waiting = undefined; deliver(message.data.text); }
      else if (inbox.length < 20) inbox.push(message.data.text);
    });

    const next = (): Promise<string> => {
      const queued = inbox.shift();
      if (queued !== undefined) return Promise.resolve(queued);
      return new Promise((resolve, reject) => {
        if (signal.aborted) return reject(closed());
        const stop = () => { waiting = undefined; reject(closed()); };
        signal.addEventListener('abort', stop, { once: true });
        waiting = text => { signal.removeEventListener('abort', stop); resolve(text); };
      });
    };

    const approve: Approve = async (approval: Approval) => {
      const stop = AbortSignal.any([signal, AbortSignal.timeout(options.approvalTimeoutMs ?? 10 * 60_000), ...(approval.signal ? [approval.signal] : [])]);
      if (stop.aborted) return false;
      const id = randomUUID();
      const answer = new Promise<boolean>(resolve => {
        approvals.set(id, resolve);
        stop.addEventListener('abort', () => resolve(false), { once: true });
      });
      send({ t: 'approval', id, text: `${approval.summary}\n${approval.details ?? ''}` });
      const approved = await answer;
      approvals.delete(id);
      log(`${approval.kind} ${approved ? 'approved' : 'denied'}: ${redact(approval.summary).split('\n')[0]}`);
      return approved;
    };

    log('Client connected.');
    try {
      const authorization = await SessionGrants.create(root, config, 'chat');
      send({ t: 'hello', version: BRIDGE_PROTOCOL, root: authorization.root, routingMode: config.routingMode ?? 'hosted' });
      const dependencies: HostDependencies = {
        approve,
        onActivity: activity => send({ t: 'activity', activity }),
        onProgress: text => send({ t: 'log', text }),
        onEvent: event => send({ t: 'event', event }),
      };
      await runSession({
        request: { prompt: '', cwd: authorization.root, mode: 'chat', authorization, signal },
        maxPromptChars: config.policy.limits.maxPromptChars,
        input: async state => {
          for (;;) {
            send({ t: 'input', state });
            const text = await next();
            // As with Discord, the remote user cannot move the session's root.
            if (/^\/cd(\s|$)/.test(text.trim())) { send({ t: 'log', text: 'The repository root is fixed for bridge sessions. Restart teapilot bridge host with --cwd to change it.' }); continue; }
            return text;
          }
        },
        run: async request => {
          send({ t: 'turn' });
          let result: HostResult;
          try { result = await run(config, { ...request, signal }, dependencies); }
          catch (error) {
            if (signal.aborted) throw error;
            const message = error instanceof Error ? error.message : String(error);
            log(`Turn failed: ${redact(message)}`);
            result = { requestId: '', success: false, status: 'error', text: `teapilot could not finish: ${message}`, spentUsd: 0, receipts: [], attempts: 0 };
          }
          send({ t: 'answer', result });
          log(`${result.status}; $${result.spentUsd.toFixed(6)}`);
          return result;
        },
        approve, log: text => send({ t: 'log', text }), onEvent: dependencies.onEvent,
        extension: options.teachat && headlessTeachat(options.teachat, 'bridge'),
      });
      send({ t: 'end', reason: 'Session ended.' });
    } catch (error) {
      if (!signal.aborted) {
        const message = redact(error instanceof Error ? error.message : String(error));
        log(`Session ended: ${message}`);
        send({ t: 'end', reason: `Session ended after an error: ${message}` });
      }
    } finally {
      controller.abort();
      ws.close(1000);
      sockets.delete(ws);
      log('Client disconnected.');
    }
  }

  await new Promise<void>((resolve, reject) => {
    server.once('error', error => reject((error as NodeJS.ErrnoException).code === 'EADDRINUSE' ? new Error(`Port ${options.port} is already in use. Choose another with teapilot bridge host <port>.`) : error));
    server.listen(options.port, options.host ?? '127.0.0.1', resolve);
  });
  const address = server.address();
  const port = typeof address === 'object' && address ? address.port : options.port;
  return {
    port,
    close: () => new Promise<void>(resolve => {
      for (const ws of sockets) ws.close(1001);
      wss.close(); server.close(() => resolve()); server.closeAllConnections();
    }),
  };
}

function safeJson(text: string): unknown { try { return JSON.parse(text); } catch { return undefined; } }
