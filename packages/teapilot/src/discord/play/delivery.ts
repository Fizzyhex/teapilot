import type { Clock } from './runtime.js';

/** One edit in flight, one latest view waiting; transport waits never hold the app's action queue. */
export class PlayDelivery {
  private pending?: () => Promise<void>;
  private busy = false;
  private closed = false;
  private nextAt = 0;
  private cancel?: () => void;

  constructor(private readonly clock: Clock, private readonly interval: number, private readonly failed: (error: unknown) => void) {}

  enqueue(edit: () => Promise<void>): void {
    if (this.closed) return;
    this.pending = edit;
    this.flush();
  }

  private flush(): void {
    if (this.closed || this.busy || this.cancel || !this.pending) return;
    const wait = this.nextAt - this.clock.now();
    if (wait > 0) {
      this.cancel = this.clock.after(wait, () => { this.cancel = undefined; this.flush(); });
      return;
    }
    const edit = this.pending;
    this.pending = undefined;
    this.busy = true;
    void Promise.resolve().then(() => { if (!this.closed) return edit(); }).catch(this.failed).finally(() => {
      this.busy = false;
      this.nextAt = this.clock.now() + this.interval;
      this.flush();
    });
  }

  close(): void {
    this.closed = true;
    this.pending = undefined;
    this.cancel?.();
    this.cancel = undefined;
  }
}
