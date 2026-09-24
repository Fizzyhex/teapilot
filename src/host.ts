import type { ActivitySink } from './activity.js';
import { randomUUID } from 'node:crypto';
import { mkdir, realpath, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { defaultPolicy, JevRouter } from 'jevrouter';
import { runAttempt, type AttemptResult } from './agents/run.js';
import { tiers, type Config, type Tier, type TierPreference, type Workload } from './config.js';
import { ExecutionPolicy, type Approve, type BeforeMutation } from './execution/policy.js';
import { prepareConversation, type ConversationTurn, type TextContext, type EventSink } from './integration/events.js';
import { lockState, SpendGovernor } from './inference/budget.js';
import { budgetedJev, localAvailable, type CancellableJevProvider } from './inference/providers.js';
import { capabilities } from './routing/capabilities.js';
import { Telemetry } from './telemetry/outcome.js';
import { assessCandidate } from './routing/selection.js';
import { checkSearch, searchRepair } from './search.js';
import { withPrerequisites, type Mode, type SessionGrants, type Permission } from './execution/grants.js';
import { capabilityPlanner, readRoutingPlan } from './routing/intent.js';
import { directTier, modelFor, profileFor } from './routing/execution.js';

export interface HostRequest { prompt: string; cwd: string; workload?: Workload; web?: boolean; correction?: string; signal?: AbortSignal; history?: ConversationTurn[]; context?: TextContext[]; mode?: Mode; conversational?: boolean; authorization?: SessionGrants; tier?: TierPreference; relatedTier?: Tier; sessionId?: string; taskId?: string }
export interface HostResult {
  requestId: string; success: boolean; status: string; text: string;
  capability?: string; spentUsd: number; receipts: string[]; attempts: number;
  check?: 'passed' | 'failed'; models?: string[];
  tier?: Tier;
}
export interface HostDependencies {
  approve: Approve;
  onActivity?: ActivitySink;
  provider?: CancellableJevProvider;
  localProbe?: () => Promise<boolean>;
  onProgress?: (message: string) => void;
  onEvent?: EventSink; beforeMutation?: BeforeMutation;
  continueWithoutSearch?: (message: string) => Promise<boolean>;
}

export async function runHost(config: Config, request: HostRequest, dependencies: HostDependencies): Promise<HostResult> {
  if (config.routingMode === 'direct' && !request.workload && !request.authorization) throw new Error('Direct routing requires teapilot ask or teapilot code.');
  const prompt = request.prompt.trim();
  if (!prompt || prompt.length + (request.correction?.length ?? 0) > config.policy.limits.maxPromptChars) throw new Error(`Prompt must contain 1–${config.policy.limits.maxPromptChars} characters`);
  dependencies.onActivity?.({ kind: 'waiting', label: 'Checking request availability...' });
  const cwd = await realpath(request.cwd);
  if (request.authorization && request.authorization.root !== cwd) throw new Error('Session grants belong to a different repository.');
  if (!(await stat(cwd)).isDirectory()) throw new Error('Working directory is not a directory');
  const contextPolicy = new ExecutionPolicy(cwd, config, dependencies.approve);
  for (const context of request.context ?? []) if (context.path) await contextPolicy.path(context.path, false);
  const currentPrompt = prompt + (request.correction ? `\nUser correction:\n${request.correction}` : '');
  // Leave room for system instructions and tool schemas while retaining whole,
  // recent turns. The inference boundary remains the final exact admission check.
  const currentLength = currentPrompt.length + (request.context?.length ? JSON.stringify(request.context).length + 64 : 0);
  const historyLimit = Math.max(currentLength, Math.min(config.policy.limits.maxPromptChars, 8_000));
  const conversation = prepareConversation(currentPrompt, request.context ?? [], request.history ?? [], historyLimit);
  if (conversation.omitted) dependencies.onEvent?.({ type: 'history_omitted', turns: conversation.omitted });
  if (request.web && !request.authorization) {
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
  const activePermissions: Permission[] = ['inference'];
  let searchDisabled = false;
  let searchUnverified = false;
  let accessFailure: string | undefined;
  const activate = async (required: Permission[], reason: string, signal = request.signal): Promise<boolean> => {
    if (!request.authorization) return true;
    if (accessFailure) return false;
    if (required.some(permission => !config.policy.permissions.includes(permission))) {
      accessFailure = `Required access is disabled by configuration: ${required.filter(permission => !config.policy.permissions.includes(permission)).join(', ')}.`;
      return false;
    }
    if (!await request.authorization.request(required, reason, dependencies.approve, signal,
      (type, fields) => telemetry.event(type, fields))) {
      accessFailure = `Required session access was not approved: ${required.join(', ')}. Grant access interactively to continue.`;
      return false;
    }
    if (required.includes('web.search') && !activePermissions.includes('web.search') && !searchDisabled) {
      try { await checkSearch(config, signal); }
      catch (error) {
        signal?.throwIfAborted();
        if (!await dependencies.continueWithoutSearch?.(error instanceof Error ? error.message : 'Web search is unavailable.')) {
          accessFailure = 'Web search is unavailable. Repair search before retrying.';
          return false;
        }
        searchDisabled = true; searchUnverified = true;
      }
    }
    for (const permission of withPrerequisites(required)) if (!activePermissions.includes(permission) && !(permission === 'web.search' && searchDisabled)) activePermissions.push(permission);
    return true;
  };
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
    const result = { requestId, success, status, text: telemetry.redact((searchUnverified ? 'Web search was unavailable. This answer is unverified against current sources.\n\n' : '') + text), capability: selected, tier: selected?.split('.')[1] as Tier | undefined, spentUsd: budget.spent().request, receipts, attempts, check, models };
    await telemetry.event('request_end', { success, status, capability: selected, spentUsd: result.spentUsd, attempts });
    return result;
  };
  try {
    await budget.load();
    await mkdir(config.stateDir, { recursive: true });
    await telemetry.event('request_start', { correction: Boolean(request.correction), web: Boolean(request.web) });
    if (request.authorization && !request.authorization.allows('inference')) return await finish(false, 'blocked', 'Inference access is not granted. Start a new session to restore it.');
    if (request.authorization && request.web && !await activate(['web.search'], 'You requested web research with --web.')) return await finish(false, 'approval_denied', accessFailure!);
    const provider = config.routingMode === 'direct' ? undefined : budgetedJev(config, budget, telemetry, dependencies.provider, request.signal);
    const router = provider ? new JevRouter(request.authorization ? capabilityPlanner(provider) : provider, { ...defaultPolicy, ...config.policy.router, single_stage_max_candidates: 32, allow_unavailable_fallback: false }) : undefined;
    const physicalOnline = dependencies.localProbe
      ? { fast: await dependencies.localProbe(), capable: await dependencies.localProbe() }
      : { fast: await localAvailable(config, 'fast'), capable: await localAvailable(config, 'capable') };
    const localOnline = physicalOnline.fast || physicalOnline.capable;
    let scope: { workload: Workload; tier: Tier } | undefined;
    let previous: AttemptResult | undefined;
    const basePrompt = conversation.current;
    for (let index = 0; index <= config.policy.escalation.maxEscalations; index++) {
      if (request.signal?.aborted) return await finish(false, 'cancelled', 'Request cancelled.');
      const candidates = capabilities(config, budget, localOnline, scope, { physicalOnline, explicitTier: request.tier && request.tier !== 'auto' ? request.tier : undefined, relatedLock: request.relatedTier });
      if (request.tier && request.tier !== 'auto') for (const candidate of candidates) if (!candidate.id.endsWith(`.${request.tier}`)) candidate.availability = { available: false, reason: 'Outside explicit tier preference' };
      if (request.workload) for (const candidate of candidates) {
        if (!candidate.id.startsWith(`${request.workload}.`)) candidate.availability = { available: false, reason: 'Outside requested workload' };
      }
      if (!router && request.authorization && !scope) for (const candidate of candidates) {
        if (!candidate.id.startsWith('ask.')) candidate.availability = { available: false, reason: 'Start with dialogue; activate repository tools only when needed' };
      }
      if (request.web) for (const candidate of candidates) {
        const tier = candidate.id.split('.')[1] as Tier;
        if (!modelFor(config, tier).toolCalling) candidate.availability = { available: false, reason: 'Web search requires tool calling' };
      }
      if (!candidates.some(c => c.availability?.available)) return await finish(false, 'unavailable', previous?.text || 'No capability fits the configured availability and budget. Run teapilot doctor.');
      dependencies.onProgress?.(scope ? `Routing escalation to ${scope.workload}.${scope.tier} (${previous?.reason}).` : router ? 'Routing with JevRouter.' : 'Selecting the requested workload directly.');
      dependencies.onActivity?.({ kind: 'waiting', label: router ? 'Routing with JevRouter...' : 'Selecting workload...' });
      const decision = router ? await router.route({
        request: basePrompt,
        context: {
          preference: 'Use the lowest suitable local execution profile. Default repository and agentic work to normal; use fast only for genuinely tiny standalone work. Scale capable work through normal, reasoning, deep when evidence warrants it. Choose coder only when the user request needs repository access; ordinary questions use ask.',
          mode: request.mode,
          granted_access: request.authorization?.list(),
          web_enabled: Boolean(request.web),
          history: conversation.history,
          ...(scope ? { escalation: { ...scope, evidence: previous?.reason } } : {}),
        },
        actor_permissions: config.policy.permissions,
      }, candidates) : undefined;
      if (request.signal?.aborted) return await finish(false, 'cancelled', 'Request cancelled.');
      if (decision) receipts.push(await telemetry.receipt(decision));

      const routedSelection = decision?.status !== 'no_decision' ? decision?.decision.selected ?? undefined : undefined;
      // Without a stated workload, an unconfident route continues as least-privileged
      // dialogue; the agent can still request access mid-run if it proves necessary.
      const fallbackWorkload = request.workload ?? scope?.workload ?? (decision?.status === 'no_decision' ? 'ask' : undefined);
      const fallbackSelection = fallbackWorkload
        ? candidates.find(candidate => candidate.id.startsWith(`${fallbackWorkload}.`) && assessCandidate(config, candidate).allowed)?.id
        : undefined;
      const usedRoutingFallback = Boolean(decision?.status === 'no_decision' && fallbackSelection);
      const directSelectionTier = scope?.tier ?? directTier(fallbackWorkload ?? 'ask', request.tier && request.tier !== 'auto' ? request.tier : undefined, basePrompt, request.relatedTier, Boolean(request.web));
      selected = routedSelection ?? (decision ? fallbackSelection : candidates.find(c => c.id === `${fallbackWorkload ?? 'ask'}.${directSelectionTier}` && assessCandidate(config, c).allowed)?.id);

      if (!selected) {
        return await finish(false, 'unavailable', decision
          ? `JevRouter returned no usable route (${decision.fallback.type ?? 'manual_review'}), and no host-approved fallback capability was available.`
          : 'No capability passed the direct selection policy. Run teapilot doctor.');
      }

      if (usedRoutingFallback) {
        dependencies.onProgress?.(`JevRouter returned no confident route (${decision!.fallback.type ?? 'manual_review'}); using host-approved fallback ${selected}.`);
        await telemetry.event('routing_fallback', { decisionId: decision!.decision_id, capability: selected, reason: decision!.fallback.type ?? 'manual_review' });
      }

      let candidate = candidates.find(c => c.id === selected);
      let assessment = !usedRoutingFallback ? decision?.decision.candidates.find(c => c.id === selected) : undefined;
      if (!candidate || !assessCandidate(config, candidate).allowed || (decision && !usedRoutingFallback && (!assessment || assessment.router.filtered || !assessment.router.allowed))) return await finish(false, 'blocked', 'Selected capability did not pass the execution boundary.');
      const selectedWorkload = selected!.split('.')[0]!;
      // Only a confident access plan earns an upfront grant prompt. An unconfident one
      // continues with current access; the agent requests more mid-run if needed.
      const plan = request.authorization && decision && !usedRoutingFallback ? readRoutingPlan(decision.raw_jev, config.policy.router.min_confidence, selectedWorkload) : undefined;
      if (plan) {
        if ((!request.tier || request.tier === 'auto') && plan.tier && plan.tier !== 'auto') {
          const preferred = candidates.find(candidate => candidate.id === `${selectedWorkload}.${plan.tier}`);
          const preferredAssessment = preferred && decision?.decision.candidates.find(c => c.id === preferred.id);
          if (preferred && preferredAssessment && assessCandidate(config, preferred).allowed && preferredAssessment.router.allowed && !preferredAssessment.router.filtered) { selected = preferred.id; candidate = preferred; assessment = preferredAssessment; }
        }
        if (!await activate(plan.permissions, `Access needed for your request: ${prompt}`)) return await finish(false, 'approval_denied', accessFailure!);
      }
      if (!decision) await telemetry.event('direct_selection', { capability: selected });
      if (request.signal?.aborted) return await finish(false, 'cancelled', 'Request cancelled.');
      if (assessCandidate(config, candidate).confirmation || (!usedRoutingFallback && (decision?.status === 'needs_confirmation' || assessment?.router.requires_confirmation))) {
        const approved = await dependencies.approve({ kind: 'route', summary: `Execute ${selected}?`, details: `Model: ${candidate.metadata?.model}\nMaximum inference charge per turn: $${Number(candidate.metadata?.max_call_usd).toFixed(6)}\nRequest ceiling: $${config.policy.budget.requestUsd}; already charged/reserved: $${budget.spent().request.toFixed(6)}\n${basePrompt}` });
        await telemetry.event('approval', { decisionId: decision?.decision_id, capability: selected, approved });
        if (request.signal?.aborted) return await finish(false, 'cancelled', 'Request cancelled.');
        if (!approved) return await finish(false, 'approval_denied', 'Route was not approved.');
      }
      const [workload, tier] = selected.split('.') as [Workload, Tier];
      dependencies.onProgress?.(`Executing ${selected} using ${modelFor(config, tier).id} (${profileFor(tier).thinking}).`);
      attempts++;
      models.push(modelFor(config, tier).id);
      dependencies.onEvent?.({ type: 'attempt_start', attempt: attempts, model: modelFor(config, tier).id, tier });
      previous = await runAttempt({
        config, workload, tier, cwd, web: request.authorization ? activePermissions.includes('web.search') : Boolean(request.web), budget, telemetry,
        mode: request.mode, conversational: request.conversational, authorization: request.authorization,
        activePermissions: request.authorization ? activePermissions : undefined,
        requestCapabilities: request.authorization ? async (required, reason, signal) => {
          if (required.some(permission => permission.startsWith('repository.'))) {
            const repository = capabilities(config, budget, localOnline, { workload: 'coder', tier }, { physicalOnline, explicitTier: tier }).find(value => value.id === `coder.${tier}`)!;
            const admission = assessCandidate(config, repository);
            if (!admission.allowed) { accessFailure = admission.reason ?? 'Repository capability unavailable'; return false; }
            if (admission.confirmation && workload !== 'coder' && !activePermissions.includes('repository.read')) {
              if (!await dependencies.approve({ kind: 'route', summary: `Use repository tools with ${modelFor(config, tier).id}?`, details: reason, signal })) return false;
            }
          }
          return activate(required, reason, signal);
        } : undefined,
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
      if (accessFailure) return await finish(false, 'approval_denied', incomplete(previous, accessFailure));
      await telemetry.event('attempt_end', { decisionId: decision?.decision_id, capability: selected, success: previous.success, reason: previous.reason, stopped: previous.stopped, turns: previous.turns, toolCalls: previous.toolCalls, check: previous.check });
      if (previous.success) return await finish(true, 'completed', previous.text);
      if (!previous.reason || ['budget', 'approval_denied', 'cancelled', 'timeout', 'tool_limit', 'search_unavailable'].includes(previous.stopped ?? '') || index === config.policy.escalation.maxEscalations) {
        return await finish(false, previous.stopped ?? previous.reason ?? 'incomplete', incomplete(previous, index === config.policy.escalation.maxEscalations ? 'Fallback: configured escalation limit reached.' : undefined));
      }
      const fallback = tiers.slice(tiers.indexOf(tier) + 1).map(nextTier => {
        const candidate = capabilities(config, budget, localOnline, { workload, tier: nextTier }, { physicalOnline, relatedLock: request.relatedTier }).find(c => c.id === `${workload}.${nextTier}`)!;
        if (request.web && !modelFor(config, nextTier).toolCalling) candidate.availability = { available: false, reason: 'Web search requires tool calling' };
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
