import { casualLines, paceLines } from '../casual.js';
import { runSession, type SessionExtension } from '../chat.js';
import type { HostDependencies, HostRequest, HostResult } from '../host.js';
import { repositoryOffered, repositoryPermissions } from '../execution/grants.js';
import type { Approval, Approve } from '../execution/policy.js';
import type { ConversationTurn, EventSink } from '../integration/events.js';
import type { AccessStore } from './access-store.js';
import type { ConversationWorkspace } from '../agents/workspace.js';
import type { WorkspaceSandbox } from '../workspace/sandbox.js';
import type { WorkspaceStore } from '../workspace/store.js';
import { storeControls } from '../workspace/commands.js';
import type { MessagePayload } from './play/render.js';
import type { HostedMessage, PlayRuntime, StartOptions } from './play/runtime.js';
import { approvePrompt, changePrompt, extractPlan, juniorsPrompt, planMessages, type PlanAction, type PlanControls, type PlanEmbed } from './plan.js';
import { chunk, StatusCard, throttle, type CardReply } from './render.js';

export type CardButton = 'stop' | 'details';
/** A status card's buttons: Details always, Stop while `stop` is set. */
export interface CardControls { stop: boolean; press(button: CardButton, userId: string): CardReply }

/** Everything the bridge needs from Discord for one conversation (a DM or a thread). */
export interface DiscordTransport {
  send(text: string): Promise<string>;
  edit(messageId: string, text: string): Promise<void>;
  /** Posts a turn's status card, or with `id` replaces it. Each press is answered privately with `press`'s reply. */
  card(text: string, controls: CardControls, id?: string): Promise<string>;
  /** Post approve/deny buttons. Resolves false when `signal` aborts first. */
  askApproval(text: string, signal: AbortSignal): Promise<boolean>;
  typing(): void;
  /** Posts files as attachments, with a line of text. */
  sendFiles?(text: string, files: Array<{ name: string; data: Buffer }>): Promise<string>;
  /** Where teapilot answers through an interaction: posts a discord.play app as a reply to it. */
  postApp?(payload: MessagePayload): Promise<HostedMessage>;
  /**
   * Posts a plan as embeds, one array per message, with its buttons on the last message. With `ids` it edits those
   * messages in place instead: posting more if the plan grew, deleting the extra ones if it shrank. Resolves with the ids.
   */
  plan?(messages: PlanEmbed[][], controls: PlanControls, ids?: string[]): Promise<string[]>;
}

/** A plan on Discord: its messages, and where it is in being refined. */
interface PlanState { text: string; ids: string[]; /** A prompt from its buttons is being worked on. */ revising: boolean; done: boolean }

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
  run: (request: HostRequest, dependencies: Pick<HostDependencies, 'approve' | 'onEvent' | 'onReasoning'>) => Promise<HostResult>;
  redact: (text: string) => string;
  /** Operator log in the terminal running teapilot discord start. */
  log: (text: string) => void;
  /** Resolves each message's sender to a role, per-turn permissions and the access-management tools. */
  access?: AccessStore;
  /** Answer one message and end, for transports that cannot receive follow-ups. */
  once?: boolean;
  approvalTimeoutMs?: number;
  progressIntervalMs?: number;
  /** How often a running turn's status card moves on by itself. */
  heartbeatMs?: number;
  extension?: SessionExtension;
  /** Receives the conversation's turns after each change, so they survive a restart. */
  onHistory?: (history: ConversationTurn[]) => void;
  /**
   * discord.play apps; `channelId` is where they run, absent where they cannot be posted, and `post` posts them
   * through an interaction instead. `conversation` manages them, by default this conversation's key.
   */
  play?: { runtime: PlayRuntime; channelId?: string; post?: StartOptions['post']; conversation?: string };
  /** Each conversation's workspace: attachments and files teapilot makes, kept under the same key as its apps. */
  files?: WorkspaceStore;
  /** Runs commands in those workspaces. */
  sandbox?: WorkspaceSandbox;
  /** How long a turn's status card waits for routing to say it is not conversational; 4 seconds by default. */
  cardDelayMs?: number;
  /** The pause before each line of a conversational reply after the first; 0.5–2 seconds by default. */
  lineDelayMs?: () => number;
}

const discordHelp = '`/stop` - cancel the running turn\n`/convo clear` - clear the context window; the workspace keeps its files\n`/workspace clear|name|tree` - delete, name or list the workspace\'s files\n`/new` - clear both\n`/btw` - ask a question without polluting the context window.\n`/plan` - get an implementation plan to discuss before anything is changed.\n`/rfc` - get a design proposal to discuss before anything is changed.';

/** One Discord conversation driving one teapilot session with its own history and grants. */
export class Conversation {
  private readonly inbox: Array<{ text: string; sender?: string; senderName?: string; yolo?: boolean; quiet?: boolean }> = [];
  /** Who sent the message the current turn is answering; a thread can have several people. */
  private speaker?: string;
  private speakerName?: string;
  /** The message being answered asked for every approval to pass without asking; honoured for operators only. */
  private yolo = false;
  /** The message being handled was answered privately already, so what the session says about it only goes to the log. */
  private quiet = false;
  private waiting?: { resolve(text: string): void; reject(error: Error): void };
  private turn?: AbortController;
  private sink?: EventSink;
  private reasoning?: (text: string) => void;
  /** The running turn's status card, and how to show a change on it. */
  private live?: { card: StatusCard; refresh(): void };
  private ended = false;
  private answerOnly = false;
  /** The newest plan shown as embeds; a refined plan replaces it in place. */
  private plan?: PlanState;
  /** A plan button sent the next turn's prompt, so a plan in its answer refines `plan` rather than posting a new one. */
  private refining = false;
  readonly done: Promise<void>;

  constructor(private readonly options: ConversationOptions) {
    this.done = this.start();
  }

  /** Deliver a message from an allowed person. Local commands take effect immediately. */
  push(text: string, options: { answerOnly?: boolean; sender?: string; senderName?: string; yolo?: boolean; quiet?: boolean } = {}): void {
    // Only the next turn is answer-only, and only if nothing is running to change mid-turn.
    if (options.answerOnly && !this.turn) this.answerOnly = true;
    const trimmed = text.trim();
    const [command] = trimmed.split(/\s+/);
    if (trimmed === '/clear') { void this.say('Use /convo clear to clear the conversation, or /new to clear the workspace as well.', true); return; }
    if (command === '/stop') {
      if (this.turn && !this.turn.signal.aborted) { this.stop(); void this.say('Stopping the current turn. Edits already made remain on disk.', true); }
      else void this.say('Nothing is running.', true);
      return;
    }
    if (command === '/cd') { void this.say('The repository root is fixed for Discord sessions. Change it with teapilot discord setup.', true); return; }
    if (command === '/help') void this.say(discordHelp, true);
    if (this.turn && !['/exit', '/quit'].includes(command ?? '')) void this.say('Queued as your next message.', true);
    if (this.waiting) { const waiting = this.waiting; this.waiting = undefined; this.speaker = options.sender; this.speakerName = options.senderName; this.yolo = options.yolo === true; this.quiet = options.quiet === true; waiting.resolve(text); }
    else this.inbox.push({ text, sender: options.sender, senderName: options.senderName, yolo: options.yolo, quiet: options.quiet });
  }

  get active(): boolean { return !this.ended; }

  /** `direct` text always goes to Discord; anything else stays in the terminal during an answer-only turn. */
  private async say(text: string, direct = false): Promise<void> {
    if ((this.answerOnly || this.quiet) && !direct) { this.options.log(`${this.options.key}: ${this.options.redact(text)}`); return; }
    for (const part of chunk(this.options.redact(text))) await this.options.transport.send(part).catch(error => this.options.log(`${this.options.key}: send failed: ${error instanceof Error ? error.message : error}`));
  }

  private input = (): Promise<string> => {
    const next = this.inbox.shift();
    if (next) { this.speaker = next.sender; this.speakerName = next.senderName; this.yolo = next.yolo === true; this.quiet = next.quiet === true; return Promise.resolve(next.text); }
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
    // Only operators may answer approvals, so only an operator's message can approve everything up front.
    if (this.yolo && this.operator(this.speaker)) {
      const summary = this.options.redact(approval.summary).split('\n')[0];
      this.options.log(`${this.options.key}: ${approval.kind} auto-approved (yolo): ${summary}`);
      await this.say(`-# Auto-approved (${approval.kind}): ${summary}`);
      return true;
    }
    const text = this.options.redact(`**Approval needed** (${approval.kind})\n${approval.summary}${approval.details ? `\n\`\`\`\n${approval.details}\n\`\`\`` : ''}`);
    const parts = chunk(text);
    const live = this.live;
    const previous = live?.card.set('approval');
    live?.refresh();
    // Show everything; the buttons go on the last part so the whole request is read first.
    for (const part of parts.slice(0, -1)) await this.options.transport.send(part);
    const approved = await this.options.transport.askApproval(parts.at(-1) ?? 'Approval needed.', signal).finally(() => {
      if (!live || !previous) return;
      // Put the phase back unless something else, such as Stop, changed it meanwhile.
      const current = live.card.set(previous);
      if (current !== 'approval') live.card.set(current);
      live.refresh();
    });
    this.options.log(`${this.options.key}: ${approval.kind} ${approved ? 'approved' : 'denied'}: ${this.options.redact(approval.summary).split('\n')[0]}`);
    return approved;
  };

  /** Paints a plan's messages; its buttons are `actions`, none once it is settled or being worked on. */
  private async paint(state: PlanState, actions: PlanAction[], footer?: string): Promise<void> {
    try { state.ids = await this.options.transport.plan!(planMessages(state.text, footer), this.planControls(state, actions), state.ids); }
    catch (error) { this.options.log(`${this.options.key}: plan embed failed: ${error instanceof Error ? error.message : String(error)}`); }
  }

  private planControls(state: PlanState, actions: PlanAction[]): PlanControls {
    const { access } = this.options;
    const refusal = (userId: string) => access && access.roleOf(userId) === undefined ? 'You are not allowed to use teapilot.'
      : this.plan !== state || state.done ? 'This plan has been replaced or settled.'
      : state.revising ? 'teapilot is already working on this plan.' : undefined;
    return { actions, refusal, press: (action, user, request) => {
      const refused = refusal(user.id);
      if (refused) return refused;
      const sender = { sender: user.id, senderName: user.name };
      if (action === 'approve') {
        state.done = true;
        this.push(approvePrompt, sender);
        void this.paint(state, [], `✅ Approved by ${user.name}`);
        return undefined;
      }
      if (action === 'change' && !request?.trim()) return 'Say what should change.';
      const note = action === 'juniors' ? '♟️ Assigning juniors…' : `✍️ Revising: ${request!.replace(/\s+/g, ' ').trim().slice(0, 100)}`;
      state.revising = true; this.refining = true;
      this.push(action === 'juniors' ? juniorsPrompt : changePrompt(request!.trim()), sender);
      void this.paint(state, [], note);
      return undefined;
    } };
  }

  /** Shows an answer's plan as embeds; when `refining`, it edits the plan whose button was pressed instead of posting another. */
  private async showPlan(plan: string, refining: boolean): Promise<void> {
    const previous = this.plan;
    const reuse = refining && previous && !previous.done ? previous : undefined;
    // A plan that is not refined replaces an older one, which keeps its text but loses its buttons.
    if (previous && !reuse && !previous.done) { previous.done = true; await this.paint(previous, [], 'superseded by a newer plan'); }
    const state: PlanState = reuse ?? { text: plan, ids: [], revising: false, done: false };
    state.text = plan; state.revising = false;
    this.plan = state;
    await this.paint(state, ['approve', 'juniors', 'change']);
    if (!state.ids.length) await this.say(plan, true);
  }

  private onEvent: EventSink = event => this.sink?.(event);
  private onReasoning = (text: string) => this.reasoning?.(text);

  /** Operators hold every permission; without roles, everyone who may talk to teapilot counts as one. */
  private operator(id?: string): boolean {
    const { access } = this.options;
    return !access || (id !== undefined && access.roleOf(id) === 'operator');
  }

  private stop(): void {
    this.turn?.abort();
    if (this.live) { this.live.card.set('stopping'); this.live.refresh(); }
  }

  private run = async (base: HostRequest): Promise<HostResult> => {
    // Bind this turn to its sender before anything can check a permission.
    const { access } = this.options;
    const admin = access && this.speaker ? access.adminFor(this.speaker) : undefined;
    // With roles in force, a turn without a known sender holds nothing.
    base.authorization?.setCaller(access ? this.speaker ? access.callerFor(this.speaker) : () => ({ permissions: [] }) : undefined);
    const { play, files, sandbox, transport } = this.options;
    // A conversation with a workspace is offered its repository only in Code mode in one; otherwise nothing asks for it.
    base.authorization?.withhold(files && !await repositoryOffered(base.cwd, base.mode) ? repositoryPermissions : []);
    const conversation = play?.conversation ?? this.options.key;
    const workspace: ConversationWorkspace | undefined = files && { store: files, conversation, sandbox, delivery: 'post',
      send: transport.sendFiles && (async (text, sent) => { await transport.sendFiles!(this.options.redact(text), sent); }) };
    // A side question (/btw) only reads: it keeps no scratchpad, the session's transcript, and starts no apps.
    const side = base.side === true;
    const request: HostRequest = { ...base, access: admin, workspace, ...(files && !side ? { scratch: files.scratch(conversation) } : {}),
      play: play && !side ? { runtime: play.runtime, channelId: play.channelId, post: play.post, conversation, owner: this.speaker ? { id: this.speaker, name: this.speakerName } : undefined, files: workspace } : undefined };
    const refining = this.refining; this.refining = false;
    const turn = this.turn = new AbortController();
    const signal = AbortSignal.any([turn.signal, ...(this.options.request.signal ? [this.options.request.signal] : [])]);
    // A side answer shows no card either: it is one message, like a quick reply.
    const answerOnly = this.answerOnly || side;
    // It is still typed like a reply; a transport that answers a slash command has no typing to show.
    const typed = !this.answerOnly;
    const speaker = this.speaker;
    const card = new StatusCard(this.options.redact);
    /** The turn's status once it has ended; from then on the card no longer changes. */
    let outcome: string | undefined;
    const controls = (stop: boolean): CardControls => ({ stop, press: (button, userId) => {
      if (button === 'details') return card.details(outcome ?? 'running');
      if (outcome || this.turn !== turn || turn.signal.aborted) return { text: 'This turn is already ending.' };
      if (userId !== speaker && !this.operator(userId)) return { text: 'Only the person who asked, or an operator, can stop this turn.' };
      this.options.log(`${this.options.key}: stopped from the status card by ${userId}`);
      this.stop();
      return { text: 'Stopping. Edits already made remain on disk.' };
    } });
    const failed = (error: unknown) => { this.options.log(`${this.options.key}: status card failed: ${error instanceof Error ? error.message : String(error)}`); return undefined; };
    let posted: Promise<string | undefined> | undefined;
    /** Posts or replaces the card; false when it could not be posted. */
    const show = async (text: string, stop: boolean): Promise<boolean> => {
      const first = !posted;
      posted ??= this.options.transport.card(text, controls(stop)).catch(failed);
      const id = await posted;
      if (!first && id) await this.options.transport.card(text, controls(stop), id).catch(failed);
      return Boolean(id);
    };
    const update = throttle(async () => { if (outcome === undefined) await show(card.render(), true); }, this.options.progressIntervalMs ?? 1500);
    // The card waits for routing: a conversational turn shows only typing, like a person would. Any other
    // route, a slow one, or anything that needs to be seen (a tool, an approval, a wait in the queue) brings it up.
    let cardState = 'pending' as 'pending' | 'shown' | 'hidden';
    const refresh = (show = true) => {
      if (show && cardState === 'pending') cardState = 'shown';
      if (cardState === 'shown') update.request();
    };
    const pending = answerOnly ? undefined : setTimeout(() => refresh(), this.options.cardDelayMs ?? 4000);
    if (!answerOnly) this.live = { card, refresh: () => refresh() };
    this.sink = event => {
      if (typeof event.result === 'string') this.options.log(`${this.options.key}: ${String(event.tool)} -> ${this.options.redact(event.result)}`);
      if (event.type === 'route' && cardState === 'pending' && !answerOnly) {
        if (event.casual === true) { cardState = 'hidden'; clearTimeout(pending); } else refresh();
      }
      if (!answerOnly && card.push(event)) refresh(cardState !== 'hidden');
    };
    this.reasoning = answerOnly ? undefined : text => { if (card.reason(text)) refresh(false); };
    const typing = !typed ? undefined : setInterval(() => this.options.transport.typing(), 8000);
    const heartbeat = answerOnly ? undefined : setInterval(() => { card.tick(); refresh(false); }, this.options.heartbeatMs ?? 5000);
    let result: HostResult;
    try {
      result = await this.options.queue.run(async () => {
        signal.throwIfAborted();
        if (typed) this.options.transport.typing();
        if (!answerOnly && card.set('thinking') === 'queued') refresh();
        return await this.options.run({ ...request, signal }, { approve: this.approve, onEvent: this.onEvent, onReasoning: this.onReasoning });
      }, () => { if (answerOnly) void this.say('Queued behind another task.'); else { card.set('queued'); refresh(); } });
    } catch (error) {
      const stopped = turn.signal.aborted;
      if (!stopped && this.options.request.signal?.aborted) throw error;
      const message = error instanceof Error ? error.message : String(error);
      this.options.log(`${this.options.key}: ${stopped ? 'stopped' : `failed: ${this.options.redact(message)}`}`);
      result = { requestId: '', success: false, status: stopped ? 'stopped' : 'error', text: stopped ? 'Stopped.' : `teapilot could not finish: ${message}`, spentUsd: 0, receipts: [], attempts: 0 };
    } finally {
      clearTimeout(pending);
      clearInterval(typing);
      clearInterval(heartbeat);
      this.sink = undefined;
      this.reasoning = undefined;
      this.live = undefined;
      if (this.turn === turn) this.turn = undefined;
    }
    // A conversational reply goes out a line at a time with typing between, and without a card or result line.
    const lines = result.casual && result.success ? casualLines(this.options.redact(result.text)) : undefined;
    if (lines) {
      const { transport } = this.options;
      await paceLines(lines, line => transport.send(line).catch(error => this.options.log(`${this.options.key}: send failed: ${error instanceof Error ? error.message : error}`)),
        { typing: () => transport.typing(), delayMs: this.options.lineDelayMs, signal: this.options.request.signal });
    } else {
      const found = !side && result.success && this.options.transport.plan ? extractPlan(this.options.redact(result.text)) : undefined;
      if (found) {
        if (found.before) await this.say(found.before, true);
        await this.showPlan(found.plan, refining);
        if (found.after) await this.say(found.after, true);
      } else {
        await this.say(`${result.text || '(no answer)'}${side ? '\n-# this is an aside - not part of the main convo.' : ''}`, true);
        // The turn a button started ended without a plan: give the plan its buttons back.
        if (refining && this.plan?.revising) { this.plan.revising = false; await this.paint(this.plan, ['approve', 'juniors', 'change']); }
      }
    }
    // The terminal log below already records the result of an answer-only turn. Otherwise the card collapses to
    // its result once the answer is up, so the result stays the turn's last word and Details stays under it.
    if (!answerOnly && !(result.casual && result.success && cardState !== 'shown')) {
      outcome = result.status;
      await update.flush();
      const summary = card.summary(result);
      if (!await show(summary, false)) await this.say(summary);
    }
    this.options.log(`${this.options.key}: ${result.status}; $${result.spentUsd.toFixed(6)}`);
    this.answerOnly = false;
    return result;
  };

  private async start(): Promise<void> {
    try {
      await runSession({ request: this.options.request, once: this.options.once, maxPromptChars: this.options.maxPromptChars, input: this.input, run: this.run,
        approve: this.approve, log: text => void this.say(text), onEvent: this.onEvent, extension: this.options.extension, onHistory: this.options.onHistory,
        ...(this.options.files ? { files: storeControls(this.options.files, () => this.options.play?.conversation ?? this.options.key) } : {}) });
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
