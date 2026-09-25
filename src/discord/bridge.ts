import { runSession } from '../chat.js';
import type { HostDependencies, HostRequest, HostResult } from '../host.js';
import type { Approval, Approve } from '../execution/policy.js';
import type { EventSink } from '../integration/events.js';
import { chunk, ProgressLine, throttle } from './render.js';

/** Everything the bridge needs from Discord for one conversation (a DM or a thread). */
export interface DiscordTransport {
  send(text: string): Promise<string>;
  edit(messageId: string, text: string): Promise<void>;
  /** Post approve/deny buttons. Resolves false when `signal` aborts first. */
  askApproval(text: string, signal: AbortSignal): Promise<boolean>;
  typing(): void;
}

/** runHost holds the state lock, so turns from every conversation run one at a time. */
export class TurnQueue {
  private tail: Promise<void> = Promise.resolve();
  private active = 0;
  async run<T>(task: () => Promise<T>, onWait?: () => void): Promise<T> {
    if (this.active++) onWait?.();
    const previous = this.tail;
    let release!: () => void;
    this.tail = new Promise(done => { release = done; });
    try { await previous; return await task(); }
    finally { this.active--; release(); }
  }
}

export interface ConversationOptions {
  key: string;
  transport: DiscordTransport;
  /** Base request: cwd, mode, grants and the session signal. */
  request: HostRequest;
  maxPromptChars: number;
  queue: TurnQueue;
  run: (request: HostRequest, dependencies: Pick<HostDependencies, 'approve' | 'onEvent'>) => Promise<HostResult>;
  redact: (text: string) => string;
  /** Operator log in the terminal running teapilot discord start. */
  log: (text: string) => void;
  /** Answer one message and end, for transports that cannot receive follow-ups. */
  once?: boolean;
  approvalTimeoutMs?: number;
  progressIntervalMs?: number;
}

const discordHelp = 'Discord: /stop cancels the running turn; /exit ends this conversation. The repository root is fixed; change it with teapilot discord setup.';

/** One Discord conversation driving one teapilot session with its own history and grants. */
export class Conversation {
  private readonly inbox: string[] = [];
  private waiting?: { resolve(text: string): void; reject(error: Error): void };
  private turn?: AbortController;
  private sink?: EventSink;
  private ended = false;
  readonly done: Promise<void>;

  constructor(private readonly options: ConversationOptions) {
    this.done = this.start();
  }

  /** Deliver a message from an allowlisted person. Local commands take effect immediately. */
  push(text: string): void {
    const trimmed = text.trim();
    const [command] = trimmed.split(/\s+/);
    if (command === '/stop') {
      if (this.turn && !this.turn.signal.aborted) { this.turn.abort(); void this.say('Stopping the current turn. Edits already made remain on disk.'); }
      else void this.say('Nothing is running.');
      return;
    }
    if (command === '/cd') { void this.say('The repository root is fixed for Discord sessions. Change it with teapilot discord setup.'); return; }
    if (command === '/help') void this.say(discordHelp);
    if (this.turn && !['/exit', '/quit'].includes(command ?? '')) void this.say('Queued as your next message.');
    if (this.waiting) { const waiting = this.waiting; this.waiting = undefined; waiting.resolve(text); }
    else this.inbox.push(text);
  }

  get active(): boolean { return !this.ended; }

  private async say(text: string): Promise<void> {
    for (const part of chunk(this.options.redact(text))) await this.options.transport.send(part).catch(error => this.options.log(`${this.options.key}: send failed: ${error instanceof Error ? error.message : error}`));
  }

  private input = (): Promise<string> => {
    const next = this.inbox.shift();
    if (next !== undefined) return Promise.resolve(next);
    const signal = this.options.request.signal;
    return new Promise((resolve, reject) => {
      const closed = () => reject(Object.assign(new Error('closed'), { name: 'TerminalClosedError' }));
      if (signal?.aborted) return closed();
      signal?.addEventListener('abort', closed, { once: true });
      this.waiting = { resolve: text => { signal?.removeEventListener('abort', closed); resolve(text); }, reject };
    });
  };

  private approve: Approve = async (approval: Approval) => {
    const signals = [AbortSignal.timeout(this.options.approvalTimeoutMs ?? 10 * 60_000), this.options.request.signal, this.turn?.signal, approval.signal].filter((value): value is AbortSignal => Boolean(value));
    const signal = AbortSignal.any(signals);
    if (signal.aborted) return false;
    const text = this.options.redact(`**Approval needed** (${approval.kind})\n${approval.summary}${approval.details ? `\n\`\`\`\n${approval.details}\n\`\`\`` : ''}`);
    const parts = chunk(text);
    // Show everything; the buttons go on the last part so the whole request is read first.
    for (const part of parts.slice(0, -1)) await this.options.transport.send(part);
    const approved = await this.options.transport.askApproval(parts.at(-1) ?? 'Approval needed.', signal);
    this.options.log(`${this.options.key}: ${approval.kind} ${approved ? 'approved' : 'denied'}: ${this.options.redact(approval.summary).split('\n')[0]}`);
    return approved;
  };

  private onEvent: EventSink = event => this.sink?.(event);

  private run = async (request: HostRequest): Promise<HostResult> => {
    const turn = this.turn = new AbortController();
    const signal = AbortSignal.any([turn.signal, ...(this.options.request.signal ? [this.options.request.signal] : [])]);
    const progress = new ProgressLine(this.options.redact);
    let status: Promise<string> | undefined;
    const update = throttle(async () => {
      const text = progress.render();
      if (!text) return;
      if (!status) status = this.options.transport.send(text);
      else await this.options.transport.edit(await status, text);
    }, this.options.progressIntervalMs ?? 1500);
    this.sink = event => { if (progress.push(event)) update.request(); };
    const typing = setInterval(() => this.options.transport.typing(), 8000);
    let result: HostResult;
    try {
      result = await this.options.queue.run(async () => {
        signal.throwIfAborted();
        this.options.transport.typing();
        return await this.options.run({ ...request, signal }, { approve: this.approve, onEvent: this.onEvent });
      }, () => void this.say('Queued behind another task.'));
    } catch (error) {
      const stopped = turn.signal.aborted;
      if (!stopped && this.options.request.signal?.aborted) throw error;
      const message = error instanceof Error ? error.message : String(error);
      this.options.log(`${this.options.key}: ${stopped ? 'stopped' : `failed: ${this.options.redact(message)}`}`);
      result = { requestId: '', success: false, status: stopped ? 'stopped' : 'error', text: stopped ? 'Stopped.' : `teapilot could not finish: ${message}`, spentUsd: 0, receipts: [], attempts: 0 };
    } finally {
      clearInterval(typing);
      this.sink = undefined;
      await update.flush();
      if (this.turn === turn) this.turn = undefined;
    }
    await this.say(result.text || '(no answer)');
    await this.say(`-# Result: ${result.status}; accounted $${result.spentUsd.toFixed(6)}${result.requestId ? `; request ${result.requestId}` : ''}`);
    this.options.log(`${this.options.key}: ${result.status}; $${result.spentUsd.toFixed(6)}`);
    return result;
  };

  private async start(): Promise<void> {
    try {
      await runSession({ request: this.options.request, once: this.options.once, maxPromptChars: this.options.maxPromptChars, input: this.input, run: this.run,
        approve: this.approve, log: text => void this.say(text), onEvent: this.onEvent });
      if (!this.options.request.signal?.aborted && !this.options.once) await this.say('Session ended. Send a message to start a new one.');
    } catch (error) {
      if (!this.options.request.signal?.aborted) {
        const message = this.options.redact(error instanceof Error ? error.message : String(error));
        this.options.log(`${this.options.key}: session ended: ${message}`);
        await this.say(`Session ended after an error: ${message}`);
      }
    } finally { this.ended = true; }
  }
}
