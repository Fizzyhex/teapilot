import { createHash } from 'node:crypto';
import type { Policy } from '../config.js';

export type EscalationReason = 'test_failures' | 'tool_failures' | 'ineffective_calls' | 'unsupported' | 'uncertainty' | 'turn_limit' | 'provider_error';
export class Evidence {
  reason?: EscalationReason;
  toolCalls = 0;
  failures = 0;
  testFailures = 0;
  lastCheck?: 'passed' | 'failed';
  warning?: string;
  changedFiles = new Set<string>();
  shellRan = false;
  checks: Array<{ command: string; status: 'passed' | 'failed' }> = [];
  observations: Array<{ tool: string; failed: boolean; detail: string }> = [];
  private inspectionWarning = false;
  private repeated = new Map<string, number>();
  constructor(private readonly thresholds: Policy['escalation']) {}
  observe(name: string, args: unknown, failed: boolean, result?: string): void {
    this.warning = undefined;
    const data = args as { path?: string; command?: string };
    if (['bash', 'powershell'].includes(name)) this.shellRan = true;
    this.observations.push({ tool: name, failed, detail: (result ?? '').slice(0, 700) });
    this.observations = this.observations.slice(-6);
    this.failures = failed ? this.failures + 1 : 0;
    if (this.failures >= this.thresholds.consecutiveFailures) this.reason = 'tool_failures';
    if (['bash', 'powershell'].includes(name) && /\b(test|build|check|typecheck|pytest|cargo|dotnet)\b/i.test(String((args as { command?: string }).command))) {
      this.lastCheck = failed ? 'failed' : 'passed';
      this.checks.push({ command: String(data.command).slice(0, 1000), status: this.lastCheck });
      this.checks = this.checks.slice(-8);
      this.testFailures = failed ? this.testFailures + 1 : 0;
      if (this.testFailures >= this.thresholds.consecutiveFailures) this.reason = 'test_failures';
    }
    if (!failed && ['edit', 'write'].includes(name)) {
      this.changedFiles.add(String(data.path)); this.lastCheck = undefined;
      this.repeated.clear(); this.inspectionWarning = false; return;
    }
    const inspection = ['repo_list', 'repo_search', 'read'].includes(name) && !failed;
    // Equal bounded inspection results provide no new evidence, even if the
    // caller varies query spelling or optional arguments. Never normalize shell grammar.
    const signature = createHash('sha256').update(JSON.stringify(inspection && result !== undefined ? [name, result] : [name, args])).digest('hex');
    const count = (this.repeated.get(signature) ?? 0) + 1;
    this.repeated.set(signature, count);
    if (count >= this.thresholds.repeatedToolCalls) {
      if (inspection && !this.inspectionWarning) {
        this.inspectionWarning = true;
        this.warning = 'Repeated inspection produced no new evidence. Change approach now: use the information already found, narrow the search, or create the requested files if the repository is empty. Another repeated inspection will stop this attempt.';
      } else this.reason = 'ineffective_calls';
    }
  }
}
