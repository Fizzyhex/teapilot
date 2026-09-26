import { createHash } from 'node:crypto';
import type { Policy } from '../config.js';

export type EscalationReason = 'test_failures' | 'tool_failures' | 'ineffective_calls' | 'unsupported' | 'uncertainty' | 'turn_limit' | 'provider_error';
export const SEARCH_UNAVAILABLE = 'No results: the search engines were unavailable';
export class Evidence {
  reason?: EscalationReason;
  toolCalls = 0;
  failures = 0;
  testFailures = 0;
  lastCheck?: 'passed' | 'failed';
  warning?: string;
  changedFiles = new Set<string>();
  fileSizes = new Map<string, number>();
  largestResult?: { tool: string; chars: number };
  unresolvedChecks: Set<string>;
  checks: Array<{ command: string; status: 'passed' | 'failed' }> = [];
  observations: Array<{ tool: string; failed: boolean; detail: string }> = [];
  private inspectionWarning = false;
  // Set once a search repeats after its warning: further searches are refused so the model answers instead.
  searchExhausted = false;
  // Calls refused before execution (unknown tool, invalid arguments, host refusal) never reach observe().
  // A streak of them first withdraws tools so the model answers, then stops the attempt.
  refused = 0;
  answerNow = false;
  private repeated = new Map<string, number>();
  constructor(private readonly thresholds: Policy['escalation'], unresolvedChecks: string[] = []) {
    this.unresolvedChecks = new Set(unresolvedChecks);
  }
  refuse(): void {
    if (++this.refused < this.thresholds.repeatedToolCalls) return;
    if (this.answerNow) this.reason = 'ineffective_calls';
    else { this.answerNow = true; this.refused = 0; }
  }
  observe(name: string, args: unknown, failed: boolean, result?: string): void {
    this.warning = undefined; this.refused = 0;
    const data = args as { path?: string; command?: string };
    this.observations.push({ tool: name, failed, detail: (result ?? '').slice(0, 700) });
    this.observations = this.observations.slice(-6);
    // Cheap signal for which call likely dominated context, without re-serializing on demand.
    const chars = (result ?? '').length + JSON.stringify(args ?? {}).length;
    if (!this.largestResult || chars > this.largestResult.chars) this.largestResult = { tool: name, chars };
    this.failures = failed ? this.failures + 1 : 0;
    if (this.failures >= this.thresholds.consecutiveFailures) this.reason = 'tool_failures';
    if (['bash', 'powershell'].includes(name) && /\b(test|build|check|typecheck|pytest|cargo|dotnet)\b/i.test(String((args as { command?: string }).command))) {
      this.lastCheck = failed ? 'failed' : 'passed';
      if (failed) this.unresolvedChecks.add(String(data.command));
      else this.unresolvedChecks.delete(String(data.command));
      this.checks.push({ command: String(data.command).slice(0, 1000), status: this.lastCheck });
      this.checks = this.checks.slice(-8);
      this.testFailures = failed ? this.testFailures + 1 : 0;
      if (this.testFailures >= this.thresholds.consecutiveFailures) this.reason = 'test_failures';
    }
    if (!failed && ['edit', 'write'].includes(name)) {
      this.changedFiles.add(String(data.path)); this.lastCheck = undefined;
      this.repeated.clear(); this.inspectionWarning = false; return;
    }
    const search = name === 'web_search' && !failed;
    // A search with every engine down cannot improve on retry; refuse further searches at once.
    if (search && result?.startsWith(SEARCH_UNAVAILABLE)) this.searchExhausted = true;
    const inspection = (['repo_list', 'repo_search', 'read'].includes(name) && !failed) || search;
    // Equal bounded inspection results provide no new evidence, even if the
    // caller varies query spelling or optional arguments. Never normalize shell grammar.
    const signature = createHash('sha256').update(JSON.stringify(inspection && result !== undefined ? [name, result] : [name, args])).digest('hex');
    const count = (this.repeated.get(signature) ?? 0) + 1;
    this.repeated.set(signature, count);
    if (count >= this.thresholds.repeatedToolCalls) {
      if (inspection && !this.inspectionWarning) {
        this.inspectionWarning = true;
        this.warning = search
          ? 'Repeated searches produced no new evidence. Stop searching now and answer from the results already found, clearly stating any gaps. Further searches will be refused.'
          : 'Repeated inspection produced no new evidence. Change approach now: use the information already found [*clearly* stating knowledge gaps!], narrow the search, or create the requested files if the repository is empty. Another repeated inspection will stop this attempt.';
      } else if (search) this.searchExhausted = true;
      else this.reason = 'ineffective_calls';
    }
  }
}
