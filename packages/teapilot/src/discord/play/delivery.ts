import type { Clock } from './runtime.js';

/** One edit in flight, one latest view waiting; transport waits never hold the app's action queue. */
export class PlayDelivery {
  private pending?: (current: () => boolean) => Promise<void | false>;
  private revision = 0;
  private busy = false;
  private closed = false;
  private nextAt = 0;
  private cancel?: () => void;

  constructor(private readonly clock: Clock, private readonly interval: number, private readonly failed: (error: unknown) => void) {}

  enqueue(edit: (current: () => boolean) => Promise<void | false>): void {
    if (this.closed) return;
    this.revision++;
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
    const revision = this.revision;
    this.pending = undefined;
    this.busy = true;
    const startedAt = this.clock.now();
    const current = () => !this.closed && revision === this.revision;
    void Promise.resolve().then(() => current() ? edit(current) : false).then(sent => {
      // Preparation can discard an obsolete/unchanged view without spending an edit slot.
      if (sent !== false) this.nextAt = startedAt + this.interval;
    }).catch(error => {
      this.nextAt = this.clock.now() + this.interval;
      this.failed(error);
    }).finally(() => {
      this.busy = false;
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
