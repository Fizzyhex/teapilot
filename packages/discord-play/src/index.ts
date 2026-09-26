/**
 * Building blocks for teapilot's interactive Discord apps. An app is serializable state plus three
 * functions: `init` makes the first state, `update` applies one action, and `view` renders a state.
 * Every builder returns plain data; the discord.play runtime turns it into Discord messages and
 * owns acknowledgement, routing, persistence, timers and limits.
 *
 * This module has no imports and no side effects, so it runs unchanged inside the sandbox.
 */

export type Json = null | boolean | number | string | Json[] | { [key: string]: Json };

export interface User { id: string; name?: string }
/** Who may use an app's controls: everyone in the channel, only the person who started it, or these Discord IDs. */
export type Participants = 'everyone' | 'invoker' | string[];

export type ButtonStyle = 'primary' | 'secondary' | 'success' | 'danger';
export interface Button {
  type: 'button'; id: string; label?: string; style?: ButtonStyle;
  /** A unicode emoji, or a custom one as `<:name:id>`. */
  emoji?: string;
  disabled?: boolean;
  /** Opens this modal instead of sending a button action; its submission arrives as a `modal` action. */
  opens?: Modal;
  /** Makes a link button: it opens the URL and never reaches the app. */
  url?: string;
}
export interface SelectOption { value: string; label: string; description?: string; emoji?: string; default?: boolean }
export interface Select { type: 'select'; id: string; options: SelectOption[]; placeholder?: string; min?: number; max?: number; disabled?: boolean }
export interface ModalField { id: string; label: string; style?: 'short' | 'paragraph'; placeholder?: string; required?: boolean; min?: number; max?: number; value?: string }
export interface Modal { type: 'modal'; id: string; title: string; fields: ModalField[] }
export type Control = Button | Select;
export interface Row { type: 'row'; controls: Control[] }
export interface EmbedField { name: string; value: string; inline?: boolean }
export interface Embed {
  type: 'embed'; title?: string; description?: string;
  /** A number such as 0x5865f2, a hex string such as "#5865f2", or a name from `colors`. */
  color?: number | string;
  fields?: EmbedField[]; footer?: string; url?: string; thumbnail?: string; image?: string;
}
/** One Discord message. Apps edit the same message in place as their state changes. */
export interface View { content?: string; embeds?: Embed[]; rows?: Row[] }

export type Effect =
  /** A private reply to the person whose action is being handled. */
  | { type: 'ephemeral'; content: string; embeds?: Embed[] }
  /** Deliver a `timer` action with this id after `ms` milliseconds; a repeat id reschedules it. */
  | { type: 'after'; id: string; ms: number }
  | { type: 'cancel'; id: string }
  /** End the app: its final view stays, with every control disabled. */
  | { type: 'finish'; summary?: string }
  /** Ask teapilot's model; the answer arrives later as a `consult` action with this id. */
  | { type: 'consult'; id: string; prompt: string };
export interface Step<S> { type: 'step'; state: S; effects: Effect[] }

export type Action =
  | { kind: 'button'; id: string; user: User }
  | { kind: 'select'; id: string; user: User; values: string[] }
  | { kind: 'modal'; id: string; user: User; fields: Record<string, string> }
  | { kind: 'timer'; id: string }
  | { kind: 'consult'; id: string; text?: string; error?: string };

export interface Context {
  /** Milliseconds since the epoch when this call started. */
  now: number;
  /** Who started the app. */
  invoker: User;
  participants: Participants;
  /** Custom emoji supplied by the user, by name, as `<:name:id>`. */
  emojis: Record<string, string>;
  /** Seeded and persisted, so it continues across restarts. */
  random(): number;
  /** A custom emoji by name, or `:name:` when the user did not supply it. */
  emoji(name: string): string;
  /** Trusted apps only: a raw Discord REST call made as teapilot's bot, e.g. request('GET', `/channels/${id}`). */
  discord?: { request(method: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE', route: string, body?: Json): Promise<unknown> };
}

export interface App<S> {
  /** Defaults to everyone when neither the app nor the person starting it says otherwise. */
  participants?: Participants;
  init(ctx: Context): S | Step<S>;
  update(state: S, action: Action, ctx: Context): S | Step<S> | Promise<S | Step<S>>;
  view(state: S, ctx: Context): View;
}

/** Declares an app. `export default app({...})` is what the runtime loads. */
export function app<S>(definition: App<S>): App<S> { return definition; }

/** A new state together with effects to run once it is committed. */
export function step<S>(state: S, ...effects: Effect[]): Step<S> { return { type: 'step', state, effects }; }

export const colors = {
  blurple: 0x5865f2, green: 0x57f287, yellow: 0xfee75c, orange: 0xe67e22, red: 0xed4245,
  pink: 0xeb459e, purple: 0x9b59b6, blue: 0x3498db, grey: 0x95a5a6, black: 0x23272a, white: 0xffffff,
} as const;

/** Lines of text; falsy entries are skipped so conditional lines stay short. */
export function text(...lines: Array<string | false | null | undefined>): string {
  return lines.filter((line): line is string => typeof line === 'string').join('\n');
}

export function embed(options: Omit<Embed, 'type'>): Embed { return { type: 'embed', ...options }; }

export function button(id: string, label: string, options: Omit<Button, 'type' | 'id' | 'label'> = {}): Button {
  return { type: 'button', id, label, ...options };
}

export function select(id: string, options: Array<string | SelectOption>, settings: Omit<Select, 'type' | 'id' | 'options'> = {}): Select {
  return { type: 'select', id, options: options.map(option => typeof option === 'string' ? { value: option, label: option } : option), ...settings };
}

export function field(id: string, label: string, options: Omit<ModalField, 'id' | 'label'> = {}): ModalField { return { id, label, ...options }; }

export function modal(id: string, title: string, fields: ModalField[]): Modal { return { type: 'modal', id, title, fields }; }

export function row(...controls: Control[]): Row { return { type: 'row', controls }; }

/**
 * An emoji board: each cell is looked up in `palette`, so state can hold short codes.
 * grid([[0, 1], [1, 0]], { 0: '⬛', 1: '🟥' }) → "⬛🟥\n🟥⬛"
 */
export function grid(cells: Array<Array<string | number>>, palette: Record<string, string> = {}): string {
  return cells.map(line => line.map(cell => palette[String(cell)] ?? String(cell)).join('')).join('\n');
}

/** A bar such as 🟩🟩🟩⬛⬛ for health, progress or timers. */
export function meter(value: number, max: number, width = 10, full = '🟩', empty = '⬛'): string {
  const filled = max > 0 ? Math.round(Math.min(Math.max(value / max, 0), 1) * width) : 0;
  return full.repeat(filled) + empty.repeat(Math.max(width - filled, 0));
}

/** Hidden until clicked. */
export function spoiler(value: string): string { return `||${value.replace(/\|\|/g, '| |')}||`; }

export function ephemeral(content: string, embeds?: Embed[]): Effect { return embeds ? { type: 'ephemeral', content, embeds } : { type: 'ephemeral', content }; }
export function after(ms: number, id: string): Effect { return { type: 'after', id, ms }; }
export function cancel(id: string): Effect { return { type: 'cancel', id }; }
export function finish(summary?: string): Effect { return summary === undefined ? { type: 'finish' } : { type: 'finish', summary }; }
export function consult(id: string, prompt: string): Effect { return { type: 'consult', id, prompt }; }
