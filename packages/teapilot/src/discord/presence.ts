/**
 * teapilot's Discord status: what it is doing right now, in the bot's custom status. The counts are this
 * session's, so a restart starts from nothing, and each one is left out of the line while it is at zero.
 */
export interface StatusCounts {
  /** discord.play apps running now. */
  games: number;
  /** Conversation turns answered since teapilot started. */
  requests: number;
  /** Teachat rounds finished since teapilot started. */
  gossips: number;
}

/** Discord accepts two presence updates per rate-limit window; a third waits for the window to move. */
export const statusLimit = { updates: 2, windowMs: 30_000 };

/**
 * Leads the status line. It sits in the text rather than the activity's own emoji field, because discord.js
 * sends only an activity's type, name, state and url; Discord shows the two the same way.
 */
export const statusEmoji = '🍵';

const plural = (count: number, word: string) => `${count} ${word}${count === 1 ? '' : 's'}`;

/** The status line, or undefined when every count is at zero and there is nothing to say. */
export function statusText(counts: StatusCounts): string | undefined {
  const parts = [
    counts.games > 0 && `running ${plural(counts.games, 'game')}`,
    counts.requests > 0 && `handled ${plural(counts.requests, 'request')}`,
    counts.gossips > 0 && `gossipped ${plural(counts.gossips, 'time')} :3`,
  ].filter((part): part is string => typeof part === 'string');
  return parts.length ? `${statusEmoji} ${parts.join(' • ')}` : undefined;
}

/**
 * Keeps the bot's status in step with the counts. Every change is shown, but no faster than Discord's limit:
 * once the window is full the next update waits for it to move, and only the latest counts are sent then.
 */
export class StatusPresence {
  private readonly counts: StatusCounts = { games: 0, requests: 0, gossips: 0 };
  /** When each of the recent updates was sent, oldest first. */
  private sent: number[] = [];
  private timer?: ReturnType<typeof setTimeout>;
  /** The line Discord is showing; undefined means no status, which is also where a fresh connection starts. */
  private shown: string | undefined;
  private started = false;
  private closed = false;

  constructor(private readonly options: {
    set(text: string | undefined): Promise<void>;
    log?: (text: string) => void;
    now?: () => number;
  }) {}

  private get now(): number { return this.options.now?.() ?? Date.now(); }

  /** From here on, changes are shown. Nothing is sent before the gateway is connected. */
  start(): void {
    if (this.closed || this.started) return;
    this.started = true;
    this.update();
  }

  /** How many discord.play apps are running. */
  games(count: number): void { this.set('games', count); }
  /** One more conversation turn answered. */
  handled(): void { this.set('requests', this.counts.requests + 1); }
  /** One more teachat round finished. */
  gossipped(): void { this.set('gossips', this.counts.gossips + 1); }

  private set(key: keyof StatusCounts, value: number): void {
    if (this.counts[key] === value) return;
    this.counts[key] = value;
    this.update();
  }

  private update(): void {
    if (this.closed || !this.started || this.timer) return;
    const text = statusText(this.counts);
    if (text === this.shown) return;
    const now = this.now;
    this.sent = this.sent.filter(at => at > now - statusLimit.windowMs);
    if (this.sent.length >= statusLimit.updates) {
      // Wait for the oldest update that still fills the window to leave it, then send whatever the counts are by then.
      const wait = this.sent[this.sent.length - statusLimit.updates]! + statusLimit.windowMs - now;
      this.timer = setTimeout(() => { this.timer = undefined; this.update(); }, Math.max(wait, 1));
      this.timer.unref?.();
      return;
    }
    this.sent.push(now);
    this.shown = text;
    void this.options.set(text).catch(error => this.options.log?.(`Discord status not updated: ${error instanceof Error ? error.message : String(error)}`));
  }

  close(): void {
    this.closed = true;
    clearTimeout(this.timer);
    this.timer = undefined;
  }
}
