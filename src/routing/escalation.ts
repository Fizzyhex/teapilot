import { createHash } from 'node:crypto';
import type { Policy } from '../config.js';

export type EscalationReason = 'test_failures' | 'tool_failures' | 'ineffective_calls' | 'unsupported' | 'uncertainty' | 'turn_limit' | 'provider_error';
export class Evidence {
  reason?: EscalationReason;
  toolCalls = 0;
  failures = 0;
  testFailures = 0;
  lastCheck?: 'passed' | 'failed';
  private repeated = new Map<string, number>();
  constructor(private readonly thresholds: Policy['escalation']) {}
  observe(name: string, args: unknown, failed: boolean): void {
    this.failures = failed ? this.failures + 1 : 0;
    if (this.failures >= this.thresholds.consecutiveFailures) this.reason = 'tool_failures';
    if (['bash', 'powershell'].includes(name) && /\b(test|build|check|typecheck|pytest|cargo|dotnet)\b/i.test(String((args as { command?: string }).command))) {
      this.lastCheck = failed ? 'failed' : 'passed';
      this.testFailures = failed ? this.testFailures + 1 : 0;
      if (this.testFailures >= this.thresholds.consecutiveFailures) this.reason = 'test_failures';
    }
    if (!failed && ['edit', 'write'].includes(name)) { this.repeated.clear(); return; }
    const signature = createHash('sha256').update(JSON.stringify([name, args])).digest('hex');
    const count = (this.repeated.get(signature) ?? 0) + 1;
    this.repeated.set(signature, count);
    if (count >= this.thresholds.repeatedToolCalls) this.reason = 'ineffective_calls';
  }
}
