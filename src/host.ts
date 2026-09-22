import { randomUUID } from 'node:crypto';
import { mkdir, realpath, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { defaultPolicy, JevRouter, type JevProvider } from 'jevrouter';
import { runAttempt, type AttemptResult } from './agents/run.js';
import { tiers, type Config, type Tier, type Workload } from './config.js';
import type { Approve } from './execution/policy.js';
import { lockState, SpendGovernor } from './inference/budget.js';
import { budgetedJev, localAvailable } from './inference/providers.js';
import { capabilities } from './routing/capabilities.js';
import { Telemetry } from './telemetry/outcome.js';
import { assessCandidate } from './routing/selection.js';

export interface HostRequest { prompt: string; cwd: string; workload?: Workload; web?: boolean; correction?: string; signal?: AbortSignal }
export interface HostResult {
  requestId: string; success: boolean; status: string; text: string;
  capability?: string; spentUsd: number; receipts: string[]; attempts: number;
}
export interface HostDependencies {
  approve: Approve;
  provider?: JevProvider;
  localProbe?: () => Promise<boolean>;
  onProgress?: (message: string) => void;
}

export async function runHost(config: Config, request: HostRequest, dependencies: HostDependencies): Promise<HostResult> {
  if (config.routingMode === 'direct' && !request.workload) throw new Error('Direct routing requires teapilot ask or teapilot code.');
  const prompt = request.prompt.trim();
  if (!prompt || prompt.length + (request.correction?.length ?? 0) > config.policy.limits.maxPromptChars) throw new Error(`Prompt must contain 1–${config.policy.limits.maxPromptChars} characters`);
  const cwd = await realpath(request.cwd);
  if (!(await stat(cwd)).isDirectory()) throw new Error('Working directory is not a directory');
  if (request.web && (!config.searchUrl || !config.policy.permissions.includes('web.search'))) throw new Error('--web requires SEARCH_BASE_URL and web.search permission');
  const unlock = await lockState(config.stateDir);
  const requestId = randomUUID();
  const telemetry = new Telemetry(config.stateDir, requestId, [config.router.apiKey, ...Object.values(config.secrets)].filter((value): value is string => Boolean(value)));
  const budget = new SpendGovernor(join(config.stateDir, 'spend.jsonl'), requestId, config.policy.budget);
  const receipts: string[] = [];
  let attempts = 0;
  let selected: string | undefined;
  const finish = async (success: boolean, status: string, text: string): Promise<HostResult> => {
    const result = { requestId, success, status, text: telemetry.redact(text), capability: selected, spentUsd: budget.spent().request, receipts, attempts };
    await telemetry.event('request_end', { success, status, capability: selected, spentUsd: result.spentUsd, attempts });
    return result;
  };
  try {
    await budget.load();
    await mkdir(config.stateDir, { recursive: true });
    await telemetry.event('request_start', { correction: Boolean(request.correction), web: Boolean(request.web) });
    const router = config.routingMode === 'direct' ? undefined : new JevRouter(budgetedJev(config, budget, telemetry, dependencies.provider), { ...defaultPolicy, ...config.policy.router, single_stage_max_candidates: 32, allow_unavailable_fallback: false });
    const localOnline = await (dependencies.localProbe ?? (() => localAvailable(config)))();
    let scope: { workload: Workload; tier: Tier } | undefined;
    let previous: AttemptResult | undefined;
    const basePrompt = prompt + (request.correction ? `\nUser correction to previous work:\n${request.correction}` : '');
    for (let index = 0; index <= config.policy.escalation.maxEscalations; index++) {
      if (request.signal?.aborted) return await finish(false, 'cancelled', 'Request cancelled.');
      const candidates = capabilities(config, budget, localOnline, scope);
      if (request.workload) for (const candidate of candidates) {
        if (!candidate.id.startsWith(`${request.workload}.`)) candidate.availability = { available: false, reason: 'Outside requested workload' };
      }
      if (request.web) for (const candidate of candidates) {
        const tier = candidate.id.split('.')[1] as Tier;
        if (!config.models[tier].toolCalling) candidate.availability = { available: false, reason: 'Web search requires tool calling' };
      }
      if (!candidates.some(c => c.availability?.available)) return await finish(false, 'unavailable', previous?.text || 'No capability fits the configured availability and budget. Run teapilot doctor.');
      dependencies.onProgress?.(scope ? `Routing escalation to ${scope.workload}.${scope.tier} (${previous?.reason}).` : router ? 'Routing with JevRouter.' : 'Selecting the requested workload directly.');
      const decision = router ? await router.route({
        request: basePrompt,
        context: {
          preference: 'Prefer local inference when suitable. Use economy cloud when local is unavailable or unsuitable. Difficulty alone is not evidence of failure. coder operates in the repository; ask has no filesystem or shell.',
          web_enabled: Boolean(request.web),
          ...(scope ? { escalation: { ...scope, evidence: previous?.reason } } : {}),
        },
        actor_permissions: config.policy.permissions,
      }, candidates) : undefined;
      if (decision) receipts.push(await telemetry.receipt(decision));
      selected = decision ? decision.decision.selected ?? undefined : candidates.find(c => assessCandidate(config, c).allowed)?.id;
      if (!selected || decision?.status === 'no_decision') return await finish(false, 'no_decision', decision ? `JevRouter did not authorize a route (${decision.fallback.type ?? 'manual_review'}). Review the receipt or clarify the request.` : 'No capability passed the direct selection policy. Run teapilot doctor.');
      const candidate = candidates.find(c => c.id === selected);
      const assessment = decision?.decision.candidates.find(c => c.id === selected);
      if (!candidate || !assessCandidate(config, candidate).allowed || (decision && (!assessment || assessment.router.filtered || !assessment.router.allowed))) return await finish(false, 'blocked', 'Selected capability did not pass the execution boundary.');
      if (!decision) await telemetry.event('direct_selection', { capability: selected });
      if (assessCandidate(config, candidate).confirmation || decision?.status === 'needs_confirmation' || assessment?.router.requires_confirmation) {
        const approved = await dependencies.approve({ kind: 'route', summary: `Execute ${selected}?`, details: `Model: ${candidate.metadata?.model}\nMaximum inference charge per turn: $${Number(candidate.metadata?.max_call_usd).toFixed(6)}\nRequest ceiling: $${config.policy.budget.requestUsd}; already charged/reserved: $${budget.spent().request.toFixed(6)}\n${basePrompt}` });
        await telemetry.event('approval', { decisionId: decision?.decision_id, capability: selected, approved });
        if (!approved) return await finish(false, 'approval_denied', 'Route was not approved.');
      }
      const [workload, tier] = selected.split('.') as [Workload, Tier];
      dependencies.onProgress?.(`Executing ${selected} using ${config.models[tier].id}.`);
      attempts++;
      previous = await runAttempt({
        config, workload, tier, cwd, web: Boolean(request.web), budget, telemetry,
        approve: async approval => {
          const approved = await dependencies.approve(approval);
          await telemetry.event('approval', { kind: approval.kind, approved });
          return approved;
        },
        signal: request.signal,
        prompt: basePrompt + (previous ? `\nPrevious cheaper attempt stopped: ${previous.reason}. Existing edits are still in the repository; inspect them before proceeding. Do not restart blindly.\nRecent execution context:\n${previous.handoff ?? previous.text.slice(-6000)}` : ''),
      });
      await telemetry.event('attempt_end', { decisionId: decision?.decision_id, capability: selected, success: previous.success, reason: previous.reason, stopped: previous.stopped, turns: previous.turns, toolCalls: previous.toolCalls, check: previous.check });
      if (previous.success) return await finish(true, 'completed', previous.text);
      if (!previous.reason || ['budget', 'approval_denied', 'cancelled', 'timeout', 'tool_limit'].includes(previous.stopped ?? '') || index === config.policy.escalation.maxEscalations) {
        return await finish(false, previous.stopped ?? previous.reason ?? 'incomplete', previous.text || 'Attempt stopped without completing the request.');
      }
      const next = tiers.slice(tiers.indexOf(tier) + 1).find(nextTier =>
        capabilities(config, budget, localOnline, { workload, tier: nextTier }).some(c => c.id === `${workload}.${nextTier}` && c.availability?.available));
      if (!next) return await finish(false, 'escalation_unavailable', previous.text || 'Cheaper attempt failed; no affordable, available escalation model.');
      await telemetry.event('escalation', { from: selected, to: `${workload}.${next}`, reason: previous.reason });
      scope = { workload, tier: next };
    }
    return await finish(false, 'limit', 'Escalation limit reached.');
  } catch (error) {
    await telemetry.event('request_error', { name: error instanceof Error ? error.name : 'Error' });
    throw error;
  } finally { await unlock(); }
}
