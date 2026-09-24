import { describeTool } from '../presentation.js';
import type { HostEvent } from '../integration/events.js';

/** Discord's hard limit for one message's content. */
export const MESSAGE_LIMIT = 2000;
const fence = /^\s*(`{3,}|~{3,})/;

/**
 * Split text into messages of at most `limit` characters, preferring line breaks.
 * An open code fence is closed at the end of a chunk and reopened in the next.
 */
export function chunk(text: string, limit = MESSAGE_LIMIT): string[] {
  const chunks: string[] = [];
  const marker = (line: string) => line.match(fence)?.[1];
  let open: string | undefined; // the line that opened the current fence
  let lines: string[] = [];
  let content = false; // the chunk holds more than a reopened fence
  const size = () => lines.reduce((total, line) => total + line.length + 1, 0);
  const close = () => {
    if (content) chunks.push([...lines, ...(open ? [marker(open)!] : [])].join('\n'));
    lines = open ? [open] : []; content = false;
  };
  for (const line of text.split('\n')) {
    const next = marker(line);
    // Room for the separator and a closing fence, whichever fence is open after this line.
    const reserve = Math.max(open ? marker(open)!.length : 0, next?.length ?? 0) + 1;
    let rest = line;
    while (size() + rest.length + reserve > limit) {
      if (content) { close(); continue; }
      const width = Math.max(1, limit - size() - reserve);
      lines.push(rest.slice(0, width)); content = true; rest = rest.slice(width);
      close();
    }
    lines.push(rest); content ||= Boolean(rest.trim());
    if (next) {
      const opener = open && marker(open)!;
      // A closing fence uses the same character, is at least as long, and has no info string.
      if (!opener) open = line;
      else if (next[0] === opener[0] && next.length >= opener.length && !line.trim().slice(next.length).trim()) open = undefined;
    }
  }
  close();
  return chunks;
}

/** One status message per turn: the running tool, then completed tool lines, newest last. */
export class ProgressLine {
  private lines: string[] = [];
  private running?: string;
  constructor(private readonly redact: (text: string) => string, private readonly maxLines = 15) {}
  push(event: HostEvent): boolean {
    if (event.type === 'tool_execution_start') { this.running = String(event.tool ?? 'tool'); return true; }
    if (event.type !== 'tool_execution_end') return false;
    this.running = undefined;
    this.lines.push(this.redact(describeTool(event)));
    return true;
  }
  get empty(): boolean { return !this.lines.length && !this.running; }
  render(): string {
    const hidden = Math.max(0, this.lines.length - this.maxLines);
    const shown = this.lines.slice(hidden).map(line => `- ${line.length > 180 ? `${line.slice(0, 177)}...` : line}`);
    return [
      ...(hidden ? [`- ... ${hidden} earlier`] : []),
      ...shown,
      ...(this.running ? [`- running ${this.running}...`] : []),
    ].join('\n').slice(0, MESSAGE_LIMIT);
  }
}

/** Coalesce frequent updates into at most one call per interval, always delivering the latest. */
export function throttle(action: () => Promise<void>, intervalMs: number): { request(): void; flush(): Promise<void> } {
  let last = 0;
  let timer: NodeJS.Timeout | undefined;
  let chain: Promise<void> = Promise.resolve();
  const run = () => { timer = undefined; last = Date.now(); chain = chain.then(action).catch(() => undefined); return chain; };
  return {
    request() {
      if (timer) return;
      const wait = Math.max(0, last + intervalMs - Date.now());
      timer = setTimeout(run, wait);
    },
    async flush() {
      if (timer) { clearTimeout(timer); await run(); }
      await chain;
    },
  };
}
