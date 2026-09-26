import { createHash, randomBytes } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import type { Action, Effect, Embed, Participants, User, View } from '@teapilot/discord-play';
import { maxOutputChars, type CallInput, type ContextData, type PlayEngine } from './engine.js';
import { describe, findControl, PlayError, renderEmbeds, renderModal, renderView, type MessagePayload, type ModalPayload } from './render.js';
import { sandbox } from './sandbox.js';
import type { PlayRecord, PlayStore } from './store.js';
import { trusted, type DiscordRequest } from './trusted.js';

/** Where an app's message lives; the gateway implements it. */
export interface PlaySurface {
  post(channelId: string, payload: MessagePayload): Promise<string>;
  edit(channelId: string, messageId: string, payload: MessagePayload): Promise<void>;
  /** Raw Discord REST, for trusted apps only. */
  request: DiscordRequest;
}
/** One click, selection or form submission on an app's message. */
export interface PlayInteraction {
  playId: string; controlId: string; kind: 'button' | 'select' | 'modal'; user: User;
  values?: string[]; fields?: Record<string, string>;
  /** First response only: show a form. */
  openModal(payload: ModalPayload): Promise<void>;
  /** First response only: a private note, leaving the message alone. */
  reply(content: string): Promise<void>;
  /** First response only: acknowledge now and edit the message later. */
  defer(): Promise<void>;
  /** After defer(): edit the app's message. */
  update(payload: MessagePayload): Promise<void>;
  /** After defer(): a private note to the person who acted. */
  followUp(content: string, embeds?: Array<Record<string, unknown>>): Promise<void>;
}
/** Asks the model on the app's behalf; resolves with the answer text. */
export type Consultant = (play: { title: string; owner: User; channelId: string }, prompt: string) => Promise<string>;
export type Source = PlayRecord['source'];
export interface StartOptions { title: string; channelId: string; conversation: string; owner: User; source: Source; participants?: Participants; emojis?: Record<string, string> }
export interface TestAction { kind: Action['kind']; id: string; user?: User; values?: string[]; fields?: Record<string, string>; text?: string; error?: string }
/** Time for apps, timers and expiry; a simulator swaps it to skip ahead. `after` returns a cancel function. */
export interface Clock { now(): number; after(ms: number, run: () => void): () => void }
export const systemClock: Clock = {
  now: () => Date.now(),
  after(ms, run) { const timer = setTimeout(run, ms); timer.unref?.(); return () => clearTimeout(timer); },
};

export const playLimits = {
  perChannel: 5, total: 50, idleMs: 24 * 60 * 60_000, keepFinishedMs: 7 * 24 * 60 * 60_000,
  timers: 10, minTimerMs: 1000, maxTimerMs: 24 * 60 * 60_000, consultsPerHour: 20, consultPromptChars: 4000,
  stateChars: 64_000, log: 20,
};
const idPattern = /^[A-Za-z0-9_.-]{1,64}$/;

interface Live {
  record: PlayRecord;
  engine?: PlayEngine;
  timers: Map<string, () => void>;
  consulting: boolean;
  chain: Promise<unknown>;
}
interface Advance { state: unknown; seed: number; view: View; payload: MessagePayload; effects: Effect[]; timers: PlayRecord['timers']; finished?: { summary?: string } }

export const hashFile = async (path: string) => createHash('sha256').update(await readFile(path)).digest('hex');
const errorText = (error: unknown) => error instanceof Error ? error.message : String(error);
const clip = (text: string, max: number) => text.length > max ? `${text.slice(0, max - 1)}…` : text;
const withNote = (payload: MessagePayload, note?: string): MessagePayload => note ? { ...payload, content: clip(`${payload.content}${payload.content ? '\n' : ''}-# ${note}`, 2000) } : payload;

function normalize(value: unknown): { state: unknown; effects: unknown[] } {
  if (typeof value === 'object' && value !== null && (value as { type?: unknown }).type === 'step' && 'state' in value) {
    const effects = (value as { effects?: unknown }).effects;
    return { state: (value as { state: unknown }).state ?? null, effects: Array.isArray(effects) ? effects : [] };
  }
  return { state: value ?? null, effects: [] };
}

function checkEffects(effects: unknown[]): Effect[] {
  return effects.map(effect => {
    const value = effect as Record<string, unknown>;
    if (typeof value !== 'object' || value === null) throw new PlayError('Effects must be built with ephemeral(), after(), cancel(), finish() or consult().');
    const key = (what: string) => { if (typeof value.id !== 'string' || !idPattern.test(value.id)) throw new PlayError(`${what} id must be 1–64 letters, digits, "_", "." or "-".`); return value.id; };
    switch (value.type) {
      case 'ephemeral':
        if (typeof value.content !== 'string' || value.content.length > 2000) throw new PlayError('ephemeral() content must be a string of at most 2000 characters.');
        if (value.embeds !== undefined) renderEmbeds(value.embeds);
        return value.embeds === undefined ? { type: 'ephemeral', content: value.content } : { type: 'ephemeral', content: value.content, embeds: value.embeds as Embed[] };
      case 'after':
        if (typeof value.ms !== 'number' || !Number.isFinite(value.ms) || value.ms < playLimits.minTimerMs || value.ms > playLimits.maxTimerMs) throw new PlayError(`after() takes ${playLimits.minTimerMs} ms to 24 hours.`);
        return { type: 'after', id: key('after()'), ms: value.ms };
      case 'cancel': return { type: 'cancel', id: key('cancel()') };
      case 'finish':
        if (value.summary !== undefined && typeof value.summary !== 'string') throw new PlayError('finish() summary must be a string.');
        return value.summary === undefined ? { type: 'finish' } : { type: 'finish', summary: clip(value.summary, 300) };
      case 'consult':
        if (typeof value.prompt !== 'string' || !value.prompt.trim() || value.prompt.length > playLimits.consultPromptChars) throw new PlayError(`consult() prompt must be 1–${playLimits.consultPromptChars} characters.`);
        return { type: 'consult', id: key('consult()'), prompt: value.prompt };
      default: throw new PlayError(`Unknown effect ${JSON.stringify(value.type)}.`);
    }
  });
}

function checkState(state: unknown): void {
  const size = JSON.stringify(state)?.length ?? 0;
  if (size > playLimits.stateChars) throw new PlayError(`State is ${size} characters as JSON; the limit is ${playLimits.stateChars}. Keep only what the app needs.`);
}

/**
 * Owns every discord.play app: runs actions one at a time per app, commits a new state only when
 * update, view and rendering all succeed, keeps timers and records on disk so apps survive a restart,
 * and answers every Discord interaction within Discord's three-second window.
 */
export class PlayRuntime {
  private readonly live = new Map<string, Live>();
  private sweeper?: () => void;

  constructor(private readonly options: {
    store: PlayStore; surface: PlaySurface; log: (text: string) => void;
    consult?: Consultant; clock?: Clock;
  }) {}

  private get clock(): Clock { return this.options.clock ?? systemClock; }
  private now(): number { return this.clock.now(); }

  private context(record: PlayRecord): ContextData {
    return { now: this.now(), invoker: record.owner, participants: record.participants, emojis: record.emojis, seed: record.seed };
  }

  private async build(source: Source): Promise<PlayEngine> {
    if (source.kind === 'sandbox') return sandbox(source.code);
    if (await hashFile(source.path).catch(() => undefined) !== source.sha256) throw new PlayError('The trusted app file changed since it was approved. Start or update it again to re-approve.');
    return trusted(source.path, this.options.surface.request, this.options.log);
  }

  private async engine(live: Live): Promise<PlayEngine> {
    if (!live.engine) {
      try { live.engine = await this.build(live.record.source); }
      catch (error) {
        if (live.record.source.kind === 'trusted') await this.halt(live, 'paused', `Paused: ${errorText(error)}`);
        throw error;
      }
    }
    return live.engine;
  }

  /** Runs one step without committing anything: update (or init), then view, then rendering. */
  private async advance(engine: PlayEngine, record: PlayRecord, action?: Action): Promise<Advance> {
    const input: CallInput = { state: record.state, action, ctx: this.context(record) };
    const result = await engine.call(action ? 'update' : 'init', input);
    const { state, effects } = normalize(result.value);
    checkState(state);
    const checked = checkEffects(effects);
    const shown = await engine.call('view', { state, ctx: { ...input.ctx, seed: result.seed } });
    const finish = checked.find(effect => effect.type === 'finish');
    const payload = renderView(record.id, shown.value, Boolean(finish));
    const timers = new Map(record.timers.map(timer => [timer.id, timer.dueAt]));
    for (const effect of checked) {
      if (effect.type === 'after') timers.set(effect.id, input.ctx.now + effect.ms);
      else if (effect.type === 'cancel') timers.delete(effect.id);
    }
    if (finish) timers.clear();
    if (timers.size > playLimits.timers) throw new PlayError(`An app may have ${playLimits.timers} timers pending.`);
    return { state, seed: shown.seed, view: shown.value as View, payload: withNote(payload, finish?.summary), effects: checked, timers: [...timers].map(([id, dueAt]) => ({ id, dueAt })), finished: finish ? { summary: finish.summary } : undefined };
  }

  private remember(record: PlayRecord, action: string, error?: string): void {
    record.log = [...record.log, { at: this.now(), action, ...(error ? { error: clip(error, 500) } : {}) }].slice(-playLimits.log);
  }

  /** Commits a step and schedules its timers and consults; returns the private notes for whoever acted. */
  private commit(live: Live, step: Advance, action: string): Array<Extract<Effect, { type: 'ephemeral' }>> {
    const { record } = live;
    record.state = step.state; record.seed = step.seed; record.view = step.view; record.updatedAt = this.now();
    this.remember(record, action);
    record.timers = step.timers;
    if (step.finished) { record.status = 'finished'; record.note = step.finished.summary; }
    this.options.store.save(record);
    this.arm(live);
    if (step.finished) this.release(live);
    else for (const effect of step.effects) if (effect.type === 'consult') this.consult(live, effect);
    return step.effects.filter((effect): effect is Extract<Effect, { type: 'ephemeral' }> => effect.type === 'ephemeral');
  }

  /** One action, serialized with every other action on the same app. Failures change nothing. */
  private async dispatch(live: Live, action: Action, label: string): Promise<{ payload: MessagePayload; notes: Array<Extract<Effect, { type: 'ephemeral' }>> }> {
    try {
      const step = await this.advance(await this.engine(live), live.record, action);
      return { payload: step.payload, notes: this.commit(live, step, label) };
    } catch (error) {
      this.remember(live.record, label, errorText(error));
      this.options.store.save(live.record);
      throw error;
    }
  }

  private serial<T>(live: Live, task: () => Promise<T>): Promise<T> {
    const run = live.chain.then(task, task);
    live.chain = run.catch(() => undefined);
    return run;
  }

  /** Timers and consult answers: no one is waiting on an interaction, so the message is edited directly. */
  private background(live: Live, action: Action, label: string): Promise<void> {
    return this.serial(live, async () => {
      if (live.record.status !== 'running' || !this.live.has(live.record.id)) return;
      try {
        const { payload, notes } = await this.dispatch(live, action, label);
        if (notes.length) this.options.log(`play ${live.record.id}: ${notes.length} private note(s) from ${label} had no one to go to.`);
        if (live.record.messageId) await this.options.surface.edit(live.record.channelId, live.record.messageId, payload);
      } catch (error) { this.options.log(`play ${live.record.id}: ${label} failed: ${errorText(error)}`); }
    });
  }

  private arm(live: Live): void {
    for (const cancel of live.timers.values()) cancel();
    live.timers.clear();
    if (live.record.status !== 'running') return;
    for (const { id, dueAt } of live.record.timers) {
      live.timers.set(id, this.clock.after(Math.max(0, dueAt - this.now()), () => {
        live.timers.delete(id);
        live.record.timers = live.record.timers.filter(entry => entry.id !== id);
        void this.background(live, { kind: 'timer', id }, `timer ${id}`);
      }));
    }
  }

  private consult(live: Live, effect: Extract<Effect, { type: 'consult' }>): void {
    const { record } = live;
    const answer = (result: { text?: string; error?: string }) => void this.background(live, { kind: 'consult', id: effect.id, ...result }, `consult ${effect.id}`);
    record.consults = record.consults.filter(at => at > this.now() - 60 * 60_000);
    if (!this.options.consult) return queueMicrotask(() => answer({ error: 'Consulting the model is not available here.' }));
    if (live.consulting) return queueMicrotask(() => answer({ error: 'Another consult is still running; wait for its answer first.' }));
    if (record.consults.length >= playLimits.consultsPerHour) return queueMicrotask(() => answer({ error: `This app has used its ${playLimits.consultsPerHour} consults for the hour.` }));
    record.consults.push(this.now());
    this.options.store.save(record);
    live.consulting = true;
    void this.options.consult({ title: record.title, owner: record.owner, channelId: record.channelId }, effect.prompt)
      .then(text => ({ text: clip(text, 4000) }), error => ({ error: errorText(error) }))
      .then(result => { live.consulting = false; answer(result); });
  }

  private release(live: Live): void {
    for (const cancel of live.timers.values()) cancel();
    live.timers.clear();
    live.engine?.dispose();
    live.engine = undefined;
  }

  /** Ends or pauses an app without running its code: the last view stays, with controls disabled. */
  private async halt(live: Live, status: 'finished' | 'paused', note: string): Promise<void> {
    const { record } = live;
    record.status = status; record.note = note; record.timers = []; record.updatedAt = this.now();
    this.remember(record, status === 'finished' ? 'stop' : 'pause');
    this.release(live);
    this.options.store.save(record);
    if (!record.messageId) return;
    let payload: MessagePayload;
    try { payload = renderView(record.id, record.view, true); } catch { payload = { content: '', embeds: [], components: [], allowedMentions: { parse: [] } }; }
    await this.options.surface.edit(record.channelId, record.messageId, withNote(payload, note))
      .catch(error => this.options.log(`play ${record.id}: could not update its message: ${errorText(error)}`));
  }

  private allowed(record: PlayRecord, user: string): boolean {
    return record.participants === 'everyone' || (record.participants === 'invoker' ? record.owner.id === user : record.participants.includes(user));
  }

  private running(channelId?: string): PlayRecord[] {
    return [...this.live.values()].map(live => live.record).filter(record => record.status === 'running' && (!channelId || record.channelId === channelId));
  }

  /** Loads the app, checks its first state and view, posts it, and starts its timers. */
  async start(options: StartOptions): Promise<{ record: PlayRecord; preview: string }> {
    if (this.running(options.channelId).length >= playLimits.perChannel) throw new PlayError(`This channel already has ${playLimits.perChannel} apps running; stop one first.`);
    if (this.running().length >= playLimits.total) throw new PlayError(`teapilot already runs ${playLimits.total} apps; stop one first.`);
    const engine = await this.build(options.source);
    try {
      const now = this.now();
      const record: PlayRecord = {
        id: randomBytes(8).toString('hex').slice(0, 10), title: clip(options.title, 100), owner: options.owner, channelId: options.channelId, conversation: options.conversation,
        participants: 'everyone', source: options.source, state: null, seed: randomBytes(4).readUInt32LE(), view: {}, emojis: options.emojis ?? {},
        timers: [], consults: [], status: 'running', log: [], createdAt: now, updatedAt: now,
      };
      const meta = (await engine.call('meta', { ctx: this.context(record) })).value as { participants?: unknown } | null;
      record.participants = checkParticipants(options.participants ?? meta?.participants ?? 'everyone');
      const step = await this.advance(engine, record);
      const live: Live = { record, engine, timers: new Map(), consulting: false, chain: Promise.resolve() };
      record.messageId = await this.options.surface.post(record.channelId, step.payload);
      this.live.set(record.id, live);
      this.commit(live, step, 'start');
      return { record, preview: describe(step.view) };
    } catch (error) { engine.dispose(); throw error; }
  }

  /** Swaps in new code. Keeping state lets a fix land mid-game; the view re-renders in place. */
  async update(id: string, conversation: string, source: Source | undefined, reset: boolean): Promise<{ record: PlayRecord; preview: string }> {
    const live = this.owned(id, conversation);
    return this.serial(live, async () => {
      const engine = source ? await this.build(source) : await this.engine(live);
      const record: PlayRecord = { ...live.record, source: source ?? live.record.source, status: 'running', note: undefined, ...(reset ? { state: null, timers: [] } : {}) };
      try {
        const step = reset ? await this.advance(engine, record) : await (async () => {
          const shown = await engine.call('view', { state: record.state, ctx: this.context(record) });
          return { state: record.state, seed: shown.seed, view: shown.value as View, payload: renderView(record.id, shown.value), effects: [], timers: record.timers } satisfies Advance;
        })();
        if (live.engine !== engine) live.engine?.dispose();
        live.engine = engine;
        live.record = record;
        this.commit(live, step, reset ? 'restart' : 'update');
        if (record.messageId) await this.options.surface.edit(record.channelId, record.messageId, step.payload);
        return { record, preview: describe(step.view) };
      } catch (error) { if (live.engine !== engine) engine.dispose(); throw error; }
    });
  }

  /** A dry run with no message, persistence or timers, so the model can check an app before posting it. */
  async test(source: Source, actions: TestAction[], owner: User, options: { participants?: Participants; emojis?: Record<string, string> } = {}): Promise<string> {
    const engine = await this.build(source);
    const record: PlayRecord = { id: 'test', title: 'test', owner, channelId: '', conversation: '', participants: options.participants ?? 'everyone', source, state: null, seed: 1, view: {}, emojis: options.emojis ?? {}, timers: [], consults: [], status: 'running', log: [], createdAt: 0, updatedAt: 0 };
    const lines: string[] = [];
    const show = (label: string, step: Advance) => {
      record.state = step.state; record.seed = step.seed;
      lines.push(`## ${label}`, `state: ${clip(JSON.stringify(step.state), 1500)}`, describe(step.view));
      if (step.effects.length) lines.push(`effects: ${clip(JSON.stringify(step.effects), 800)}`);
    };
    try {
      show('start', await this.advance(engine, record));
      for (const [index, action] of actions.entries()) {
        const label = `${index + 1}. ${action.kind} ${action.id}`;
        try { show(label, await this.advance(engine, record, toAction(action, owner))); }
        catch (error) { lines.push(`## ${label}`, `error: ${errorText(error)}`); break; }
      }
    } finally { engine.dispose(); }
    return clip(lines.join('\n'), maxOutputChars / 8);
  }

  inspect(id: string, conversation: string): string {
    const { record } = this.owned(id, conversation);
    return JSON.stringify({ id: record.id, title: record.title, status: record.status, note: record.note, participants: record.participants, source: record.source.kind === 'trusted' ? { trusted: record.source.path } : 'sandbox', timers: record.timers, state: record.state, recentActions: record.log });
  }

  list(conversation: string): Array<{ id: string; title: string; status: string }> {
    return [...this.live.values()].map(live => live.record).filter(record => record.conversation === conversation).map(({ id, title, status }) => ({ id, title, status }));
  }

  async stop(id: string, conversation: string, summary = 'Stopped.'): Promise<void> {
    const live = this.owned(id, conversation);
    await this.serial(live, () => this.halt(live, 'finished', summary));
  }

  /** An app is managed only from the conversation that started it. */
  private owned(id: string, conversation: string): Live {
    const live = this.live.get(id);
    if (!live || live.record.conversation !== conversation) throw new PlayError(`No app ${id} in this conversation. Use play_list.`);
    return live;
  }

  async interact(interaction: PlayInteraction): Promise<void> {
    const live = this.live.get(interaction.playId);
    const record = live?.record;
    if (!live || !record || record.status !== 'running') { await interaction.reply(record?.status === 'paused' ? `This app is paused. ${record.note ?? ''}`.trim() : 'This app has ended.'); return; }
    if (!this.allowed(record, interaction.user.id)) {
      await interaction.reply(record.participants === 'invoker' ? `Only <@${record.owner.id}> can use this app.` : `This app is for ${(record.participants as string[]).map(id => `<@${id}>`).join(', ')}.`);
      return;
    }
    const current = () => {
      const view = live.record.view;
      if (interaction.kind === 'modal') return (view.rows ?? []).some(row => row.controls.some(control => control.type === 'button' && control.opens?.id === interaction.controlId));
      const control = findControl(view, interaction.controlId);
      return Boolean(control && !control.disabled && (control.type === 'select') === (interaction.kind === 'select'));
    };
    if (!current()) { await interaction.reply('That control is no longer available.'); return; }
    const control = interaction.kind === 'button' ? findControl(record.view, interaction.controlId) : undefined;
    if (control?.type === 'button' && control.opens) { await interaction.openModal(renderModal(record.id, control.opens)); return; }
    await interaction.defer();
    await this.serial(live, async () => {
      if (live.record.status !== 'running') { await interaction.followUp('This app has ended.'); return; }
      if (!current()) { await interaction.followUp('That control changed before your action arrived.'); return; }
      const action = toAction({ kind: interaction.kind, id: interaction.controlId, values: interaction.values, fields: interaction.fields }, interaction.user);
      try {
        const { payload, notes } = await this.dispatch(live, action, `${interaction.kind} ${interaction.controlId} by ${interaction.user.id}`);
        await interaction.update(payload);
        for (const note of notes) await interaction.followUp(note.content, note.embeds && renderEmbeds(note.embeds));
      } catch (error) {
        this.options.log(`play ${record.id}: ${errorText(error)}`);
        await interaction.followUp(`The app hit an error, so nothing changed. ${clip(errorText(error), 300)}`).catch(() => undefined);
      }
    });
  }

  /** Reloads running apps after a restart. Engines load on first use; trusted apps are re-checked then. */
  async recover(): Promise<number> {
    let count = 0;
    for (const record of this.options.store.all()) {
      if (this.live.has(record.id)) continue;
      if (record.status !== 'running') {
        if (record.updatedAt < this.now() - playLimits.keepFinishedMs) this.options.store.remove(record.id);
        else if (record.status === 'paused') this.live.set(record.id, { record, timers: new Map(), consulting: false, chain: Promise.resolve() });
        continue;
      }
      const live: Live = { record, timers: new Map(), consulting: false, chain: Promise.resolve() };
      this.live.set(record.id, live);
      if (record.source.kind === 'trusted' && await hashFile(record.source.path).catch(() => undefined) !== record.source.sha256) {
        await this.halt(live, 'paused', 'Paused: the trusted app file changed while teapilot was stopped. Ask teapilot to update it to re-approve.');
        continue;
      }
      this.arm(live);
      count++;
    }
    if (!this.sweeper) this.schedule();
    return count;
  }

  private schedule(): void {
    this.sweeper = this.clock.after(10 * 60_000, () => void this.sweep().finally(() => { if (this.sweeper) this.schedule(); }));
  }

  /** Apps nobody has touched for a day end, so abandoned games do not hold resources forever. */
  async sweep(): Promise<void> {
    for (const live of this.live.values()) {
      if (live.record.status === 'running' && live.record.updatedAt < this.now() - playLimits.idleMs) {
        await this.serial(live, () => this.halt(live, 'finished', 'Ended after a day without activity.'));
      }
      if (live.record.status !== 'running' && live.record.updatedAt < this.now() - playLimits.keepFinishedMs) {
        this.live.delete(live.record.id);
        this.options.store.remove(live.record.id);
      }
    }
  }

  close(): void {
    this.sweeper?.();
    this.sweeper = undefined;
    for (const live of this.live.values()) this.release(live);
  }
}

function checkParticipants(value: unknown): Participants {
  if (value === 'everyone' || value === 'invoker') return value;
  if (Array.isArray(value) && value.length && value.length <= 25 && value.every(id => typeof id === 'string' && /^\d{17,20}$/.test(id))) return [...new Set(value as string[])];
  throw new PlayError('participants must be "everyone", "invoker" or a list of 1–25 Discord user IDs.');
}

function toAction(action: TestAction, user: User): Action {
  switch (action.kind) {
    case 'button': return { kind: 'button', id: action.id, user: action.user ?? user };
    case 'select': return { kind: 'select', id: action.id, user: action.user ?? user, values: (action.values ?? []).map(String).slice(0, 25) };
    case 'modal': return { kind: 'modal', id: action.id, user: action.user ?? user, fields: Object.fromEntries(Object.entries(action.fields ?? {}).slice(0, 5).map(([key, value]) => [key, String(value).slice(0, 4000)])) };
    case 'timer': return { kind: 'timer', id: action.id };
    case 'consult': return { kind: 'consult', id: action.id, ...(action.error !== undefined ? { error: action.error } : { text: action.text ?? '' }) };
  }
}
