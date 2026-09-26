// An in-memory Discord for testing teapilot's Discord features without Discord. It stands in for
// src/discord/gateway.ts only: routing, conversations, models and discord.play all run for real.
// Everything the bot sends is checked the way discord.js and Discord would check it.
import type { DiscordTransport } from '../../src/discord/bridge.js';
import type { connect, GatewayHandlers } from '../../src/discord/gateway.js';
import { parseCustomId, type ModalPayload } from '../../src/discord/play/render.js';
import type { PlayInteraction } from '../../src/discord/play/runtime.js';
import type { DiscordSettings } from '../../src/discord/settings.js';
import { checkMessage, checkModal, DiscordRejected } from './validate.js';

type Json = Record<string, unknown>;
type Row = { type: number; components: Json[] };
interface Payload { content?: string; embeds?: Json[]; components?: Row[] }

export interface Person { name: string; id: string }
/** An operator, a whitelisted user, and someone teapilot does not know. */
export const people = {
  op: { name: 'op', id: '100000000000000001' },
  user: { name: 'user', id: '100000000000000002' },
  stranger: { name: 'stranger', id: '100000000000000003' },
} satisfies Record<string, Person>;
export type PersonName = keyof typeof people;
export const bot: Person = { name: 'teapilot', id: '100000000000000000' };
export const guildId = '300000000000000001';
export const channelId = '200000000000000001';

export interface Channel { id: string; name: string; kind: 'dm' | 'channel' | 'thread'; parent?: string }
export interface Message {
  id: string; channel: Channel; author: string; content: string; embeds: Json[]; components: Row[];
  /** Ephemeral: only this person sees it. */
  only?: string;
  edits: number;
  /** Set while approve/deny buttons on this message are waiting. */
  approval?: (approved: boolean) => void;
}

/** A mistake in how the simulator was asked to act, such as clicking a control that does not exist. */
export class SimError extends Error {}

const styles: Record<number, string> = { 1: 'primary', 3: 'success', 4: 'danger' };
const settle = (text: string, verdict: string) => `${text.slice(0, 2000 - verdict.length - 2)}\n\n${verdict}`;
const pause = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

export class World {
  readonly messages: Message[] = [];
  /** The operator log from teapilot, oldest first. */
  readonly logs: string[] = [];
  private readonly channels = new Map<string, Channel>([['channel', { id: channelId, name: 'channel', kind: 'channel' }]]);
  /** The form each person has open, by name; Discord shows one at a time. */
  private readonly forms = new Map<string, { message: Message; payload: ModalPayload }>();
  private readonly listeners = new Set<(text: string) => void>();
  private handlers?: GatewayHandlers;
  private operators: readonly string[] = [];
  private counters = { message: 0, thread: 0, approval: 0 };
  private recent?: Channel;
  private lastEvent = Date.now();

  /** Every message, edit, warning and log line, as the text `screen` shows. */
  onEvent(listener: (text: string) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }
  private emit(text: string): void {
    this.lastEvent = Date.now();
    for (const listener of this.listeners) listener(text);
  }
  warn(text: string): void { this.logs.push(`⚠ ${text}`); this.emit(`⚠ ${text}`); }
  log = (text: string): void => { this.logs.push(text); this.emit(`[log] ${text}`); };

  get connected(): boolean { return Boolean(this.handlers); }
  /** When the last message, edit, warning or log line happened. */
  get lastActivity(): number { return this.lastEvent; }

  /** Drop-in for gateway.ts's connect(). */
  connect: typeof connect = async (settings: DiscordSettings, handlers: GatewayHandlers) => {
    this.handlers = handlers;
    this.operators = settings.allowedUserIds;
    return {
      botName: `${bot.name} (simulated)`,
      username: async id => Object.values(people).find(person => person.id === id)?.name,
      play: {
        post: async (channel, payload) => this.post(this.channel(channel), bot.name, payload as Payload).id,
        edit: async (channel, id, payload) => {
          const message = this.find(id);
          if (message.channel.id !== channel) throw new Error('Unknown Message');
          this.update(message, payload as Payload);
        },
        request: async (method, route) => {
          this.warn(`A trusted app called Discord REST ${method} ${route}; the simulator does not emulate REST routes.`);
          throw new Error('The Discord simulator does not emulate REST routes.');
        },
      },
      close: async () => {
        this.handlers = undefined;
        // Like the real gateway: pending approvals resolve as denied, and their buttons stay behind.
        for (const message of this.messages) { const resolve = message.approval; message.approval = undefined; resolve?.(false); }
      },
    };
  };

  person(name: string): Person {
    const person = people[name as PersonName];
    if (!person) throw new SimError(`Unknown person ${name}. Use ${Object.keys(people).join(', ')}.`);
    return person;
  }
  private nameOf(id: string): string { return [bot, ...Object.values(people)].find(person => person.id === id)?.name ?? id; }

  channel(ref: string): Channel {
    const channel = this.channels.get(ref) ?? [...this.channels.values()].find(entry => entry.id === ref);
    if (!channel) throw new SimError(`No channel ${ref}. Channels: ${[...this.channels.keys()].join(', ')}.`);
    return channel;
  }
  private dm(person: Person): Channel {
    const name = `dm-${person.name}`;
    if (!this.channels.has(name)) this.channels.set(name, { id: name, name, kind: 'dm' });
    return this.channels.get(name)!;
  }

  find(ref: string): Message {
    const id = /^\d+$/.test(ref) ? `m${ref}` : ref;
    const message = this.messages.find(entry => entry.id === id);
    if (!message) throw new SimError(`No message ${ref}.`);
    return message;
  }

  /** Mentions typed as @op, @user, @stranger or @teapilot become Discord mentions. */
  private mention(text: string): string {
    return text.replace(/@(\w+)\b/g, (match, name: string) => name === bot.name ? `<@${bot.id}>` : name in people ? `<@${people[name as PersonName].id}>` : match);
  }
  private display(text: string): string { return text.replace(/<@!?(\d+)>/g, (_match, id: string) => `@${this.nameOf(id)}`); }

  private check(what: string, run: () => void): void {
    try { run(); } catch (error) {
      if (error instanceof DiscordRejected) this.warn(`Discord would reject ${what}: ${error.message}`);
      throw error;
    }
  }

  private post(channel: Channel, author: string, payload: Payload, only?: string): Message {
    if (author === bot.name) this.check(`a message in #${channel.name}`, () => checkMessage(payload));
    const message: Message = { id: `m${++this.counters.message}`, channel, author, content: payload.content ?? '', embeds: payload.embeds ?? [], components: payload.components ?? [], only, edits: 0 };
    this.messages.push(message);
    this.recent = channel;
    this.emit(this.render(message));
    return message;
  }

  private update(message: Message, payload: Payload): void {
    const next = { content: payload.content ?? message.content, embeds: payload.embeds ?? message.embeds, components: payload.components ?? message.components };
    this.check(`an edit to ${message.id}`, () => checkMessage(next));
    Object.assign(message, next);
    message.edits++;
    this.emit(this.render(message));
  }

  transport(channel: Channel): DiscordTransport {
    return {
      send: async text => this.post(channel, bot.name, { content: text }).id,
      edit: async (id, text) => this.update(this.find(id), { content: text }),
      typing: () => undefined,
      askApproval: (text, signal) => {
        if (signal.aborted) return Promise.resolve(false);
        const nonce = ++this.counters.approval;
        const message = this.post(channel, bot.name, { content: text, components: [{ type: 1, components: [
          { type: 2, style: 3, label: 'Approve', custom_id: `teapilot:${nonce}:approve` },
          { type: 2, style: 4, label: 'Deny', custom_id: `teapilot:${nonce}:deny` },
        ] }] });
        return new Promise<boolean>(resolve => {
          const expire = () => {
            if (!message.approval) return;
            message.approval = undefined;
            this.update(message, { content: settle(text, '**Denied** (expired or cancelled)'), components: [] });
            resolve(false);
          };
          message.approval = approved => { signal.removeEventListener('abort', expire); resolve(approved); };
          signal.addEventListener('abort', expire, { once: true });
        });
      },
    };
  }

  /** A person sends a message: in their DM by default, in `channel` (mentioning teapilot), or in a thread. */
  say(name: string, text: string, where?: string): Message {
    const person = this.person(name);
    const handlers = this.handlers;
    if (!handlers) throw new SimError('teapilot is not connected.');
    const channel = where ? this.channel(where) : this.dm(person);
    if (channel.kind === 'dm' && channel.name !== `dm-${person.name}`) throw new SimError(`${channel.name} is someone else's DM.`);
    let content = this.mention(text);
    if (channel.kind === 'channel' && !content.includes(`<@${bot.id}>`)) content = `<@${bot.id}> ${content}`;
    const message = this.post(channel, person.name, { content });
    const thread = channel.kind === 'thread' ? channel : undefined;
    handlers.message({
      authorId: person.id, authorIsBot: false, authorName: person.name,
      guildId: channel.kind === 'dm' ? undefined : guildId, channelId: channel.id, parentId: thread?.parent,
      ownThread: Boolean(thread), mentionsBot: content.includes(`<@${bot.id}>`),
      // The gateway strips mentions of the bot.
      content: content.replaceAll(`<@${bot.id}>`, '').trim(),
      replyChain: async () => ({ messages: [], truncated: false }),
      transport: () => this.transport(channel),
      startThread: async title => {
        const name = `thread-${++this.counters.thread}`;
        const created: Channel = { id: name, name, kind: 'thread', parent: channel.id };
        this.channels.set(name, created);
        this.emit(`# ${name} started from ${message.id}: ${title.slice(0, 90)}`);
        return { id: created.id, transport: this.transport(created) };
      },
    });
    return message;
  }

  private visible(ref: string, person: Person): Message {
    const message = this.find(ref);
    if (message.only && message.only !== person.name) throw new SimError(`${person.name} cannot see ${message.id}; only ${message.only} can.`);
    return message;
  }
  private controls(message: Message): Json[] { return message.components.flatMap(row => row.components); }
  private controlId(control: Json): string | undefined {
    if (typeof control.custom_id !== 'string') return undefined;
    return parseCustomId(control.custom_id)?.id ?? control.custom_id.split(':')[2];
  }
  private control(message: Message, id: string): Json {
    const control = this.controls(message).find(entry => this.controlId(entry) === id || (entry.url && entry.label === id));
    if (!control) {
      const ids = this.controls(message).map(entry => this.controlId(entry) ?? String(entry.label)).join(', ');
      throw new SimError(`${message.id} has no control ${id}.${ids ? ` Controls: ${ids}.` : ''}`);
    }
    if (control.disabled) throw new SimError(`${id} on ${message.id} is disabled; Discord does not let anyone use it.`);
    return control;
  }

  async click(name: string, ref: string, id: string): Promise<string> {
    const person = this.person(name);
    const message = this.visible(ref, person);
    const control = this.control(message, id);
    if (control.type !== 2) throw new SimError(`${id} is a select; use select.`);
    if (typeof control.url === 'string') return `${person.name} opened ${control.url}; links never reach teapilot.`;
    const custom = String(control.custom_id);
    if (custom.startsWith('teapilot:')) return this.answerApproval(person, message, custom.endsWith(':approve'));
    return this.interact(person, message, 'button', custom, `clicked [${this.label(control)}]`);
  }

  /** Like the real gateway: only operators may answer approvals. */
  private answerApproval(person: Person, message: Message, approved: boolean): string {
    const note = (content: string) => this.render(this.post(message.channel, bot.name, { content }, person.name));
    if (!this.operators.includes(person.id)) return note('You are not allowed to approve teapilot actions.');
    const resolve = message.approval;
    if (!resolve) return note('This approval is no longer pending.');
    message.approval = undefined;
    this.update(message, { content: settle(message.content, `**${approved ? 'Approved' : 'Denied'}** by <@${person.id}>`), components: [] });
    resolve(approved);
    return `${person.name} ${approved ? 'approved' : 'denied'} ${message.id}.`;
  }

  /** The newest approval still waiting, if any. */
  pendingApproval(): Message | undefined { return this.messages.findLast(message => message.approval); }

  async select(name: string, ref: string, id: string, choices: string[]): Promise<string> {
    const person = this.person(name);
    const message = this.visible(ref, person);
    const control = this.control(message, id);
    if (control.type !== 3) throw new SimError(`${id} is a button; use click.`);
    const options = control.options as Array<{ label: string; value: string }>;
    // Discord's client enforces the options and counts; accept a label or a value.
    const values = choices.map(choice => {
      const option = options.find(entry => entry.value === choice) ?? options.find(entry => entry.label === choice);
      if (!option) throw new SimError(`${id} has no option ${choice}. Options: ${options.map(entry => entry.value).join(', ')}.`);
      return option.value;
    });
    const min = (control.min_values as number | undefined) ?? 1, max = (control.max_values as number | undefined) ?? 1;
    if (values.length < min || values.length > max) throw new SimError(`${id} takes ${min === max ? min : `${min}–${max}`} choice(s), not ${values.length}.`);
    return this.interact(person, message, 'select', String(control.custom_id), `chose ${values.join(', ')} in <${id}>`, values);
  }

  /** Submits the form this person has open, as Discord's client would after checking it. */
  async submit(name: string, fields: Record<string, string>): Promise<string> {
    const person = this.person(name);
    const form = this.forms.get(person.name);
    if (!form) throw new SimError(`${person.name} has no form open. Click the button that opens it first.`);
    const inputs = form.payload.components.map(row => row.components[0]!);
    const ids = inputs.map(input => String(input.custom_id));
    const unknown = Object.keys(fields).filter(key => !ids.includes(key));
    if (unknown.length) throw new SimError(`The form has no field ${unknown.join(', ')}. Fields: ${ids.join(', ')}.`);
    for (const input of inputs) {
      const value = fields[String(input.custom_id)] ?? '';
      if (input.required !== false && !value) throw new SimError(`${String(input.custom_id)} is required.`);
      if (typeof input.max_length === 'number' && value.length > input.max_length) throw new SimError(`${String(input.custom_id)} takes at most ${input.max_length} characters.`);
      if (typeof input.min_length === 'number' && value && value.length < input.min_length) throw new SimError(`${String(input.custom_id)} needs at least ${input.min_length} characters.`);
    }
    this.forms.delete(person.name);
    return this.interact(person, form.message, 'modal', form.payload.custom_id, `submitted "${form.payload.title}"`, undefined, Object.fromEntries(ids.map(key => [key, fields[key] ?? ''])));
  }

  /** One component interaction, held to Discord's rules: one first response within 3 s, and edits only after it. */
  private async interact(person: Person, message: Message, kind: PlayInteraction['kind'], custom: string, action: string, values?: string[], fields?: Record<string, string>): Promise<string> {
    const handlers = this.handlers;
    if (!handlers) throw new SimError('teapilot is not connected.');
    const target = parseCustomId(custom);
    if (!target) throw new SimError(`${custom} is not a discord.play control.`);
    const seen: string[] = [`${person.name} ${action} on ${message.id}.`];
    const started = Date.now();
    let state: 'new' | 'deferred' | 'replied' | 'form' = 'new';
    let updated = false, notes = 0;
    const first = (what: string) => {
      if (state !== 'new') throw new Error(`Interaction has already been acknowledged (${what}).`);
      const late = Date.now() - started;
      if (late > 3000) { this.warn(`${what} came ${late} ms after ${person.name}'s ${kind} on ${message.id}; Discord allows 3000 ms, so it shows "This interaction failed".`); throw new Error('Unknown interaction'); }
    };
    const note = (content: string, embeds?: Json[]) => {
      notes++;
      seen.push(this.render(this.post(message.channel, bot.name, { content, embeds }, person.name)));
    };
    const interaction: PlayInteraction = {
      playId: target.playId, controlId: target.id, kind, user: { id: person.id, name: person.name }, values, fields,
      openModal: async payload => {
        if (kind === 'modal') throw new Error('A form cannot open another form.');
        first('showModal');
        this.check(`the form on ${message.id}`, () => checkModal(payload));
        state = 'form';
        this.forms.set(person.name, { message, payload });
        seen.push(`${person.name} sees a form:\n${this.renderForm(payload)}`);
        this.emit(`${person.name} opened form "${payload.title}" from ${message.id}`);
      },
      reply: async content => { first('reply'); state = 'replied'; note(content); },
      defer: async () => { first('deferUpdate'); state = 'deferred'; },
      update: async payload => {
        if (state !== 'deferred') throw new Error('editReply before deferUpdate.');
        this.update(message, payload as Payload);
        updated = true;
      },
      followUp: async (content, embeds) => {
        if (state === 'new') throw new Error('followUp before the interaction was acknowledged.');
        note(content, embeds);
      },
    };
    const unanswered = setTimeout(() => { if (state === 'new') this.warn(`Nothing answered ${person.name}'s ${kind} on ${message.id} within 3 s; Discord shows "This interaction failed".`); }, 3000);
    handlers.component(interaction);
    const done = () => state === 'form' || state === 'replied' || (state === 'deferred' && (updated || notes > 0));
    for (const deadline = Date.now() + 15_000; !done() && Date.now() < deadline;) await pause(20);
    clearTimeout(unanswered);
    // Notes can follow an update; give them a moment.
    await this.quiet(150, 1000);
    if (updated) seen.push(this.render(message));
    if (!done()) seen.push('(no response after 15 s; check screen later)');
    return seen.join('\n');
  }

  /** Resolves once nothing has happened for `ms`, or after `max`. */
  async quiet(ms: number, max: number): Promise<void> {
    for (const deadline = Date.now() + max; Date.now() - this.lastEvent < ms && Date.now() < deadline;) await pause(Math.min(ms, 20));
  }

  private label(control: Json): string {
    const emoji = control.emoji as { id?: string; name?: string } | undefined;
    const icon = emoji ? emoji.id ? `:${emoji.name}:` : emoji.name : undefined;
    return [icon, control.label].filter(Boolean).join(' ');
  }

  private renderControl(control: Json): string {
    if (control.type === 2) {
      if (typeof control.url === 'string') return `[${this.label(control)}](${control.url})`;
      const notes = [this.controlId(control), styles[control.style as number], control.disabled ? 'disabled' : undefined].filter(Boolean);
      return `[${this.label(control)}](${notes.join(', ')})`;
    }
    const options = (control.options as Array<{ label: string; value: string; default?: boolean }>).map(option => `${option.label === option.value ? option.label : `${option.label}=${option.value}`}${option.default ? '*' : ''}`);
    const min = (control.min_values as number | undefined) ?? 1, max = (control.max_values as number | undefined) ?? 1;
    return `<select ${this.controlId(control)}${min === 1 && max === 1 ? '' : ` ${min}–${max}`}${control.disabled ? ', disabled' : ''}${control.placeholder ? ` "${String(control.placeholder)}"` : ''}: ${options.join(' | ')}>`;
  }

  private renderEmbed(embed: Json): string[] {
    const lines: string[] = [];
    const color = typeof embed.color === 'number' ? ` (#${embed.color.toString(16).padStart(6, '0')})` : '';
    if (embed.title) lines.push(`**${String(embed.title)}**${color}`); else if (color) lines.push(color.trim());
    if (embed.description) lines.push(...this.display(String(embed.description)).split('\n'));
    for (const field of (embed.fields as Array<{ name: string; value: string; inline?: boolean }> | undefined) ?? []) lines.push(`${field.name}: ${this.display(field.value).replaceAll('\n', ' / ')}${field.inline ? ' (inline)' : ''}`);
    const footer = embed.footer as { text?: string } | undefined;
    if (footer?.text) lines.push(`-# ${footer.text}`);
    for (const key of ['image', 'thumbnail'] as const) { const media = embed[key] as { url?: string } | undefined; if (media?.url) lines.push(`${key}: ${media.url}`); }
    return lines.map(line => `┃ ${line}`);
  }

  private renderForm(payload: ModalPayload): string {
    const fields = payload.components.map(row => {
      const input = row.components[0]!;
      const rules = [input.style === 2 ? 'paragraph' : 'short', input.required === false ? 'optional' : 'required', typeof input.max_length === 'number' ? `max ${input.max_length}` : undefined].filter(Boolean).join(', ');
      return `  ${String(input.custom_id)}: ${String(input.label)} (${rules})`;
    });
    return [`  "${payload.title}"`, ...fields].join('\n');
  }

  render(message: Message): string {
    const header = `${message.id} ${message.author}${message.only ? ` (only ${message.only} sees this)` : ''}${message.edits ? ' (edited)' : ''} in #${message.channel.name}:`;
    const lines = [
      ...(message.content ? this.display(message.content).split('\n') : []),
      ...message.embeds.flatMap(embed => this.renderEmbed(embed)),
      ...message.components.map(row => row.components.map(control => this.renderControl(control)).join(' ')),
    ];
    return [header, ...lines.map(line => `  ${line}`)].join('\n');
  }

  /** A channel's latest messages: the one most recently active unless `where` names one. */
  screen(where?: string, last = 15): string {
    const channel = where ? this.channel(where) : this.recent;
    if (!channel) return 'Nothing has happened yet.';
    const messages = this.messages.filter(message => message.channel === channel);
    const shown = messages.slice(-last);
    const forms = [...this.forms].map(([name, form]) => `${name} has form "${form.payload.title}" open (from ${form.message.id}).`);
    return [
      `#${channel.name} (${channel.kind}${channel.parent ? ` in #${this.channel(channel.parent).name}` : ''})${messages.length > shown.length ? `, last ${shown.length} of ${messages.length} messages` : ''}`,
      ...shown.map(message => this.render(message)),
      ...forms,
      `Channels: ${[...this.channels.keys()].join(', ')}.`,
    ].join('\n');
  }
}
