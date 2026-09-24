import type { HostEvent } from './integration/events.js';
import { stripVTControlCharacters } from 'node:util';
import type { Activity, ActivityUI } from './activity.js';
import { loadClips, Playback } from './art/playback.js';

const ACTIVITY_COLOUR = '38;2;186;187;241'; // #babbf1
// this is catpuccin lavender :3

export function terminalColour(tty: boolean | undefined, env = process.env): boolean {
  return Boolean(tty && env.TERM !== 'dumb' && env.NO_COLOR === undefined);
}
const paint = (text: string, code: string, enabled: boolean) => enabled ? `\x1b[${code}m${text}\x1b[0m` : text;

/** Style complete lines, retaining every Markdown character and code indent. */
export class MarkdownOutput {
  private pending = '';
  private fence?: string;
  constructor(private readonly write: (text: string) => void, private readonly colour: boolean) { }
  push(text: string): void {
    this.pending += text;
    let end: number;
    while ((end = this.pending.indexOf('\n')) >= 0) {
      this.write(this.line(this.pending.slice(0, end)) + '\n');
      this.pending = this.pending.slice(end + 1);
    }
    // Long unbroken output remains bounded and literal, without guessing markup.
    if (this.pending.length > 4096) { this.write(this.pending); this.pending = ''; }
  }
  get preview(): string { return this.pending; }
  discardPreview(): void { this.pending = ''; this.fence = undefined; }
  finish(): void { if (this.pending) this.write(this.line(this.pending)); this.pending = ''; this.fence = undefined; }
  private line(text: string): string {
    const marker = text.match(/^\s{0,3}(`{3,}|~{3,})/)?.[1];
    if (marker) {
      if (!this.fence) this.fence = marker;
      else if (marker[0] === this.fence[0] && marker.length >= this.fence.length) this.fence = undefined;
      return text;
    }
    if (this.fence || /^( {4}|\t)/.test(text)) return text;
    if (/^#{1,6} /.test(text)) return paint(text, '1;32', this.colour);
    return text.split(/(`+[^`]*`+|https?:\/\/\S+)/g).map((part, index) => index % 2 ? part :
      part.replace(/\*\*[^*\n]+\*\*|__[^_\n]+__|\*[^*\n]+\*|_[^_\n]+_/g, match => paint(match, match.startsWith('**') || match.startsWith('__') ? '1' : '3', this.colour))).join('');
  }
}

/** Only track text whose cell width is unambiguous in our supported terminals.
 * Other text still streams immediately, but without cursor-relative decoration. */
export function terminalRows(text: string, columns: number): number | undefined {
  if (!columns) return undefined;
  const plain = stripVTControlCharacters(text);
  if (/[^\x20-\x7e\n\u00a0-\u024f\u2010-\u2027]/u.test(plain)) return undefined;
  return plain.split('\n').reduce((rows, line) => rows + Math.max(1, Math.ceil(line.length / columns)), 0);
}

export class TerminalPresentation implements ActivityUI {
  private readonly colour = terminalColour(process.stderr.isTTY && process.stdout.isTTY);
  private readonly stream = Boolean(process.stdout.isTTY && process.stderr.isTTY && process.env.TERM !== 'dumb');
  private readonly markdown = new MarkdownOutput(text => process.stdout.write(text), terminalColour(process.stdout.isTTY));
  private readonly playback = new Playback(() => this.draw());
  private current?: Activity;
  private scopes: Array<{ activity: Activity }> = [];
  private base?: Activity;
  private message = '';
  private lastMessage = '';
  private messageOpen = false;
  private literal = false;
  private previewRows = 0;
  private artRows: string[] = [];
  private prompt?: { touched: boolean; safe: boolean; cursor: () => { rows: number; cols: number } };
  private contextRows = 0;
  private suppressed = false;
  private suspended = 0;
  private closed = false;
  private lastLabel = '';
  private listening = false;
  private clipKind?: Activity['kind'];
  private deferred: Array<{ text: string; target: 'stdout' | 'stderr' }> = [];
  private readonly resize = () => {
    if (!this.artRows.length && !this.previewRows && !this.prompt) {
      this.suppressed = false; this.update(); return;
    }
    // Reflow has already happened: never move up using pre-resize coordinates.
    this.playback.stop(); this.artRows = []; this.previewRows = 0;
    this.suppressed = true;
    if (this.prompt) { this.prompt.touched = true; this.prompt.safe = false; }
    else {
      process.stderr.write('\n');
      // Any live preview is now committed at its reflowed location.
      if (this.messageOpen) { this.literal = true; this.markdown.discardPreview(); }
      this.textStatus();
    }
  };
  private readonly drain = () => { if (!this.closed) this.draw(); };
  constructor(private readonly json: boolean, private readonly noMotion: boolean) { }

  private eligible(): boolean {
    return !this.closed && !this.json && !this.noMotion && this.stream && Boolean(process.stdin.isTTY)
      && process.env.TEAPILOT_NO_MOTION === undefined && !process.env.CI && !this.suppressed
      && (process.stderr.columns || 0) >= 61 && (process.stderr.rows || 0) >= 36;
  }
  private listen(): void {
    if (this.listening) return;
    this.listening = true;
    process.stderr.on('resize', this.resize);
    process.stderr.on('drain', this.drain);
    process.stdout.on('drain', this.drain);
  }
  private writable(): boolean { return !process.stderr.writableNeedDrain && !process.stdout.writableNeedDrain; }
  private label(): string { return this.prompt ? 'Waiting for your input...' : this.current?.label ?? ''; }
  private textStatus(): void {
    const label = this.label();
    if (!this.json && !this.prompt && !this.suspended && label && label !== this.lastLabel) {
      this.lastLabel = label;
      // Do not insert status into a response's unfinished line.
      if (!this.messageOpen) process.stderr.write(`${label}\n`);
    }
  }
  private eraseRows(rows: number): void {
    if (!rows) return;
    process.stderr.write(`\r\x1b[${rows}A` + Array.from({ length: rows }, () => '\x1b[2K\x1b[1B').join('') + `\x1b[${rows}A`);
  }
  clear(): void {
    if (this.prompt) return;
    this.eraseRows(this.previewRows + this.artRows.length);
    this.previewRows = 0; this.artRows = [];
  }
  private draw(): void {
    if (this.closed || this.suspended || !this.writable()) return;
    if (this.prompt) { this.drawPrompt(); return; }
    if (!this.eligible() || (this.messageOpen && this.literal)) return;
    const frame = this.playback.frame;
    if (!frame || !this.current) return;
    const rows = [...frame.split('\n'), this.label().slice(0, process.stderr.columns - 1)];
    // The answer preview is stable between text events. Change only artwork rows.
    if (this.artRows.length === rows.length) {
      let update = '';
      rows.forEach((row, index) => {
        if (row !== this.artRows[index]) {
          const distance = rows.length - index;
          update += `\r\x1b[${distance}A\x1b[2K${paint(row, ACTIVITY_COLOUR, this.colour)}\r\x1b[${distance}B`;
        }
      });
      if (update) process.stderr.write(update);
    } else {
      process.stderr.write(
        paint(rows.join('\n'), ACTIVITY_COLOUR, this.colour) + '\n'
      );
    }
    this.artRows = rows;
  }
  private update(): void {
    const next = this.scopes.at(-1)?.activity ?? this.base;
    const sameKind = next?.kind === this.clipKind;
    this.current = next;
    if (this.prompt || this.suspended || this.closed) return;
    if (!next) { this.playback.stop(); this.clipKind = undefined; this.clear(); this.showPreview(); this.lastLabel = ''; return; }
    if (!this.json && !this.noMotion && this.stream && process.env.TEAPILOT_NO_MOTION === undefined && !process.env.CI) this.listen();
    const clips = this.eligible() ? loadClips() : undefined;
    if (!clips) { this.playback.stop(); this.clipKind = undefined; this.clear(); this.showPreview(); this.textStatus(); return; }
    this.listen();
    if (sameKind) { this.draw(); return; }
    this.clear();
    this.clipKind = next.kind;
    this.playback.play(next.kind === 'composing' ? clips.typing : clips['coffee-break'], undefined, next.kind === 'composing', 250);
    this.showPreview();
  }
  setActivity = (activity: Activity | undefined): void => { this.base = activity; this.update(); };
  activity = (activity: Activity): (() => void) => {
    const scope = { activity }; this.scopes.push(scope); this.update();
    let ended = false;
    return () => {
      if (ended) return; ended = true;
      this.scopes = this.scopes.filter(item => item !== scope); this.update();
    };
  };
  start(): void { this.setActivity({ kind: 'waiting', label: 'Preparing request...' }); }
  pause(): void { this.base = undefined; this.scopes = []; this.current = undefined; this.clipKind = undefined; this.playback.stop(); this.clear(); }
  suspend = (): (() => void) => {
    this.playback.stop(); this.clear(); this.suspended++;
    let resumed = false;
    return () => { if (!resumed) { resumed = true; this.suspended--; this.clipKind = undefined; this.playback.frame = undefined; this.update(); } };
  };
  write(text: string, target: 'stdout' | 'stderr' = 'stderr'): void {
    if (this.messageOpen) { this.deferred.push({ text, target }); return; }
    this.clear();
    process[target].write(text);
    this.contextRows += terminalRows(text, process.stderr.columns || 80) ?? process.stderr.rows ?? 36;
    this.draw();
  }
  log(text: string): void { this.write(`${paint(text, '32', this.colour && !this.json)}\n`); }
  approval(text: string): void {
    this.playback.stop(); this.clear(); this.endMessage(); this.contextRows = 0;
    this.write(`${paint('Approval', '1;33', this.colour && !this.json)}\n${text}\n`);
  }

  /** Start before readline.question, then paint only while its input is untouched. */
  beginPrompt(label: string, cursor: () => { rows: number; cols: number }): void {
    this.playback.stop(); this.clipKind = undefined; this.clear(); this.endMessage();
    this.suppressed = false;
    const rows = terminalRows(label, process.stderr.columns || 0);
    const clips = this.eligible() && rows !== undefined && this.contextRows + rows + 19 < process.stderr.rows ? loadClips() : undefined;
    this.prompt = { touched: false, safe: Boolean(clips), cursor };
    if (clips) {
      this.listen();
      // Allocate above the prompt before readline writes it. Subsequent frames
      // move relative to readline's public cursor position, never saved cursors.
      this.artRows = [...clips.pawing.frames[2]!.split('\n'), 'Waiting for your input...'];
      process.stderr.write(
        paint(this.artRows.join('\n'), ACTIVITY_COLOUR, this.colour) + '\n'
      );
      this.playback.play(clips.pawing, [2, 3]);
    }
  }
  touchPrompt = (): void => {
    if (!this.prompt || this.prompt.touched) return;
    this.prompt.touched = true; this.playback.stop();
  };
  private drawPrompt(): void {
    const prompt = this.prompt;
    if (!prompt?.safe || prompt.touched || !this.playback.frame || !this.artRows.length) return;
    const position = prompt.cursor();
    const rows = [...this.playback.frame.split('\n'), 'Waiting for your input...'];
    if (rows.every((row, index) => row === this.artRows[index])) return;
    const distance = rows.length + position.rows;
    process.stderr.write(
      `\r\x1b[${distance}A` +
      paint(rows.join('\n'), ACTIVITY_COLOUR, this.colour) +
      `\r\x1b[${position.rows + 1}B` +
      (position.cols ? `\x1b[${position.cols}C` : '')
    );
    this.artRows = rows;
  }
  endPrompt(submitted: boolean, occupiedRows: number): void {
    const prompt = this.prompt;
    this.playback.stop();
    // Once a long input has scrolled, its old artwork belongs to scrollback.
    const reclaim = !this.closed && prompt?.safe && occupiedRows + this.artRows.length < (process.stderr.rows || 0);
    if (reclaim && this.artRows.length) {
      const distance = this.artRows.length + occupiedRows;
      // Delete exactly our artwork rows, moving the accepted prompt up intact.
      process.stderr.write(`\r\x1b[${distance}A\x1b[${this.artRows.length}M`
        + (occupiedRows ? `\x1b[${occupiedRows}B` : ''));
    }
    this.prompt = undefined; this.artRows = []; this.contextRows = 0;
    this.suppressed = !prompt?.safe && this.suppressed;
    if (submitted && reclaim && this.eligible()) {
      // A fresh, owned area below the accepted prompt avoids rewriting input.
      const clips = loadClips();
      if (clips) {
        this.current = { kind: 'waiting', label: 'Input received' };
        this.playback.play(clips.pawing, [4, 5, 6]);
      }
    } else this.playback.frame = undefined;
    // The caller runs immediately. Its next activity/question interrupts closing.
    if (this.scopes.length || this.base) { this.clipKind = undefined; this.playback.frame = undefined; this.update(); }
  }

  private showPreview(): void {
    const text = this.markdown.preview;
    if (!text || this.literal) return;
    const rows = terminalRows(text, process.stderr.columns || 0);
    if (!this.eligible() || !this.writable() || rows === undefined || rows + 19 >= process.stderr.rows) {
      this.playback.stop(); this.clipKind = undefined; this.literal = true; this.markdown.finish(); return;
    }
    process.stdout.write(text + '\n'); this.previewRows = rows;
  }
  event(event: HostEvent): void {
    if (this.json) return;
    if (event.type === 'text' && typeof event.text === 'string') {
      if (!this.stream) return;
      this.clear();
      if (!this.messageOpen) {
        process.stdout.write(paint('\nResponse\n', '1', terminalColour(process.stdout.isTTY)));
        this.messageOpen = true; this.message = ''; this.literal = !this.eligible() || !loadClips();
      }
      this.message += event.text;
      if (!this.literal) {
        const pending = (this.markdown.preview + event.text).split('\n').at(-1)!;
        const rows = terminalRows(pending, process.stderr.columns || 0);
        if (!this.writable() || rows === undefined || rows + 19 >= process.stderr.rows || pending.length > 4096) {
          this.playback.stop(); this.clipKind = undefined; this.literal = true; this.markdown.finish();
        }
      }
      if (this.literal) process.stdout.write(event.text);
      else { this.markdown.push(event.text); this.showPreview(); this.draw(); }
    } else if (event.type === 'message_end') { this.clear(); this.endMessage(); this.draw(); }
    else if (event.type === 'tool_execution_start') this.setActivity({ kind: 'waiting', label: `Running ${String(event.tool)}...` });
    else if (event.type === 'request_end' || event.type === 'request_error') this.pause();
  }
  private endMessage(): void {
    if (!this.messageOpen) return;
    this.clear();
    if (!this.literal) this.markdown.finish();
    if (!this.message.endsWith('\n')) process.stdout.write('\n');
    this.lastMessage = this.message; this.messageOpen = false; this.literal = false;
    for (const output of this.deferred.splice(0)) this.write(output.text, output.target);
  }
  answer(text: string): void {
    this.pause(); this.endMessage();
    if (this.stream && text === this.lastMessage) return;
    this.markdown.push(text); this.markdown.finish();
    if (!text.endsWith('\n')) process.stdout.write('\n');
  }
  close(): void {
    if (this.closed) return;
    this.pause(); this.endMessage(); this.closed = true;
    process.stderr.removeListener('resize', this.resize);
    process.stderr.removeListener('drain', this.drain);
    process.stdout.removeListener('drain', this.drain);
  }
}
