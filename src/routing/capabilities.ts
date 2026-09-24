import { validateManifest, type CapabilityManifest } from 'jevrouter';
import type { Config, PhysicalModel, Tier, Workload } from '../config.js';
import { callCeiling, type SpendGovernor } from '../inference/budget.js';
import { modelFor, nextTier, profileAvailable, profileFor, tierSupportsWorkload } from './execution.js';

export interface CapabilityOptions { physicalOnline?: Partial<Record<PhysicalModel, boolean>>; explicitTier?: Tier; relatedLock?: Tier }
export function capabilities(config: Config, budget: SpendGovernor, localOnline = true, scope?: { workload: Workload; tier: Tier }, options: CapabilityOptions = {}): CapabilityManifest[] {
  return (['coder', 'ask'] as const).flatMap(workload => (['fast', 'normal', 'reasoning', 'deep'] as const).map(tier => {
    const profile = profileFor(tier); const model = modelFor(config, tier); const id = `${workload}.${tier}`; const ceiling = callCeiling(model);
    let reason: string | undefined;
    const online = options.physicalOnline?.[profile.model] ?? localOnline;
    const profileState = profileAvailable(config, tier);
    if (!model.enabled || config.policy.disabledCapabilities.includes(id) || config.policy.disabledCapabilities.includes(`inference.${tier}`)) reason = 'Disabled by configuration';
    else if (!online) reason = `${profile.model} local endpoint unavailable`;
    else if (!profileState.available) reason = profileState.reason;
    else if (workload === 'coder' && !model.toolCalling) reason = 'Model does not support coding tools';
    else if (!tierSupportsWorkload(tier, workload, options.explicitTier === tier)) reason = 'Fast execution is reserved for standalone light work';
    else if (options.relatedLock && tier === 'fast' && options.relatedLock !== 'fast') reason = 'Related work remains on the capable model';
    else if (!budget.permits(ceiling + (config.routingMode === 'direct' ? 0 : config.router.maxCallUsd))) reason = 'Insufficient request or daily budget';
    else if (scope && (scope.workload !== workload || scope.tier !== tier)) reason = 'Outside escalation scope';
    return validateManifest({
      id, name: id, type: 'subagent',
      description: `${workload === 'coder' ? 'Edit, debug, inspect and test software in the working repository.' : 'Explain, answer questions, research with optional search, or plan everyday activities; no filesystem or shell unless access is activated.'} Local ${tier} execution using ${model.id}; native reasoning effort ${profile.thinking}.`,
      verification: { status: 'verified', source: 'teapilot:built-in' },
      permissions: workload === 'coder' ? ['inference', 'repository.read'] : ['inference'],
      risk: { level: workload === 'coder' ? 'medium' : 'low', categories: workload === 'coder' ? ['project_modification'] : [] },
      availability: { available: !reason, reason },
      policy: { requires_confirmation: ceiling >= config.policy.budget.approvalThresholdUsd },
      execution: { mode: 'subagent', target: workload },
      metadata: { provider: model.provider, model: model.id, model_key: profile.model, tier, effort: profile.thinking, local: true, cost_class: tier, context_tokens: profile.contextTokens, vision: model.vision, web: Boolean(config.searchUrl), workload, max_steps: config.policy.limits.maxTurns, max_call_usd: ceiling },
    });
  }));
}

export function fallbackTiers(tier: Tier): Tier[] { const next = nextTier(tier); return next ? [next, ...fallbackTiers(next)] : []; }
