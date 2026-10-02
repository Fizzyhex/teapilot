import type { TaskStore } from '../workspace/task.js';

/** Request-local accounting also works without a scratchpad or durable task state. */
export class RequestAllowance {
  private calls = 0;
  private models = 0;
  private delegations = 0;
  private juniorCalls = new Map<string, number>();
  readonly deadline: number;
  explorationCompactions = new Map<string, number>();
  constructor(readonly limits: { calls: number; modelCalls: number; timeoutMs: number; delegations: number }, readonly task?: TaskStore) {
    this.deadline = Date.now() + limits.timeoutMs;
  }
  remaining() {
    return this.task?.remaining() ?? { calls: Math.max(0, this.limits.calls - this.calls), modelCalls: Math.max(0, this.limits.modelCalls - this.models), ms: Math.max(0, this.deadline - Date.now()) };
  }
  consumeTool(junior?: string): boolean {
    if (!this.remaining().calls || !this.remaining().ms) return false;
    // TaskStore.begin records the durable charge; this counter is its non-persistent counterpart.
    if (!this.task) this.calls++;
    if (junior) {
      this.juniorCalls.set(junior, this.usedBy(junior) + 1);
      this.task?.consumeJunior(junior);
    }
    return true;
  }
  consumeModel(): boolean {
    if (this.task) return this.task.consumeModel();
    if (!this.remaining().modelCalls || !this.remaining().ms) return false;
    this.models++; return true;
  }
  usedBy(junior: string): number { return this.task?.juniorCalls(junior) ?? this.juniorCalls.get(junior) ?? 0; }
  get delegationExhausted(): boolean { return this.task ? this.task.delegationExhausted : this.delegations >= this.limits.delegations || this.remaining().calls <= 4; }
  consumeDelegation(): boolean {
    if (this.delegationExhausted) return false;
    if (this.task) return this.task.consumeDelegation();
    this.delegations++; return true;
  }
}

export const planningCallLimit = 24;
