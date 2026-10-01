import type { HostResult } from '../../src/host.js';
import type { World } from './world.js';

/** Completion is independent of visible cards, including casual and answer-only replies. */
export class TurnEvents {
  private result?: Pick<HostResult, 'status' | 'requestId'>;
  private readonly listeners = new Set<() => void>();

  constructor(private readonly world: World, private readonly running: () => boolean) {}

  reset(): void { this.result = undefined; }
  complete(result: Pick<HostResult, 'status' | 'requestId'>): void {
    this.result = result;
    this.notify();
  }
  notify(): void { for (const listener of this.listeners) listener(); }
  get waiting(): boolean { return this.listeners.size > 0; }

  wait(timeout: number): Promise<Record<string, unknown>> {
    return new Promise(done => {
      const finish = (event: string, fields: Record<string, unknown> = {}) => {
        this.listeners.delete(evaluate);
        off();
        clearTimeout(timer);
        done({ event, ...fields });
      };
      const evaluate = () => {
        const approval = this.world.pendingApproval();
        if (approval) return finish('approval', { message: approval.id, text: this.world.render(approval) });
        if (this.result) return finish('turn_end', this.result);
        if (!this.running()) finish('stopped');
      };
      const off = this.world.onEvent(evaluate);
      const timer = setTimeout(() => finish('timeout'), timeout * 1000);
      this.listeners.add(evaluate);
      evaluate();
    });
  }
}
