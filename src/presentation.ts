import type { HostEvent } from './integration/events.js';

export function terminalColour(tty: boolean | undefined, env = process.env): boolean {
  return Boolean(tty && env.TERM !== 'dumb' && env.NO_COLOR === undefined);
}
const paint = (text: string, code: string, enabled: boolean) => enabled ? `\x1b[${code}m${text}\x1b[0m` : text;

/** Style complete lines, retaining every Markdown character and code indent. */
export class MarkdownOutput {
  private pending = '';
  private fence?: string;
  constructor(private readonly write: (text: string) => void, private readonly colour: boolean) {}
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
    return text.split(/(`+[^`]*`+)/g).map((part, index) => index % 2 ? part :
      part.replace(/\*\*[^*\n]+\*\*|__[^_\n]+__|\*[^*\n]+\*|_[^_\n]+_/g, match => paint(match, match.startsWith('**') || match.startsWith('__') ? '1' : '3', this.colour))).join('');
  }
}

export class TerminalPresentation {
  private readonly colour = terminalColour(process.stderr.isTTY && process.stdout.isTTY);
  private readonly stream = Boolean(process.stdout.isTTY && process.stderr.isTTY && process.env.TERM !== 'dumb');
  private readonly markdown = new MarkdownOutput(text => process.stdout.write(text), terminalColour(process.stdout.isTTY));
  private timer?: ReturnType<typeof setInterval>;
  private frame = 0;
  private visible = false;
  private lastToken = 0;
  private message = '';
  private lastMessage = '';
  private messageOpen = false;
  constructor(private readonly json: boolean, private readonly noMotion: boolean) {}
  start(): void {
    if (this.timer || this.json || this.noMotion || !this.stream || process.env.TEAPILOT_NO_MOTION !== undefined) return;
    this.timer = setInterval(() => {
      const label = Date.now() - this.lastToken < 800 ? 'Receiving response' : 'Working';
      const frames = ['.', '..', '...'];
      const text = `${label}${frames[this.frame++ % frames.length]}`;
      process.stderr.write(`\r\x1b[2K${paint(text.slice(0, Math.max(1, (process.stderr.columns || 80) - 1)), '32', this.colour)}`);
      this.visible = true;
    }, 200);
    this.timer.unref();
  }
  clear(): void { if (this.visible) process.stderr.write('\r\x1b[2K'); this.visible = false; }
  pause(): void { if (this.timer) clearInterval(this.timer); this.timer = undefined; this.clear(); }
  log(text: string): void { this.clear(); process.stderr.write(`${paint(text, '32', this.colour && !this.json)}\n`); }
  approval(text: string): void { this.pause(); this.endMessage(); process.stderr.write(`${paint('Approval', '1;33', this.colour && !this.json)}\n${text}\n`); }
  event(event: HostEvent): void {
    if (this.json) return;
    if (event.type === 'text' && typeof event.text === 'string') {
      this.lastToken = Date.now();
      if (!this.stream) return;
      this.pause();
      if (!this.messageOpen) { process.stdout.write(paint('\nResponse\n', '1', terminalColour(process.stdout.isTTY))); this.messageOpen = true; this.message = ''; }
      this.message += event.text;
      this.markdown.push(event.text);
    } else if (event.type === 'message_end') { this.endMessage(); this.lastToken = 0; }
    else if (event.type === 'tool_execution_start' || event.type === 'attempt_start') this.start();
  }
  private endMessage(): void {
    if (!this.messageOpen) return;
    this.clear(); this.markdown.finish();
    if (!this.message.endsWith('\n')) process.stdout.write('\n');
    this.lastMessage = this.message; this.messageOpen = false;
  }
  answer(text: string): void {
    this.pause(); this.endMessage();
    if (this.stream && text === this.lastMessage) return;
    this.markdown.push(text); this.markdown.finish();
    if (!text.endsWith('\n')) process.stdout.write('\n');
  }
  close(): void { this.pause(); this.endMessage(); }
}
