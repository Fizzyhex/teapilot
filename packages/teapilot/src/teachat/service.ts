import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import {
  announceHandling, clip, displayName, gossipRound, isAbortError, openRoom, othersBusy, pickIdentity, waitUntilQuiet,
  type Decider, type GossipRound, type Room, type Turn,
} from 'teachat';
import { ask } from '../agents/ask.js';
import type { Config } from '../config.js';
import { lockState, SpendGovernor, StateBusyError } from '../inference/budget.js';
import type { CancellableJevProvider } from '../inference/providers.js';
import type { TeachatIdentityAnswer } from '../routing/intent.js';
import { Telemetry } from '../telemetry/outcome.js';
import { jevDecider } from './decider.js';
import { gossipCall, gossipTier } from './runner.js';
import { teachatTools } from './tools.js';

/** Where gossip is shown: grey lines in the terminal, the operator log for Discord and the bridge. */
export interface GossipView { line(text: string, kind?: 'header' | 'thought' | 'post' | 'status'): void; activity?(label: string | undefined): void }
export interface TeachatOptions { provider?: CancellableJevProvider; graceMs?: number; pollMs?: number; pauseLimitMs?: number }

const LEASE_MS = 30 * 60_000;
const TRANSCRIPT_TURNS = 12;
interface Session { key: string; holder: string; identity?: string; transcript: Turn[]; gossiped: number; announced: boolean; round?: GossipRound; seen: number }

const announcePrompt = (request: string) => [
  'In one short, vague line (under 12 words), what kind of request is this?',
  'No names, code, paths, file contents or personal details. Reply with the line only.',
  '', `Request: ${clip(request, 1500)}`,
].join('\n');

/**
 * Teachat for one teapilot process: the identity each conversation plays, what it has not gossiped about yet,
 * and at most one gossip round at a time. Rounds only run on spare compute: local work preempts them through
 * yield(), and work anywhere else on the machine pauses them until it has been quiet for a while.
 */
export class TeachatService {
  private readonly sessions = new Map<string, Session>();
  private running?: { controller: AbortController; done: Promise<unknown> };
  private roster?: Record<string, string>;
  private idleTimer?: NodeJS.Timeout;
  private idleView?: GossipView;
  private active = 0;
  private clock = 0;
  private constructor(readonly config: Config, readonly room: Room, private readonly options: TeachatOptions) {}

  /** Undefined unless teachat is enabled for this profile. */
  static async open(config: Config, options: TeachatOptions = {}): Promise<TeachatService | undefined> {
    if (!config.teachat?.enabled) return undefined;
    const service = new TeachatService(config, await openRoom({ dir: config.teachat.dir }), options);
    await service.refreshRoster();
    return service;
  }
  private get settings() { return this.config.teachat!; }
  private get dir() { return this.settings.dir; }
  async refreshRoster(): Promise<void> {
    this.roster = Object.fromEntries((await this.room.identities()).map(identity => [identity.username, identity.bio]));
  }
  private session(key: string): Session {
    let session = this.sessions.get(key);
    if (!session) this.sessions.set(key, session = { key, holder: `${process.pid}:${randomUUID()}`, transcript: [], gossiped: 0, announced: false, seen: 0 });
    return session;
  }

  /** The roster for the first turn's routing question, until the conversation has an identity. */
  identities(key = 'default'): Record<string, string> | undefined { return this.session(key).identity ? undefined : this.roster; }
  identity(key = 'default'): string | undefined { return this.sessions.get(key)?.identity; }

  /** Records a finished turn. The first one also settles who this conversation is, from Jev's routing answer when there is one. */
  async observe(turn: Turn & { teachatIdentity?: TeachatIdentityAnswer }, key = 'default'): Promise<void> {
    const session = this.session(key);
    session.transcript.push({ user: turn.user, assistant: turn.assistant });
    if (session.transcript.length > TRANSCRIPT_TURNS) { session.gossiped = Math.max(0, session.gossiped - 1); session.transcript.shift(); }
    // An unfinished round was about older turns.
    session.round = undefined; session.seen = ++this.clock;
    try {
      if (!session.identity) await this.assign(session, turn.user, turn.teachatIdentity);
      else if (!await this.room.renew(session.identity, session.holder, LEASE_MS)) session.identity = undefined;
    } catch { /* identity is settled again before gossiping */ }
    if (this.idleView) this.idle(this.idleView);
  }

  /** A new conversation (/new) plays a new identity. */
  async reset(key = 'default'): Promise<void> {
    const session = this.sessions.get(key);
    this.sessions.delete(key);
    if (session?.identity) await this.room.release(session.identity, session.holder).catch(() => false);
    await this.refreshRoster().catch(() => {});
  }

  private async assign(session: Session, request: string, answer?: TeachatIdentityAnswer, decider?: Decider, signal?: AbortSignal): Promise<void> {
    const pick = await pickIdentity({ decider, request, identities: await this.room.identities(), holder: session.holder, answer, signal });
    if (pick && await this.room.claim(pick.username, session.holder, LEASE_MS)) session.identity = pick.username;
  }

  pending(key?: string): boolean {
    return [...this.sessions.values()].some(session => (key === undefined || session.key === key) && session.transcript.length > session.gossiped);
  }

  /** Runs one gossip round for the conversation with the newest unshared turns. False when nothing ran to completion. */
  async run(view: GossipView, signal?: AbortSignal): Promise<boolean> {
    await this.yield();
    const session = [...this.sessions.values()].filter(candidate => candidate.transcript.length > candidate.gossiped).sort((a, b) => b.seen - a.seen)[0];
    if (!session) return false;
    const controller = new AbortController();
    const done = this.gossip(session, view, AbortSignal.any([controller.signal, ...(signal ? [signal] : [])]));
    this.running = { controller, done: done.catch(() => {}) };
    try { return await done; }
    catch (error) { if (isAbortError(error) || controller.signal.aborted || signal?.aborted) return false; throw error; }
    finally { if (this.running?.controller === controller) this.running = undefined; view.activity?.(undefined); }
  }

  /** Stops any round now (its progress is kept) and waits until it has let go of the state lock. */
  async yield(): Promise<void> {
    clearTimeout(this.idleTimer);
    const running = this.running;
    if (!running) return;
    running.controller.abort();
    await running.done;
  }

  /**
   * For surfaces without a composer (Discord, the bridge): from now on, gossip whenever no work() has run for the
   * idle period and there is something new to talk about.
   */
  idle(view: GossipView): void {
    this.idleView = view;
    clearTimeout(this.idleTimer);
    if (this.active || !this.pending()) return;
    this.idleTimer = setTimeout(() => {
      if (!this.active) void this.run(view).catch(error => view.line(`gossip failed: ${error instanceof Error ? error.message : String(error)}`, 'status'));
    }, this.settings.idleMs);
    this.idleTimer.unref();
  }
  /** Runs user work with gossip out of the way, and restarts the idle clock after it. */
  async work<T>(task: () => Promise<T>): Promise<T> {
    this.active++;
    try { await this.yield(); return await task(); }
    finally { if (!--this.active && this.idleView) this.idle(this.idleView); }
  }

  async close(): Promise<void> {
    this.idleView = undefined;
    await this.yield();
    for (const session of this.sessions.values()) if (session.identity) await this.room.release(session.identity, session.holder).catch(() => false);
    this.sessions.clear();
  }

  private async gossip(session: Session, view: GossipView, signal: AbortSignal): Promise<boolean> {
    const pollMs = this.options.pollMs ?? 1000;
    const pauseLimit = AbortSignal.timeout(this.options.pauseLimitMs ?? 30 * 60_000);
    for (let paused = false; ; ) {
      try {
        await waitUntilQuiet(this.dir, { graceMs: this.options.graceMs ?? 30_000, pollMs, signal: AbortSignal.any([signal, pauseLimit]), onPause: () => {
          if (!paused) view.line('gossip paused - teapilot is busy elsewhere', 'status');
          paused = true;
        } });
      } catch (error) {
        if (signal.aborted || !pauseLimit.aborted) throw error;
        // Paused for too long: this round is stale. Drop it.
        view.line('gossip dropped - teapilot stayed busy elsewhere', 'status');
        session.round = undefined; session.gossiped = session.transcript.length;
        return false;
      }
      let unlock: () => Promise<void>;
      try { unlock = await lockState(this.config.stateDir, { gossip: true }); }
      catch (error) { if (!(error instanceof StateBusyError)) throw error; await sleep(pollMs, undefined, { signal }); continue; }
      // Work elsewhere cannot be waited out mid-call, so the call is abandoned and its step retried later.
      const pause = new AbortController();
      const watcher = setInterval(() => { void othersBusy(this.dir).then(busy => { if (busy) pause.abort(); }, () => {}); }, pollMs);
      try {
        if (paused) { view.line('gossip resumed', 'status'); paused = false; }
        await this.attempt(session, view, AbortSignal.any([signal, pause.signal]));
        return true;
      } catch (error) {
        if (signal.aborted) throw error;
        if (pause.signal.aborted) continue;
        view.line(`gossip skipped: ${error instanceof Error ? error.message : String(error)}`, 'status');
        session.round = undefined; session.gossiped = session.transcript.length;
        return false;
      } finally { clearInterval(watcher); await unlock(); }
    }
  }

  private async attempt(session: Session, view: GossipView, signal: AbortSignal): Promise<void> {
    const { config, room } = this;
    const requestId = `teachat-${randomUUID()}`;
    const ledger = join(config.stateDir, 'spend.jsonl');
    const spent = new SpendGovernor(ledger, requestId, config.policy.budget);
    await spent.load();
    // Gossip has its own daily allowance, inside the profile's daily limit.
    const budget = new SpendGovernor(ledger, requestId, { requestUsd: Math.max(0, this.settings.dailyUsd - spent.dailyFor('teachat-')), dailyUsd: config.policy.budget.dailyUsd });
    await budget.load();
    const telemetry = new Telemetry(config.stateDir, requestId, [config.router.apiKey, ...Object.values(config.secrets)].filter((value): value is string => Boolean(value)));
    const decider = jevDecider(config, budget, telemetry, this.options.provider);
    const tier = (preferred: Parameters<typeof gossipTier>[1]) => {
      const found = gossipTier(config, preferred);
      if (!found) throw new Error('no local model is available for gossip');
      return found;
    };
    if (!session.identity) await this.assign(session, session.transcript[0]?.user ?? '', undefined, decider, signal);
    const identity = session.identity;
    if (!identity) throw new Error('every teachat identity is taken');
    await room.renew(identity, session.holder, LEASE_MS);
    view.activity?.(`${displayName(identity)} is gossiping...`);
    if (!session.announced) {
      const summary = await gossipCall(config, tier(['fast', 'normal']), budget, telemetry, announcePrompt(session.transcript[0]?.user ?? ''), { signal });
      await announceHandling(room, identity, summary);
      session.announced = true;
    }
    if (!session.round) view.line(`gossip · ${displayName(identity)}`, 'header');
    const state = session.round ??= {};
    const channels = (await room.channels()).map(channel => channel.id);
    const web = ask(config, true).tools.filter(tool => tool.name === 'web_search');
    await gossipRound({
      room, identity, decider, state, signal, minConfidence: config.policy.router.min_confidence,
      // New turns since the last round, with the one before for context.
      transcript: session.transcript.slice(Math.max(0, session.gossiped - 1)),
      gate: async step => { if (step === 'act') view.line(`→ #${state.channel} (${state.action})`, 'status'); },
      write: async (kind, prompt, stepSignal) => {
        const text = await gossipCall(config, tier(kind === 'conclusion' ? ['reasoning', 'normal', 'fast'] : ['fast', 'normal']), budget, telemetry, prompt, { signal: stepSignal });
        if (kind === 'conclusion') view.line(text.replace(/^\W*summary\W*:.*$/im, '').trim(), 'thought');
        return text;
      },
      act: async (prompt, _context, stepSignal) => {
        const tools = [...teachatTools(room, { identity, channels, redact: text => telemetry.redact(text),
          onPost: message => { state.acted = true; view.line(`${displayName(identity)} → #${message.channel}${message.replyTo ? ` (reply to #${message.replyTo})` : ''}: ${message.text}`, 'post'); },
          onBio: () => view.line(`${displayName(identity)} updated their bio`, 'status') }), ...web];
        await gossipCall(config, tier(['normal', 'fast']), budget, telemetry, prompt, { tools, maxTurns: 4, signal: stepSignal });
      },
    });
    session.gossiped = session.transcript.length; session.round = undefined;
    await this.refreshRoster().catch(() => {});
  }
}
