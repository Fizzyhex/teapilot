import { pathToFileURL } from 'node:url';
import { Worker } from 'node:worker_threads';
import { cleanChildEnvironment } from '../../execution/policy.js';
import { harness, parseResult, sdkPath, type CallInput, type CallResult, type Method, type PlayEngine } from './engine.js';
import { PlayError } from './render.js';

export type DiscordRequest = (method: string, route: string, body?: unknown) => Promise<unknown>;
const methods = ['GET', 'POST', 'PUT', 'PATCH', 'DELETE'];
const callMs = 10_000;

/**
 * Runs in the worker. The app is ordinary Node code from the repository: it may import anything the
 * repository can, and "@teapilot/discord-play" resolves to teapilot's own copy. Discord is reachable
 * only through the host, which holds the token.
 */
const bootstrap = `
const { parentPort, workerData } = require('node:worker_threads');
require('node:module').registerHooks({ resolve(specifier, context, next) {
  return specifier === '@teapilot/discord-play' ? { url: workerData.sdk, shortCircuit: true } : next(specifier, context);
} });
const waiting = new Map(); let counter = 0;
const discord = { request: (method, route, body) => new Promise((resolve, reject) => {
  const id = counter++; waiting.set(id, { resolve, reject });
  parentPort.postMessage({ type: 'request', id, method, route, body });
}) };
const ready = import(workerData.app).then(module => { const app = module.default; ${harness(true)} });
ready.then(() => parentPort.postMessage({ type: 'ready' }), error => parentPort.postMessage({ type: 'ready', error: String(error && error.stack || error) }));
parentPort.on('message', async message => {
  if (message.type === 'response') {
    const entry = waiting.get(message.id); waiting.delete(message.id);
    if (entry) message.error === undefined ? entry.resolve(message.value) : entry.reject(new Error(message.error));
    return;
  }
  try { await ready; parentPort.postMessage({ type: 'result', id: message.id, output: await globalThis.__play(message.method, message.input, discord) }); }
  catch (error) { parentPort.postMessage({ type: 'result', id: message.id, error: String(error && error.stack || error) }); }
});`;

type Message = { type: 'ready'; error?: string } | { type: 'result'; id: number; output?: string; error?: string } | { type: 'request'; id: number; method: string; route: string; body?: unknown };

/** A repository app an operator approved. A stuck or crashed worker is replaced on the next call. */
class TrustedEngine implements PlayEngine {
  private worker?: { thread: Worker; ready: Promise<void> };
  private calls = new Map<number, { resolve(output: string): void; reject(error: Error): void }>();
  private counter = 0;
  constructor(private readonly file: string, private readonly request: DiscordRequest, private readonly log: (text: string) => void) {}

  async load(): Promise<void> {
    if (!this.worker) {
      const thread = new Worker(bootstrap, {
        eval: true, env: cleanChildEnvironment(), stdout: true, stderr: true, resourceLimits: { maxOldGenerationSizeMb: 256 },
        workerData: { app: pathToFileURL(this.file).href, sdk: pathToFileURL(sdkPath()).href },
      });
      for (const stream of [thread.stdout, thread.stderr]) stream.on('data', chunk => this.log(`trusted app ${this.file}: ${String(chunk).trimEnd()}`));
      const ready = new Promise<void>((resolve, reject) => {
        thread.on('message', (message: Message) => {
          if (message.type === 'ready') message.error === undefined ? resolve() : reject(new PlayError(`The app failed to load: ${message.error}`));
          else if (message.type === 'result') {
            const call = this.calls.get(message.id); this.calls.delete(message.id);
            if (message.error !== undefined) call?.reject(new PlayError(message.error)); else call?.resolve(message.output ?? '');
          } else if (message.type === 'request') void this.answer(thread, message);
        });
        thread.on('error', error => { reject(error); this.fail(thread, error); });
        thread.on('exit', code => { const error = new PlayError(`The app's worker exited (code ${code}).`); reject(error); this.fail(thread, error); });
      });
      this.worker = { thread, ready };
    }
    const { thread, ready } = this.worker;
    try { await ready; } catch (error) { this.fail(thread, error as Error); void thread.terminate(); throw error; }
  }

  private async answer(thread: Worker, message: Extract<Message, { type: 'request' }>): Promise<void> {
    try {
      if (!methods.includes(message.method) || typeof message.route !== 'string' || !message.route.startsWith('/')) throw new Error('Use request(method, "/route", body) with GET, POST, PUT, PATCH or DELETE.');
      thread.postMessage({ type: 'response', id: message.id, value: await this.request(message.method, message.route, message.body) });
    } catch (error) { thread.postMessage({ type: 'response', id: message.id, error: error instanceof Error ? error.message : String(error) }); }
  }

  private fail(thread: Worker, error: Error): void {
    if (this.worker?.thread !== thread) return;
    this.worker = undefined;
    for (const call of this.calls.values()) call.reject(error);
    this.calls.clear();
  }

  async call(method: Method, input: CallInput): Promise<CallResult> {
    await this.load();
    const { thread } = this.worker!;
    const id = this.counter++;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const output = await new Promise<string>((resolve, reject) => {
      this.calls.set(id, { resolve, reject });
      timer = setTimeout(() => {
        const error = new PlayError(`${method}() ran longer than ${callMs / 1000} s; the worker was restarted.`);
        this.fail(thread, error); void thread.terminate();
      }, callMs);
      thread.postMessage({ type: 'call', id, method, input: JSON.stringify(input) });
    }).finally(() => clearTimeout(timer));
    return parseResult(output);
  }

  dispose(): void {
    const worker = this.worker;
    if (worker) { this.fail(worker.thread, new PlayError('The app was stopped.')); void worker.thread.terminate(); }
  }
}

export async function trusted(file: string, request: DiscordRequest, log: (text: string) => void): Promise<PlayEngine> {
  const engine = new TrustedEngine(file, request, log);
  await engine.load();
  return engine;
}
