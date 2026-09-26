import type { Clock } from '../../src/discord/play/runtime.js';

interface Entry { due: number; run(): void; timer?: ReturnType<typeof setTimeout> }

/**
 * Real time that can jump forward. Timers still fire on their own, and `advance` brings forward every
 * timer the jump makes due, in due order, so a 30-second game timer need not take 30 seconds.
 * A frozen clock stands still between jumps, so a fast game only moves when `advance` says so.
 */
export class SkippableClock implements Clock {
  private offset = 0;
  private readonly pending = new Set<Entry>();
  private readonly origin = Date.now();

  constructor(private readonly frozen = false) {}

  now(): number { return (this.frozen ? this.origin : Date.now()) + this.offset; }

  after(ms: number, run: () => void): () => void {
    const entry: Entry = { due: this.now() + ms, run };
    this.pending.add(entry);
    this.arm(entry);
    return () => { clearTimeout(entry.timer); this.pending.delete(entry); };
  }

  private arm(entry: Entry): void {
    clearTimeout(entry.timer);
    if (this.frozen && entry.due > this.now()) return;
    entry.timer = setTimeout(() => { this.pending.delete(entry); entry.run(); }, Math.max(0, entry.due - this.now()));
  }

  /** Jumps ahead; returns how many timers became due. */
  advance(ms: number): number {
    this.offset += ms;
    // Every timer is nearer now, not only the due ones; re-arming in due order keeps them in order.
    const entries = [...this.pending].sort((a, b) => a.due - b.due);
    for (const entry of entries) this.arm(entry);
    return entries.filter(entry => entry.due <= this.now()).length;
  }

  /** How far ahead of real time this clock runs. */
  get skipped(): number { return this.offset; }
}
