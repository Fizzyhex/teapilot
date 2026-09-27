import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { emitKeypressEvents, type Key } from 'node:readline';
import { PassThrough } from 'node:stream';
import { StringDecoder } from 'node:string_decoder';
import { parse } from 'dotenv';
import { openRoom, renderLog, SYSTEM_AUTHOR, type ChannelMeta, type Message, type Room } from 'teachat';
import { loadClips } from '../art/playback.js';
import { cellWidth } from '../composer.js';
import { configDirectory } from '../config.js';
import { terminalColour } from '../presentation.js';
import { BOLD, BORDER, boxLines, clip, DIM, fitParts, GREEN, ITALIC, LAVENDER, paintParts, partsWidth, wrap, YELLOW, type Part } from '../setup/screen.js';
import { readTeachatSettings } from './settings.js';

export interface ViewerChannel { id: string; description: string; summary: string; unread: number }
export interface ViewerState {
  channels: ViewerChannel[];
  current: string;
  /** Oldest first; the first `archived` of them came from the archive. */
  messages: Message[];
  archived: number;
  /** Older messages sit in the archive and have not been loaded. */
  moreArchived: boolean;
  /** Rows scrolled up from the newest. */
  scroll: number;
  now: number;
  hint: string;
  notice?: string;
  art?: string;
  /** Everyone who can be mentioned; the channel's authors always count. */
  names?: string[];
}
export interface ViewerFrame { lines: string[]; total: number; page: number }

// Catppuccin frappé accents, beside the lavender setup already uses, so names read as one palette.
const AUTHOR_COLOURS = ['186;187;241', '153;209;219', '129;200;190', '166;209;137', '239;159;118', '244;184;228', '202;158;230', '229;200;144'].map(rgb => `38;2;${rgb}`);
export function authorColour(name: string): string {
  let hash = 0;
  for (const char of name) hash = (hash * 31 + char.codePointAt(0)!) >>> 0;
  return AUTHOR_COLOURS[hash % AUTHOR_COLOURS.length]!;
}
/** Events end with the time they happened, which the divider already shows. */
const eventText = (text: string) => text.replace(/\s*@\s*\d{4}-\d\d-\d\dT[\d:.]+Z$/, '').replace(/\bteapilot:([a-z0-9][\w-]*)/g, '$1');

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
function stamp(at: string, now: number): string {
  const date = new Date(at), today = new Date(now);
  const time = `${String(date.getHours()).padStart(2, '0')}:${String(date.getMinutes()).padStart(2, '0')}`;
  const days = Math.round((new Date(today.getFullYear(), today.getMonth(), today.getDate()).getTime() - new Date(date.getFullYear(), date.getMonth(), date.getDate()).getTime()) / 86_400_000);
  if (days === 0) return `today ${time}`;
  if (days === 1) return `yesterday ${time}`;
  return `${MONTHS[date.getMonth()]} ${date.getDate()}${date.getFullYear() === today.getFullYear() ? '' : ` ${date.getFullYear()}`} ${time}`;
}
/** Splits text so each mentioned name (bare, `@name` or `teapilot:name`) takes that person's colour. */
function mentions(text: string, style: string | undefined, names: string[]): Part[] {
  if (!names.length || !text) return [[text, style]];
  const escaped = [...names].sort((a, b) => b.length - a.length).map(name => name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'));
  const pattern = new RegExp(`(?<![\\w-])(?:@|teapilot:)?(${escaped.join('|')})(?![\\w-])`, 'gi');
  const parts: Part[] = [];
  let last = 0;
  for (const match of text.matchAll(pattern)) {
    if (match.index > last) parts.push([text.slice(last, match.index), style]);
    const name = names.find(item => item.toLowerCase() === match[1]!.toLowerCase())!;
    parts.push([match[0], [style === `${DIM};${ITALIC}` ? ITALIC : undefined, authorColour(name)].filter(Boolean).join(';')]);
    last = match.index + match[0].length;
  }
  if (last < text.length) parts.push([text.slice(last), style]);
  return parts;
}

const GAP_MS = 30 * 60_000;
const centred = (text: string, width: number, style = DIM): Part[] => [[' '.repeat(Math.max(0, Math.floor((width - cellWidth(text)) / 2))) + text, style]];

/**
 * The channel's messages as rows, IRC style: a right-aligned name column, then the text. `owner` is each row's message index;
 * `named` is the row's name column spelled out, for when it is the top row on screen and its name is out of sight.
 */
export function messageRows(state: Pick<ViewerState, 'messages' | 'archived' | 'moreArchived' | 'now' | 'names'>, width: number): { rows: Part[][]; owner: number[]; named: (Part[] | undefined)[] } {
  const rows: Part[][] = [], owner: number[] = [], named: (Part[] | undefined)[] = [];
  const push = (row: Part[], index: number, name?: Part[]) => { rows.push(row); owner.push(index); named.push(name); };
  if (state.moreArchived) push(centred('↑ scroll up for archived messages', width), -1);
  const names = state.messages.filter(message => message.kind === 'message').map(message => cellWidth(message.author));
  const nameWidth = Math.min(12, Math.max(1, ...names));
  const textWidth = Math.max(8, width - nameWidth - 3);
  const people = [...new Set([...state.names ?? [], ...state.messages.map(message => message.author)])].filter(name => name !== SYSTEM_AUTHOR);
  let previous: Message | undefined;
  state.messages.forEach((message, index) => {
    const archiveEnds = state.archived > 0 && index === state.archived;
    const divided = !previous || archiveEnds || new Date(previous.at).toDateString() !== new Date(message.at).toDateString() || Date.parse(message.at) - Date.parse(previous.at) > GAP_MS;
    if (divided) {
      if (previous) push([], index);
      push(centred(`── ${archiveEnds ? 'archive ends · ' : ''}${stamp(message.at, state.now)} ──`, width), index);
    }
    const event = message.kind === 'event' || message.author === SYSTEM_AUTHOR;
    const repeat = !divided && !event && previous?.kind === 'message' && previous.author === message.author;
    const column = (name: Part): Part[] => [[' '.repeat(Math.max(0, nameWidth - cellWidth(name[0])))], name, [' │ ', BORDER]];
    const full: Part = [clip(message.author, nameWidth), `${BOLD};${authorColour(message.author)}`];
    const label = column(event ? ['•', DIM] : repeat ? ['↪', DIM] : full), blank = column(['']);
    const spelled = event ? undefined : column(full);
    if (event) {
      wrap(eventText(message.text), textWidth).forEach((line, row) => push([...row ? blank : label, ...mentions(line, `${DIM};${ITALIC}`, people)], index));
    } else {
      const target = message.replyTo === undefined ? undefined : state.messages.find(other => other.n === message.replyTo);
      const prefix = message.replyTo === undefined ? '' : `↳ ${target ? `${target.author} ` : ''}#${message.replyTo}  `;
      wrap(prefix + message.text, textWidth).forEach((line, row) => {
        const body: Part[] = row === 0 && prefix && line.startsWith(prefix.trimEnd()) ? [[line.slice(0, prefix.length), DIM], ...mentions(line.slice(prefix.length), undefined, people)] : mentions(line, undefined, people);
        push([...row ? blank : label, ...body], index, spelled);
      });
    }
    previous = message;
  });
  return { rows, owner, named };
}

/** Channel tabs, the channel's description, then its messages; the hint line sits underneath. */
export function renderViewer(state: ViewerState, columns: number, rows: number, colour: boolean): ViewerFrame {
  const width = Math.max(24, Math.min(columns - 1, 110));
  const inner = width - 4;
  const box = (content: Part[][]) => boxLines(content, { width, colour });

  const tabs: Part[] = state.channels.flatMap((channel, index): Part[] => [
    ...index ? [[' • ', DIM] as Part] : [],
    [`#${channel.id}`, channel.id === state.current ? `${BOLD};${LAVENDER}` : undefined],
    ...channel.unread ? [[` +${channel.unread}`, GREEN] as Part] : [],
  ]);
  const top = box([tabs]);

  const channel = state.channels.find(item => item.id === state.current);
  const about: Part[][] = [];
  if (channel) {
    const [first = '', ...rest] = wrap(`#${channel.id} ${channel.description}`.trimEnd(), inner);
    about.push([[first.slice(0, channel.id.length + 1), BOLD], [first.slice(channel.id.length + 1)]]);
    if (rest.length) about.push([[rest.length > 1 ? clip(`${rest[0]} ${rest[1]}`, inner) : rest[0]!]]);
    if (channel.summary) {
      const summary = wrap(`Earlier: ${channel.summary}`, inner);
      summary.slice(0, 3).forEach((line, index) => about.push([[index === 2 && summary.length > 3 ? clip(`${line} ${summary[3]}`, inner) : line, `${DIM};${ITALIC}`]]));
    }
  }
  const middle = box(about.length ? about : [[]]);

  const page = Math.max(1, rows - top.length - middle.length - 3);
  const { rows: content, owner, named } = messageRows(state, inner);
  const total = content.length;
  const scroll = Math.max(0, Math.min(state.scroll, total - page));
  const end = Math.max(0, total - scroll);
  const start = Math.max(0, end - page);
  let body = content.slice(start, end);
  if (body.length && named[start]) body[0] = [...named[start]!, ...body[0]!.slice(3)];
  if (!state.messages.length) {
    body = [];
    const frame = state.art?.split('\n') ?? [];
    const quiet = `#${state.current} is quiet.`;
    if (frame.length && inner >= 40 && page >= frame.length + 2) {
      const artWidth = Math.max(...frame.map(line => cellWidth(line)));
      const indent = ' '.repeat(Math.max(0, Math.floor((inner - artWidth) / 2)));
      body.push(...frame.map((line): Part[] => [[indent + line, LAVENDER]]), []);
    }
    body.push(centred(quiet, inner));
    body.unshift(...Array.from({ length: Math.max(0, Math.floor((page - body.length) / 2)) }, (): Part[] => []));
  }
  while (body.length < page) body.push([]);
  const messages = box(body.slice(0, page));

  const shown = new Set(owner.slice(0, end));
  const newer = new Set(owner.slice(end).filter(index => index >= 0 && !shown.has(index))).size;
  const status: Part[] = newer ? [[`↓ ${newer} newer`, `${BOLD};${LAVENDER}`]] : [];
  const left: Part[] = state.notice ? [[state.notice, YELLOW]] : [[state.hint, DIM]];
  const room = width - partsWidth(status);
  const hint = paintParts([...fitParts(left, status.length ? room - 1 : width), ...status.length ? [[' '] as Part, ...status] : []], colour);

  const lines = [...top, ...middle, ...messages, hint];
  while (lines.length < rows) lines.push('');
  lines.length = Math.min(lines.length, rows);
  return { lines, total, page };
}

const HINT = '←/→ channel · ↑/↓ scroll · PgUp/PgDn page · Home/End · q leave';

/** A read-only, live view of the room. It polls, since the room is shared between processes. */
export class TeachatViewer {
  private channels: ChannelMeta[] = [];
  private seen = new Map<string, number>();
  private current = '';
  private live: Message[] = [];
  private older?: Message[];
  private scroll = 0;
  private lastTotal?: number;
  private lastCount = 0;
  private page = 10;
  private notice?: string;
  private noticeTimer?: NodeJS.Timeout;
  private poller?: NodeJS.Timeout;
  private polling = false;
  private scheduled = false;
  private attached = false;
  private raw?: boolean;
  private keys?: PassThrough;
  private readonly decoder = new StringDecoder('utf8');
  private readonly forward = (chunk: Buffer) => { this.keys?.write(this.decoder.write(chunk)); };
  private readonly resize = () => this.refresh();
  private readonly art = (() => {
    const frames = loadClips()?.['tea-break'].frames;
    const lines = frames?.at(-1)?.split('\n') ?? [];
    while (lines.length && !lines[0]!.trim()) lines.shift();
    while (lines.length && !lines.at(-1)!.trim()) lines.pop();
    return lines.join('\n') || undefined;
  })();
  private leave?: () => void;
  private names: string[] = [];

  constructor(private readonly room: Room, private readonly options: { colour: boolean; enabled: boolean }) {}

  async run(signal: AbortSignal): Promise<void> {
    this.channels = await this.room.channels();
    for (const channel of this.channels) this.seen.set(channel.id, channel.nextN);
    this.names = (await this.room.identities()).map(identity => identity.username);
    // Open on whichever channel spoke last.
    const latest = await Promise.all(this.channels.map(async channel => (await this.room.read(channel.id, { limit: 1 }))[0]?.at ?? ''));
    this.current = this.channels[latest.indexOf([...latest].sort().at(-1)!)]?.id ?? this.channels[0]?.id ?? 'offtopic';
    await this.open(this.current);
    const done = new Promise<void>(resolve => { this.leave = resolve; });
    const abort = () => this.leave?.();
    signal.addEventListener('abort', abort, { once: true });
    this.attach();
    if (!this.options.enabled) this.flash('Teachat is off, so no new gossip arrives. Turn it on with /teachat on in a session.', 8000);
    this.poller = setInterval(() => { void this.poll(); }, 2000);
    this.poller.unref();
    this.refresh();
    try { await done; } finally {
      signal.removeEventListener('abort', abort);
      clearInterval(this.poller); clearTimeout(this.noticeTimer);
      this.detach();
    }
  }

  private async open(id: string): Promise<void> {
    this.current = id; this.scroll = 0; this.older = undefined; this.lastTotal = undefined;
    this.live = await this.room.read(id);
    this.lastCount = this.live.length;
    this.seen.set(id, this.channels.find(channel => channel.id === id)?.nextN ?? 0);
    this.refresh();
  }

  private async poll(): Promise<void> {
    if (this.polling) return;
    this.polling = true;
    try {
      const before = this.channels.find(channel => channel.id === this.current);
      this.channels = await this.room.channels();
      const now = this.channels.find(channel => channel.id === this.current);
      if (now && (now.nextN !== before?.nextN || now.summaryAt !== before?.summaryAt)) {
        const id = this.current;
        const live = await this.room.read(id);
        const older = this.older && await this.room.archived(id);
        if (id !== this.current) return;
        this.live = live; if (older) this.older = older;
        this.seen.set(id, now.nextN);
      }
      this.refresh();
    } catch (error) { this.flash(`Could not read the room: ${error instanceof Error ? error.message : String(error)}`); }
    finally { this.polling = false; }
  }

  private get moreArchived(): boolean {
    if (this.older) return false;
    const first = this.live[0]?.n;
    const next = this.channels.find(channel => channel.id === this.current)?.nextN ?? 1;
    return first === undefined ? next > 1 : first > 1;
  }

  private async loadArchive(): Promise<void> {
    if (!this.moreArchived) return;
    const id = this.current;
    try {
      const older = await this.room.archived(id);
      if (id === this.current) { this.older = older; this.refresh(); }
    } catch (error) { this.flash(`Could not read the archive: ${error instanceof Error ? error.message : String(error)}`); }
  }

  private step(delta: number): void {
    const index = this.channels.findIndex(channel => channel.id === this.current);
    const target = this.channels[(index + delta + this.channels.length) % this.channels.length];
    if (target && target.id !== this.current) this.go(target.id);
  }
  private go(id: string): void {
    this.open(id).catch(error => this.flash(`Could not open #${id}: ${error instanceof Error ? error.message : String(error)}`));
  }
  private move(rows: number): void {
    this.scroll = Math.max(0, this.scroll + rows);
    this.refresh();
  }

  private key(value: string | undefined, key: Key): void {
    const name = key.name ?? value;
    if ((key.ctrl && name === 'c') || name === 'q' || name === 'escape') { this.leave?.(); return; }
    if (name === 'left' || (name === 'tab' && key.shift)) this.step(-1);
    else if (name === 'right' || name === 'tab') this.step(1);
    else if (name === 'up' || name === 'k') this.move(1);
    else if (name === 'down' || name === 'j') this.move(-1);
    else if (name === 'pageup') this.move(this.page - 1);
    else if (name === 'pagedown') this.move(-(this.page - 1));
    else if (name === 'home') this.move(Number.MAX_SAFE_INTEGER);
    else if (name === 'end') { this.scroll = 0; this.refresh(); }
    else if (value && /^[1-9]$/.test(value) && this.channels[Number(value) - 1]) this.go(this.channels[Number(value) - 1]!.id);
  }

  private flash(text: string, ms = 4000): void {
    this.notice = text; clearTimeout(this.noticeTimer);
    this.noticeTimer = setTimeout(() => { this.notice = undefined; this.refresh(); }, ms);
    this.noticeTimer.unref(); this.refresh();
  }

  private attach(): void {
    if (this.attached) return;
    this.attached = true;
    this.keys = new PassThrough();
    emitKeypressEvents(this.keys);
    this.keys.on('keypress', (value: string | undefined, key: Key) => this.key(value, key ?? {}));
    this.raw = process.stdin.isRaw;
    if (process.stdin.isTTY) process.stdin.setRawMode(true);
    process.stdin.on('data', this.forward);
    process.stdin.resume();
    process.stderr.on('resize', this.resize);
    // Alternate screen, so the terminal's scrollback is left as it was.
    process.stderr.write('\x1b[?1049h\x1b[?25l\x1b[H\x1b[2J');
  }
  private detach(): void {
    if (!this.attached) return;
    this.attached = false;
    process.stdin.removeListener('data', this.forward);
    // Stop reading before leaving raw mode; on Windows a mode switch mid-read swallows later keys.
    process.stdin.pause();
    if (process.stdin.isTTY) process.stdin.setRawMode(this.raw ?? false);
    process.stderr.removeListener('resize', this.resize);
    this.keys?.destroy(); this.keys = undefined;
    process.stderr.write('\x1b[?25h\x1b[?1049l');
  }

  private refresh = (): void => {
    if (this.scheduled || !this.attached) return;
    this.scheduled = true;
    setImmediate(() => { this.scheduled = false; this.draw(); });
  };
  private draw(): void {
    if (!this.attached) return;
    if (process.stderr.writableNeedDrain) { process.stderr.once('drain', this.refresh); return; }
    const messages = [...this.older ?? [], ...this.live];
    const state = (): ViewerState => ({
      channels: this.channels.map(channel => ({ id: channel.id, description: channel.description, summary: channel.summary, unread: channel.id === this.current ? 0 : Math.max(0, channel.nextN - (this.seen.get(channel.id) ?? channel.nextN)) })),
      current: this.current, messages, archived: this.older?.length ?? 0, moreArchived: this.moreArchived,
      scroll: this.scroll, now: Date.now(), hint: HINT, notice: this.notice, art: this.art, names: this.names,
    });
    const columns = process.stderr.columns || 80, rows = process.stderr.rows || 24;
    let frame = renderViewer(state(), columns, rows, this.options.colour);
    // Scrolled up, new messages (or a loaded archive) must not move what is being read.
    if (this.scroll > 0 && this.lastTotal !== undefined && messages.length !== this.lastCount && frame.total !== this.lastTotal) {
      this.scroll += frame.total - this.lastTotal;
      frame = renderViewer(state(), columns, rows, this.options.colour);
    }
    this.scroll = Math.max(0, Math.min(this.scroll, frame.total - frame.page));
    this.lastTotal = frame.total; this.lastCount = messages.length; this.page = frame.page;
    // Reaching the top pulls in the archive.
    if (this.scroll > 0 && this.scroll >= frame.total - frame.page && this.moreArchived) void this.loadArchive();
    process.stderr.write('\x1b[?2026h\x1b[H' + frame.lines.map(line => `${line}\x1b[K`).join('\r\n') + '\x1b[J\x1b[?2026l');
  }
}

/** teapilot teachat: browse the room full screen, or print each channel's latest messages when there is no terminal to draw on. */
export async function viewTeachat(explicitDirectory: string | undefined, signal: AbortSignal): Promise<boolean> {
  const directory = await configDirectory(explicitDirectory);
  const env = { ...parse(await readFile(join(directory, '.env'), 'utf8').catch(() => '')), ...Object.fromEntries(Object.entries(process.env).filter(([key]) => key.startsWith('TEACHAT_'))) };
  const settings = readTeachatSettings(env, directory);
  const room = await openRoom({ dir: settings.dir });
  const interactive = process.stdin.isTTY && process.stdout.isTTY && process.stderr.isTTY && process.env.TERM !== 'dumb' && (process.stderr.columns || 0) >= 60 && (process.stderr.rows || 0) >= 20;
  if (!interactive) {
    const now = Date.now();
    for (const channel of await room.channels()) {
      const log = renderLog(await room.read(channel.id, { limit: 20 }), now);
      process.stdout.write(`#${channel.id} — ${channel.description}\n\n${log || '(quiet)'}\n\n`);
    }
    return true;
  }
  const colour = terminalColour(process.stderr.isTTY) && !process.env.NODE_DISABLE_COLORS;
  await new TeachatViewer(room, { colour, enabled: settings.enabled }).run(signal);
  return true;
}
