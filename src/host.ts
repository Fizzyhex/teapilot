import type { ActivitySink } from './activity.js';
import { randomUUID } from 'node:crypto';
import { mkdir, realpath, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { defaultPolicy, JevRouter } from 'jevrouter';
import { runAttempt, type AttemptResult } from './agents/run.js';
import { tiers, type Config, type Tier, type Workload } from './config.js';
import { ExecutionPolicy, type Approve, type BeforeMutation } from './execution/policy.js';
import { prepareConversation, type ConversationTurn, type TextContext, type EventSink } from './integration/events.js';
import { lockState, SpendGovernor } from './inference/budget.js';
import { budgetedJev, localAvailable, type CancellableJevProvider } from './inference/providers.js';
import { capabilities } from './routing/capabilities.js';
import { Telemetry } from './telemetry/outcome.js';
import { assessCandidate } from './routing/selection.js';
import { checkSearch, searchRepair } from './search.js';

export interface HostRequest { prompt: string; cwd: string; workload?: Workload; chat?: boolean; web?: boolean; correction?: string; signal?: AbortSignal; history?: ConversationTurn[]; context?: TextContext[] }
export interface HostResult {
  requestId: string; success: boolean; status: string; text: string;
  capability?: string; spentUsd: number; receipts: string[]; attempts: number;
  check?: 'passed' | 'failed'; models?: string[];
}
export interface HostDependencies {
  approve: Approve;
  onActivity?: ActivitySink;
  provider?: CancellableJevProvider;
  localProbe?: () => Promise<boolean>;
  onProgress?: (message: string) => void;
  onEvent?: EventSink; beforeMutation?: BeforeMutation;
}

export async function runHost(config: Config, request: HostRequest, dependencies: HostDependencies): Promise<HostResult> {
  if (config.routingMode === 'direct' && !request.workload) throw new Error('Direct routing requires teapilot ask or teapilot code.');
  const prompt = request.prompt.trim();
  if (!prompt || prompt.length + (request.correction?.length ?? 0) > config.policy.limits.maxPromptChars) throw new Error(`Prompt must contain 1–${config.policy.limits.maxPromptChars} characters`);
  dependencies.onActivity?.({ kind: 'waiting', label: 'Checking request availability...' });
  const cwd = await realpath(request.cwd);
  if (!(await stat(cwd)).isDirectory()) throw new Error('Working directory is not a directory');
  const contextPolicy = new ExecutionPolicy(cwd, config, dependencies.approve);
  for (const context of request.context ?? []) if (context.path) await contextPolicy.path(context.path, false);
  const conversation = prepareConversation(prompt + (request.correction ? `\nUser correction:\n${request.correction}` : ''), request.context ?? [], request.history ?? [], config.policy.limits.maxPromptChars);
  if (conversation.omitted) dependencies.onEvent?.({ type: 'history_omitted', turns: conversation.omitted });
  if (request.web) {
    dependencies.onActivity?.({ kind: 'waiting', label: 'Checking web search...' });
    await checkSearch(config, request.signal);
  }
  const unlock = await lockState(config.stateDir);
  const requestId = randomUUID();
  const telemetry = new Telemetry(config.stateDir, requestId, [config.router.apiKey, ...Object.values(config.secrets)].filter((value): value is string => Boolean(value)), dependencies.onEvent);
  const budget = new SpendGovernor(join(config.stateDir, 'spend.jsonl'), requestId, config.policy.budget);
  const receipts: string[] = [];
  let attempts = 0;
  let selected: string | undefined;
  let check: 'passed' | 'failed' | undefined;
  const models: string[] = [];
  const changedFiles = new Set<string>();
  let shellRan = false;
  const incomplete = (attempt: AttemptResult, fallback?: string) => {
    const stop = attempt.stopped ?? attempt.reason ?? 'incomplete';
    const actions: Record<string, string> = {
      approval_denied: 'Review the denied action; rerun only if it is appropriate to approve it.',
      provider_error: 'Run teapilot doctor --live with this configuration to check the execution model.',
      unsupported: 'Check model context and tool support with teapilot doctor --live.',
      context_limit: 'Reduce conversation or tool-result size; the estimated input plus reserved output exceeds the configured model context.',
      payload_limit: 'Reduce request size; the serialized payload exceeds the transport safety limit.',
      budget: 'Review spending and remaining request/day limits before retrying.',
      ineffective_calls: 'Inspect the current files, then retry with a narrower concrete change.',
      test_failures: 'Inspect the failing check output and retry with that failure as the task.',
      tool_failures: 'Inspect the tool error and correct its path or command before retrying.',
      cancelled: 'Review any existing edits before starting another request.',
      search_unavailable: `Check the search service connection and JSON output. ${searchRepair(config)}`,
    };
    return [`Incomplete: ${stop.replaceAll('_', ' ')}.`, fallback,
      selected?.startsWith('coder.') ? `Observed file edits: ${changedFiles.size ? [...changedFiles].join(', ') : 'none recorded'}.${shellRan ? ' Shell commands ran; additional changes may exist.' : ''}` : undefined,
      selected?.startsWith('coder.') ? `Checks after latest observed edit: ${attempt.check ?? 'not run'}.` : undefined,
      changedFiles.size || shellRan ? 'Existing edits remain; no automatic rollback was performed.' : undefined,
      `Next: ${actions[stop] ?? 'Review the partial work, then retry with a smaller task.'}`,
      attempt.text ? `Model response (task incomplete):\n${attempt.text}` : undefined].filter(Boolean).join('\n');
  };
  const finish = async (success: boolean, status: string, text: string): Promise<HostResult> => {
    dependencies.onActivity?.({ kind: 'waiting', label: 'Finalising request...' });
    const result = { requestId, success, status, text: telemetry.redact(text), capability: selected, spentUsd: budget.spent().request, receipts, attempts, check, models };
    await telemetry.event('request_end', { success, status, capability: selected, spentUsd: result.spentUsd, attempts });
    return result;
  };
  try {
    await budget.load();
    await mkdir(config.stateDir, { recursive: true });
    await telemetry.event('request_start', { correction: Boolean(request.correction), web: Boolean(request.web) });
    const router = config.routingMode === 'direct' ? undefined : new JevRouter(budgetedJev(config, budget, telemetry, dependencies.provider, request.signal), { ...defaultPolicy, ...config.policy.router, single_stage_max_candidates: 32, allow_unavailable_fallback: false });
    const localOnline = await (dependencies.localProbe ?? (() => localAvailable(config)))();
    let scope: { workload: Workload; tier: Tier } | undefined;
    let previous: AttemptResult | undefined;
    const basePrompt = conversation.current;
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
      dependencies.onActivity?.({ kind: 'waiting', label: router ? 'Routing with JevRouter...' : 'Selecting workload...' });
      const decision = router ? await router.route({
        request: basePrompt,
        context: {
          preference: 'Prefer local inference when suitable. Use economy cloud when local is unavailable or unsuitable. Difficulty alone is not evidence of failure. coder operates in the repository; ask has no filesystem or shell.',
          web_enabled: Boolean(request.web),
          history: conversation.history,
          ...(scope ? { escalation: { ...scope, evidence: previous?.reason } } : {}),
        },
        actor_permissions: config.policy.permissions,
      }, candidates) : undefined;
      if (request.signal?.aborted) return await finish(false, 'cancelled', 'Request cancelled.');
      if (decision) receipts.push(await telemetry.receipt(decision));

      const routedSelection = decision?.status !== 'no_decision' ? decision?.decision.selected ?? undefined : undefined;
      const fallbackWorkload = request.workload ?? scope?.workload;
      const fallbackSelection = fallbackWorkload
        ? candidates.find(candidate => candidate.id.startsWith(`${fallbackWorkload}.`) && assessCandidate(config, candidate).allowed)?.id
        : undefined;
      const usedRoutingFallback = Boolean(decision?.status === 'no_decision' && fallbackSelection);
      selected = routedSelection ?? (decision ? fallbackSelection : candidates.find(c => assessCandidate(config, c).allowed)?.id);

      if (decision?.status === 'no_decision' && !fallbackWorkload) {
        return await finish(false, 'workload_uncertain', `JevRouter could not confidently determine whether this request needs repository access (${decision.fallback.type ?? 'manual_review'}). Use teapilot ask or teapilot code to state the intended workload.`);
      }
      if (!selected) {
        return await finish(false, 'unavailable', decision
          ? `JevRouter returned no usable route (${decision.fallback.type ?? 'manual_review'}), and no host-approved fallback capability was available.`
          : 'No capability passed the direct selection policy. Run teapilot doctor.');
      }

      if (usedRoutingFallback) {
        dependencies.onProgress?.(`JevRouter returned no confident route (${decision!.fallback.type ?? 'manual_review'}); using host-approved fallback ${selected}.`);
        await telemetry.event('routing_fallback', { decisionId: decision!.decision_id, capability: selected, reason: decision!.fallback.type ?? 'manual_review' });
      }

      const candidate = candidates.find(c => c.id === selected);
      const assessment = !usedRoutingFallback ? decision?.decision.candidates.find(c => c.id === selected) : undefined;
      if (!candidate || !assessCandidate(config, candidate).allowed || (decision && !usedRoutingFallback && (!assessment || assessment.router.filtered || !assessment.router.allowed))) return await finish(false, 'blocked', 'Selected capability did not pass the execution boundary.');
      if (!decision) await telemetry.event('direct_selection', { capability: selected });
      if (request.signal?.aborted) return await finish(false, 'cancelled', 'Request cancelled.');
      if (assessCandidate(config, candidate).confirmation || (!usedRoutingFallback && (decision?.status === 'needs_confirmation' || assessment?.router.requires_confirmation))) {
        const approved = await dependencies.approve({ kind: 'route', summary: `Execute ${selected}?`, details: `Model: ${candidate.metadata?.model}\nMaximum inference charge per turn: $${Number(candidate.metadata?.max_call_usd).toFixed(6)}\nRequest ceiling: $${config.policy.budget.requestUsd}; already charged/reserved: $${budget.spent().request.toFixed(6)}\n${basePrompt}` });
        await telemetry.event('approval', { decisionId: decision?.decision_id, capability: selected, approved });
        if (request.signal?.aborted) return await finish(false, 'cancelled', 'Request cancelled.');
        if (!approved) return await finish(false, 'approval_denied', 'Route was not approved.');
      }
      const [workload, tier] = selected.split('.') as [Workload, Tier];
      dependencies.onProgress?.(`Executing ${selected} using ${config.models[tier].id}.`);
      attempts++;
      models.push(config.models[tier].id);
      dependencies.onEvent?.({ type: 'attempt_start', attempt: attempts, model: config.models[tier].id, tier });
      previous = await runAttempt({
        config, workload, tier, cwd, web: Boolean(request.web), chat: request.chat, budget, telemetry,
        unresolvedChecks: previous?.unresolvedChecks,
        history: conversation.history, onEvent: dependencies.onEvent, onActivity: dependencies.onActivity, beforeMutation: dependencies.beforeMutation,
        approve: async approval => {
          const approved = await dependencies.approve(approval);
          await telemetry.event('approval', { kind: approval.kind, approved });
          return approved;
        },
        signal: request.signal,
        prompt: basePrompt + (previous ? `\nPrevious attempt stopped: ${previous.reason}. Existing edits are still in the repository; inspect them before proceeding. Do not restart blindly.\nRecent execution context:\n${previous.handoff ?? previous.text.slice(-6000)}` : ''),
      });
      check = previous.check;
      for (const path of previous.changedFiles ?? []) changedFiles.add(path);
      shellRan ||= Boolean(previous.shellRan);
      await telemetry.event('attempt_end', { decisionId: decision?.decision_id, capability: selected, success: previous.success, reason: previous.reason, stopped: previous.stopped, turns: previous.turns, toolCalls: previous.toolCalls, check: previous.check });
      if (previous.success) return await finish(true, 'completed', previous.text);
      if (!previous.reason || ['budget', 'approval_denied', 'cancelled', 'timeout', 'tool_limit', 'search_unavailable'].includes(previous.stopped ?? '') || index === config.policy.escalation.maxEscalations) {
        return await finish(false, previous.stopped ?? previous.reason ?? 'incomplete', incomplete(previous, index === config.policy.escalation.maxEscalations ? 'Fallback: configured escalation limit reached.' : undefined));
      }
      const fallback = tiers.slice(tiers.indexOf(tier) + 1).map(nextTier => {
        const candidate = capabilities(config, budget, localOnline, { workload, tier: nextTier }).find(c => c.id === `${workload}.${nextTier}`)!;
        if (request.web && !config.models[nextTier].toolCalling) candidate.availability = { available: false, reason: 'Web search requires tool calling' };
        return { tier: nextTier, assessment: assessCandidate(config, candidate) };
      });
      const next = fallback.find(item => item.assessment.allowed)?.tier;
      if (!next) {
        const resumableSameTier = ['unsupported', 'turn_limit', 'ineffective_calls', 'tool_failures', 'test_failures'];
        const madeProgress = previous.turns > 0 || changedFiles.size > 0 || shellRan;
        if (!previous.reason || !resumableSameTier.includes(previous.reason) || !madeProgress) {
          return await finish(false, 'escalation_unavailable', incomplete(previous, `Fallback unavailable: ${fallback.map(item => `${item.tier}: ${item.assessment.reason}`).join('; ') || 'no higher tier configured'}.`));
        }
        dependencies.onProgress?.(`No higher-tier fallback is available; continuing ${selected} with its execution handoff.`);
        await telemetry.event('continuation', { capability: selected, reason: previous.reason, fallback: 'unavailable' });
        scope = { workload, tier };
        continue;
      }
      await telemetry.event('escalation', { from: selected, to: `${workload}.${next}`, reason: previous.reason });
      scope = { workload, tier: next };
    }
    return await finish(false, 'limit', 'Escalation limit reached.');
  } catch (error) {
    if (request.signal?.aborted) return await finish(false, 'cancelled', 'Request cancelled.');
    await telemetry.event('request_error', { name: error instanceof Error ? error.name : 'Error' });
    throw error;
  } finally { try { await unlock(); } finally { dependencies.onActivity?.(undefined); } }
}
