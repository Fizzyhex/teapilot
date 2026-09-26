import { emitKeypressEvents, type Key } from 'node:readline';
import { PassThrough } from 'node:stream';
import { StringDecoder } from 'node:string_decoder';
import { stripVTControlCharacters } from 'node:util';
import type { Activity } from '../activity.js';
import { loadClips, Playback } from '../art/playback.js';
import { cellWidth, graphemes } from '../composer.js';
import type { SetupUI } from './terminal.js';

export interface ScreenTab { id: string; label: string; short?: string; parent?: string }
/** changed: this tab's settings differ from the saved ones. attention: something here needs a look. */
export type TabMark = 'changed' | 'attention';

/** Rejects a tab's pending question or operation when the user opens another tab. */
export class Navigation extends Error {
  constructor(readonly target: string) { super(`Opened ${target}.`); this.name = 'Navigation'; }
}

export interface ScreenState {
  tabs: ScreenTab[];
  current: string;
  marks: Record<string, TabMark | undefined>;
  /** Installation progress, shown top right only while one runs. */
  banner?: string;
  art?: string;
  title: string;
  lines: string[];
  choices?: string[];
  selected: number;
  prompt?: { label: string; fallback?: string; text: string; cursor: number; secret: boolean };
  busy?: string;
  spinner?: string;
  hint: string;
  notice?: string;
}

type Part = readonly [text: string, style?: string];
const BOLD = '1', DIM = '2', ITALIC = '3', RED = '31', GREEN = '32', YELLOW = '33', CYAN = '36';
const LAVENDER = '38;2;186;187;241'; // catppuccin lavender, as in the activity art
const BORDER = '38;2;98;100;118';

/** Terminal cells taken by the leading graphemes of text that fit within width. */
function take(text: string, width: number): string {
  let out = '', used = 0;
  for (const { segment } of graphemes(text)) {
    const size = cellWidth(segment);
    if (used + size > width) break;
    out += segment; used += size;
  }
  return out;
}
function clip(text: string, width: number): string {
  if (width <= 0) return '';
  return cellWidth(text) <= width ? text : `${take(text, width - 1)}…`;
}
const partsWidth = (parts: Part[]) => parts.reduce((total, [text]) => total + cellWidth(text), 0);
/** Exactly width cells: clipped with an ellipsis, or padded with spaces. */
function fitParts(parts: Part[], width: number): Part[] {
  const out: Part[] = [];
  let left = width;
  for (const [text, style] of parts) {
    if (left <= 0) break;
    const fitted = cellWidth(text) <= left ? text : clip(text, left);
    out.push([fitted, style]); left -= cellWidth(fitted);
  }
  if (left > 0) out.push([' '.repeat(left)]);
  return out;
}
export function wrap(text: string, width: number): string[] {
  const lines: string[] = [];
  for (const paragraph of text.split('\n')) {
    let line = '';
    for (const word of paragraph.split(/(\s+)/)) {
      if (cellWidth(line + word) <= width) { line += word; continue; }
      if (line.trim()) lines.push(line.trimEnd());
      line = /^\s+$/.test(word) ? '' : word;
      while (cellWidth(line) > width) { const head = take(line, width); lines.push(head); line = line.slice(head.length); }
    }
    lines.push(line.trimEnd());
  }
  return lines;
}
/** `£` marks anything that can incur charges; it stands out in its own colour. */
const CHARGE = `${BOLD};${YELLOW}`;
function charges(parts: Part[]): Part[] {
  return parts.flatMap(([text, style]): Part[] => text.split('£').flatMap((piece, index): Part[] => [...index ? [['£', CHARGE] as Part] : [], [piece, style]]));
}
function logStyle(message: string): string | undefined {
  if (/FAIL|failed|Invalid|[Cc]ould not/.test(message)) return RED;
  if (/NOT TESTED|not tested|unverified|Not verified|Partial|Skipped|Waiting|cancelled/.test(message)) return YELLOW;
  if (/PASS|Passed|Ready|saved|Queued/.test(message)) return GREEN;
  if (/^ {2}\w[\w ]*:/.test(message)) return CYAN;
  return undefined;
}

/** Lay the screen out top to bottom: installs, tabs, art, the current tab, then the input box. */
export function renderScreen(state: ScreenState, columns: number, rows: number, colour: boolean): { lines: string[]; cursor?: { row: number; col: number } } {
  const width = Math.max(24, Math.min(columns - 1, 110));
  const inner = width - 4;
  const paint = (parts: Part[]) => parts.map(([text, style]) => colour && style && text ? `\x1b[${style}m${text}\x1b[0m` : text).join('');
  const box = (content: Part[][], border = BORDER, boxWidth = width, indent = 0): string[] => {
    const pad = ' '.repeat(indent);
    return [
      pad + paint([[`╭${'─'.repeat(boxWidth - 2)}╮`, border]]),
      ...content.map(line => pad + paint([['│ ', border], ...fitParts(line, boxWidth - 4), [' │', border]])),
      pad + paint([[`╰${'─'.repeat(boxWidth - 2)}╯`, border]]),
    ];
  };

  const top: string[] = [];
  if (state.banner) {
    const bannerWidth = Math.min(width, cellWidth(state.banner) + 4);
    top.push(...box([[[state.banner, ITALIC]]], BORDER, bannerWidth, width - bannerWidth));
  }

  const main = state.tabs.filter(tab => !tab.parent);
  const active = state.tabs.find(tab => tab.id === state.current);
  const activeMain = active?.parent ?? active?.id;
  const markOf = (id: string): TabMark | undefined => {
    const marks = [id, ...state.tabs.filter(tab => tab.parent === id).map(tab => tab.id)].map(item => state.marks[item]);
    return marks.includes('attention') ? 'attention' : marks.includes('changed') ? 'changed' : undefined;
  };
  const markParts = (id: string): Part[] => {
    const mark = markOf(id);
    return mark === 'changed' ? [[' ✓', GREEN]] : mark === 'attention' ? [[' !', YELLOW]] : [];
  };
  const tabRow = (short: boolean): Part[] => main.flatMap((tab, index): Part[] => [
    ...index ? [[' > ', DIM] as Part] : [],
    [short ? tab.short ?? tab.label : tab.label, tab.id === activeMain ? BOLD : undefined],
    ...markParts(tab.id),
  ]);
  const tabLines: Part[][] = [partsWidth(tabRow(false)) <= inner ? tabRow(false) : tabRow(true)];
  const children = state.tabs.filter(tab => tab.parent && tab.parent === activeMain);
  if (children.length) {
    tabLines.push([['↳ ', DIM], ...children.flatMap((tab, index): Part[] => [
      ...index ? [[' · ', DIM] as Part] : [],
      [tab.label, tab.id === state.current ? `${BOLD};${LAVENDER}` : DIM],
      ...markParts(tab.id),
    ])]);
  }
  top.push(...box(tabLines));

  // The input box: the question being asked, or what is happening while nothing is asked.
  let input: Part[];
  let cursorCol: number | undefined;
  if (state.prompt) {
    const prompt = state.prompt;
    const label: Part[] = [[prompt.label, BOLD], ...prompt.fallback && !prompt.secret ? [[` [${prompt.fallback}]`, CYAN] as Part] : [], [': ']];
    const labelWidth = Math.min(partsWidth(label), Math.max(0, inner - 12));
    let shown = prompt.secret ? (prompt.text ? '(hidden)' : '') : prompt.text;
    let before = prompt.secret ? shown : prompt.text.slice(0, prompt.cursor);
    // Long answers scroll so the cursor stays visible.
    const room = inner - labelWidth - 1;
    while (before && cellWidth(before) > room) {
      const first = graphemes(before)[0]!.segment;
      before = before.slice(first.length); shown = shown.slice(first.length);
    }
    input = [...fitParts(label, labelWidth), [shown]];
    cursorCol = 2 + labelWidth + cellWidth(before);
  } else input = [[state.busy ?? '', DIM]];
  const bottom = [...box([input]), paint(fitParts(state.notice ? [[state.notice, YELLOW]] : [[state.hint, DIM]], width))];

  // The current tab's panel takes what is left; the art only appears when it leaves the panel room.
  const available = rows - top.length - bottom.length;
  const choices = state.choices ?? [];
  const title = wrap(state.title, inner);
  const panelMinimum = 2 + title.length + 1 + Math.min(choices.length, 8) + 3;
  let art: string[] = [];
  if (state.art && inner >= 40) {
    const frame = state.art.split('\n');
    if (available - frame.length - 2 >= panelMinimum) {
      const artWidth = Math.max(...frame.map(line => cellWidth(line)));
      const indent = ' '.repeat(Math.max(0, Math.floor((inner - artWidth) / 2)));
      art = box(frame.map(line => [[indent + line, LAVENDER]]), LAVENDER);
    }
  }
  const logs: Part[][] = state.lines.flatMap(line => wrap(line, inner).map((part): Part[] => charges([[part, logStyle(line)]])));
  const busy: Part[][] = state.busy && state.prompt === undefined ? [[[`${state.spinner ?? '•'} `, LAVENDER], [state.busy, DIM]]] : [];
  // The panel hugs its content, like the design, and scrolls its log once the screen is full.
  const wanted = title.length + 1 + logs.length + busy.length + 1 + choices.length;
  const height = Math.min(Math.max(3, available - art.length) - 2, Math.max(8, wanted));
  const body: Part[][] = title.map(line => [[line, BOLD]]);
  body.push([]);
  let room = height - body.length;
  let shownChoices = choices.map((choice, index): Part[] => index === state.selected && state.prompt
    ? [['› ', LAVENDER], [`${index + 1}. `, LAVENDER], ...charges([[choice, BOLD]])]
    : [['  '], [`${index + 1}. `, DIM], ...charges([[choice]])]);
  if (shownChoices.length > room) {
    const count = Math.max(1, room);
    const start = Math.min(Math.max(0, state.selected - Math.floor(count / 2)), shownChoices.length - count);
    shownChoices = shownChoices.slice(start, start + count);
  }
  room -= shownChoices.length;
  const gap = shownChoices.length && (logs.length || busy.length) ? 1 : 0;
  room -= busy.length + gap;
  body.push(...room > 0 ? logs.slice(-room) : [], ...busy, ...gap ? [[]] : [], ...shownChoices);
  while (body.length < height) body.push([]);
  const panel = box(body.slice(0, Math.max(1, height)));

  const lines = [...top, ...art, ...panel, ...bottom];
  while (lines.length < rows) lines.push('');
  lines.length = Math.min(lines.length, rows);
  const cursorRow = top.length + art.length + panel.length + 1;
  return { lines, cursor: cursorCol === undefined || cursorRow >= rows ? undefined : { row: cursorRow, col: Math.min(cursorCol, width - 3) } };
}

export interface ScreenOptions { colour: boolean; motion: boolean; onClose?: () => void }
interface Question {
  label: string; fallback?: string; secret: boolean; confirm: boolean;
  text: string; cursor: number;
  resolve(value: string): void;
}
const spinnerFrames = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏'];

/**
 * A full-screen, tabbed setup. It answers the same questions as the line
 * based interface, so every setup step works in either. Opening another tab
 * rejects the current question with Navigation; the controller decides what
 * that means for the tab's work.
 */
export class SetupScreen implements SetupUI {
  tabs: ScreenTab[] = [];
  current = '';
  /** Called with the tab the user asked for. Set by the tab controller. */
  navigate?: (target: string) => void;
  /** Called on a confirmed Ctrl+C. */
  onQuit?: () => void;
  /** Background progress for the top of the screen. */
  status?: () => string | undefined;
  private title = '';
  private readonly marks: Record<string, TabMark | undefined> = {};
  private readonly logs = new Map<string, string[]>();
  private choices?: () => string[];
  private selected = 0;
  private question?: Question;
  private signal = new AbortController().signal;
  private readonly busy: string[] = [];
  private readonly locked: string[] = [];
  private notice?: string;
  private noticeTimer?: NodeJS.Timeout;
  private quitArmed = 0;
  private pasting = false;
  private readonly playback = new Playback(() => this.refresh());
  private readonly clips = loadClips();
  /** Rows that are blank in every frame are left out, so the art box is no taller than the art. */
  private readonly artRows = (() => {
    const frames = this.clips ? [...this.clips.pawing.frames, ...this.clips.typing.frames, ...this.clips['tea-break'].frames] : [];
    const blank = (index: number) => frames.every(frame => !frame.split('\n')[index]?.trim());
    const count = frames[0]?.split('\n').length ?? 0;
    let start = 0, end = count;
    while (start < end && blank(start)) start++;
    while (end > start && blank(end - 1)) end--;
    return { start, end };
  })();
  private clip?: string;
  private spin = 0;
  private spinTimer?: NodeJS.Timeout;
  private attached = false;
  private closed = false;
  private scheduled = false;
  private raw?: boolean;
  private keys?: PassThrough;
  private readonly decoder = new StringDecoder('utf8');
  private readonly forward = (chunk: Buffer) => { this.keys?.write(this.decoder.write(chunk)); };
  private readonly resize = () => this.refresh();

  constructor(private readonly options: ScreenOptions) {}

  /** Tabs in the order ←/→ visits them: a tab with sub-tabs is visited through its sub-tabs. */
  get order(): ScreenTab[] { return this.tabs.filter(tab => !this.tabs.some(child => child.parent === tab.id)); }
  get isLocked(): boolean { return this.locked.length > 0; }

  open(): void { this.attach(); this.refresh(); }
  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.detach();
    this.playback.stop();
    clearInterval(this.spinTimer); clearTimeout(this.noticeTimer);
    this.options.onClose?.();
  }
  /** Leave the screen for work that needs the plain terminal, such as an installer. */
  suspend = (): (() => void) => {
    this.detach();
    let resumed = false;
    return () => { if (!resumed && !this.closed) { resumed = true; this.attach(); this.refresh(); } };
  };

  /** Show a tab afresh. Questions asked from here on are cancelled by signal. */
  enter(id: string, signal: AbortSignal): void {
    this.current = id; this.signal = signal;
    this.title = this.tabs.find(tab => tab.id === id)?.label ?? id;
    this.logs.set(id, []); this.choices = undefined; this.selected = 0;
    this.refresh();
  }
  mark(id: string, mark: TabMark | undefined): void { this.marks[id] = mark; this.refresh(); }
  markOf(id: string): TabMark | undefined { return this.marks[id]; }
  clear(): void { this.logs.set(this.current, []); this.refresh(); }
  /** Work that must finish before tabs can change, such as an installer. */
  async lock<T>(label: string, operation: () => Promise<T>): Promise<T> {
    this.locked.push(label);
    const end = this.activity({ kind: 'waiting', label });
    try { return await operation(); } finally { end(); this.locked.splice(this.locked.indexOf(label), 1); this.refresh(); }
  }
  flash(text: string, ms = 3000): void {
    this.notice = text; clearTimeout(this.noticeTimer);
    this.noticeTimer = setTimeout(() => { this.notice = undefined; this.refresh(); }, ms);
    this.noticeTimer.unref(); this.refresh();
  }

  log = (message: string): void => {
    const lines = this.logs.get(this.current) ?? [];
    for (const line of stripVTControlCharacters(message).replace(/^\n+/, '').split('\n')) {
      // Progress such as "Downloading: 41%" replaces its previous line instead of scrolling.
      const progress = /^(.*?)\d+(%| MB)$/.exec(line)?.[1];
      if (progress && lines.at(-1)?.startsWith(progress) && /\d+(%| MB)$/.test(lines.at(-1)!)) lines[lines.length - 1] = line;
      else lines.push(line);
    }
    this.logs.set(this.current, lines.slice(-300));
    this.refresh();
  };
  activity = (activity: Activity): (() => void) => {
    this.busy.push(activity.label);
    this.refresh();
    let ended = false;
    return () => { if (!ended) { ended = true; this.busy.splice(this.busy.lastIndexOf(activity.label), 1); this.refresh(); } };
  };
  input = async (message: string, fallback?: string, secret = false, extraSignal?: AbortSignal): Promise<string> => {
    const answer = await this.ask({ label: message, fallback, secret, confirm: false }, extraSignal);
    return answer.trim() || fallback || '';
  };
  choose = async (message: string, choices: string[], fallback = 0): Promise<number> => this.chooseLive(message, () => choices, fallback);
  /** Choices are read again on every redraw, so they can show live progress. */
  async chooseLive(message: string, choices: () => string[], fallback = 0): Promise<number> {
    this.title = message; this.choices = choices; this.selected = fallback;
    try {
      for (;;) {
        const answer = (await this.ask({ label: 'Choose', fallback: String(fallback + 1), secret: false, confirm: false })).trim();
        const count = choices().length;
        if (!answer) return Math.min(this.selected, count - 1);
        const value = Number(answer);
        if (Number.isInteger(value) && value >= 1 && value <= count) return value - 1;
        this.flash(`Enter a number from 1 to ${count}.`);
      }
    } finally { this.choices = undefined; this.refresh(); }
  }
  confirm = async (message: string, extraSignal?: AbortSignal): Promise<boolean> => {
    this.title = message; this.choices = () => ['Yes', 'No']; this.selected = 1;
    try {
      for (;;) {
        const answer = (await this.ask({ label: 'Choose', fallback: '2', secret: false, confirm: true }, extraSignal)).trim().toLowerCase();
        if (!answer) return this.selected === 0;
        if (['1', 'y', 'yes'].includes(answer)) return true;
        if (['2', 'n', 'no'].includes(answer)) return false;
        this.flash('Enter 1 for yes or 2 for no.');
      }
    } catch (error) {
      // An operation's own cancellation declines, as on the plain terminal; opening another tab does not.
      if (extraSignal?.aborted && !this.signal.aborted) return false;
      throw error;
    } finally { this.choices = undefined; this.refresh(); }
  };

  private ask(question: Omit<Question, 'text' | 'cursor' | 'resolve'>, extraSignal?: AbortSignal): Promise<string> {
    const signal = extraSignal ? AbortSignal.any([this.signal, extraSignal]) : this.signal;
    signal.throwIfAborted();
    return new Promise<string>((resolve, reject) => {
      const abort = () => { if (this.question === current) this.question = undefined; this.refresh(); reject(signal.reason); };
      const current: Question = { ...question, text: '', cursor: 0, resolve: value => { signal.removeEventListener('abort', abort); this.question = undefined; this.refresh(); resolve(value); } };
      this.question = current;
      signal.addEventListener('abort', abort, { once: true });
      this.refresh();
    });
  }

  private step(delta: number): void {
    const order = this.order;
    const index = order.findIndex(tab => tab.id === this.current);
    const target = order[index + delta];
    if (!target) return;
    if (this.locked.length) { this.flash(`Please wait: ${this.locked.at(-1)!.replace(/\.{3}$/, '')} must finish before you switch tabs.`); return; }
    this.navigate?.(target.id);
  }

  private key(value: string | undefined, key: Key): void {
    if (key.sequence === '\x1b[200~') { this.pasting = true; return; }
    if (key.sequence === '\x1b[201~') { this.pasting = false; return; }
    const question = this.question;
    if (!this.pasting) {
      if (key.ctrl && key.name === 'c') {
        if (Date.now() - this.quitArmed < 3000) { this.onQuit?.(); return; }
        this.quitArmed = Date.now();
        this.flash('Press Ctrl+C again to leave setup without saving.');
        return;
      }
      const choosing = !question || Boolean(this.choices);
      if (key.name === 'tab') { this.step(key.shift ? -1 : 1); return; }
      if (choosing && (key.name === 'left' || key.name === 'right')) { this.step(key.name === 'left' ? -1 : 1); return; }
      if (!question) return;
      if (this.choices && (key.name === 'up' || key.name === 'down')) {
        const count = this.choices().length;
        this.selected = (this.selected + (key.name === 'up' ? count - 1 : 1)) % count;
        question.text = ''; question.cursor = 0; this.refresh();
        return;
      }
      if (key.name === 'return' || key.name === 'enter') { question.resolve(question.text); return; }
      const boundaries = graphemes(question.text).map(part => part.index);
      const previous = boundaries.findLast(index => index < question.cursor) ?? 0;
      const next = boundaries.find(index => index > question.cursor) ?? question.text.length;
      if (key.name === 'left') question.cursor = previous;
      else if (key.name === 'right') question.cursor = next;
      else if (key.name === 'home') question.cursor = 0;
      else if (key.name === 'end') question.cursor = question.text.length;
      else if (key.name === 'escape') { question.text = ''; question.cursor = 0; }
      else if (key.name === 'backspace') { question.text = question.text.slice(0, previous) + question.text.slice(question.cursor); question.cursor = previous; }
      else if (key.name === 'delete') question.text = question.text.slice(0, question.cursor) + question.text.slice(next);
      else if (value && !key.ctrl && !key.meta) this.insert(question, value);
      this.refresh();
      return;
    }
    if (question && value) { this.insert(question, value.replace(/[\r\n]+/g, ' ')); this.refresh(); }
  }
  private insert(question: Question, value: string): void {
    const text = stripVTControlCharacters(value).replace(/[\x00-\x1f\x7f]/g, '');
    question.text = question.text.slice(0, question.cursor) + text + question.text.slice(question.cursor);
    question.cursor += text.length;
  }

  private attach(): void {
    if (this.attached || this.closed) return;
    this.attached = true;
    this.keys = new PassThrough();
    emitKeypressEvents(this.keys);
    this.keys.on('keypress', (value: string | undefined, key: Key) => this.key(value, key ?? {}));
    this.raw = process.stdin.isRaw;
    if (process.stdin.isTTY) process.stdin.setRawMode(true);
    process.stdin.on('data', this.forward);
    process.stdin.resume();
    process.stderr.on('resize', this.resize);
    // Alternate screen, so the terminal's scrollback is left as it was; bracketed paste.
    process.stderr.write('\x1b[?1049h\x1b[?2004h\x1b[H\x1b[2J');
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
    process.stderr.write('\x1b[?2004l\x1b[?25h\x1b[?1049l');
  }

  refresh = (): void => {
    if (this.scheduled || !this.attached) return;
    this.scheduled = true;
    setImmediate(() => { this.scheduled = false; this.draw(); });
  };
  private animate(): string | undefined {
    const clips = this.clips;
    if (!clips) return undefined;
    const busy = this.busy.length > 0 && !this.question;
    const crop = (frame: string | undefined) => frame?.split('\n').slice(this.artRows.start, this.artRows.end).join('\n');
    // Each tab idles in its own pose, alternating in tab order.
    const tab = Math.max(0, this.order.findIndex(tab => tab.id === this.current));
    const idle = ([
      { clip: clips.pawing, indices: [2, 3] },
      { clip: clips.pawing, indices: [4, 5, 6] },
      { clip: clips['tea-break'], indices: undefined },
    ] as const)[tab % 3]!;
    if (!this.options.motion) return crop(idle.clip.frames[idle.indices?.at(-1) ?? idle.clip.frames.length - 1]);
    const clip = busy ? 'busy' : `idle:${tab % 3}`;
    if (clip !== this.clip) {
      this.clip = clip;
      // Typing while work runs; otherwise the tab's idle pose.
      if (busy) this.playback.play(clips.typing, undefined, true);
      else this.playback.play(idle.clip, idle.indices && [...idle.indices]);
    }
    return crop(this.playback.frame);
  }
  private draw(): void {
    if (!this.attached) return;
    if (process.stderr.writableNeedDrain) { process.stderr.once('drain', this.refresh); return; }
    const busy = this.busy.at(-1);
    if (busy && !this.spinTimer && this.options.motion) {
      this.spinTimer = setInterval(() => { this.spin++; this.refresh(); }, 100); this.spinTimer.unref();
    } else if (!busy && this.spinTimer) { clearInterval(this.spinTimer); this.spinTimer = undefined; }
    const question = this.question;
    const choices = this.choices?.();
    if (choices && this.selected >= choices.length) this.selected = Math.max(0, choices.length - 1);
    const hint = this.locked.length ? 'Please wait for this step to finish · Ctrl+C twice to leave'
      : !question ? '←/→ switch tabs (stops this step) · Ctrl+C twice to leave'
      : choices ? '←/→ switch tabs · ↑/↓ select · Enter confirm · Ctrl+C twice to leave'
      : 'Tab/Shift+Tab switch tabs · Enter confirm · Esc clear · Ctrl+C twice to leave';
    const state: ScreenState = {
      tabs: this.tabs, current: this.current, marks: this.marks,
      banner: this.status?.(), art: this.animate(),
      title: this.title, lines: this.logs.get(this.current) ?? [],
      choices, selected: this.selected,
      prompt: question && { label: question.label, fallback: question.fallback, text: question.text, cursor: question.cursor, secret: question.secret },
      busy, spinner: this.options.motion ? spinnerFrames[this.spin % spinnerFrames.length] : '•',
      hint, notice: this.notice,
    };
    const { lines, cursor } = renderScreen(state, process.stderr.columns || 80, process.stderr.rows || 24, this.options.colour);
    // Synchronized output keeps terminals that support it from showing half-drawn frames.
    process.stderr.write('\x1b[?2026h\x1b[H' + lines.map(line => `${line}\x1b[K`).join('\r\n') + '\x1b[J'
      + (cursor ? `\x1b[${cursor.row + 1};${cursor.col + 1}H\x1b[?25h` : '\x1b[?25l') + '\x1b[?2026l');
  }
}
