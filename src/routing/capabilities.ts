import { validateManifest, type CapabilityManifest } from 'jevrouter';
import { tiers, type Config, type Tier, type Workload } from '../config.js';
import { callCeiling, type SpendGovernor } from '../inference/budget.js';

export function capabilities(config: Config, budget: SpendGovernor, localOnline: boolean, scope?: { workload: Workload; tier: Tier }): CapabilityManifest[] {
  return (['coder', 'ask'] as const).flatMap(workload => tiers.map(tier => {
    const model = config.models[tier];
    const id = `${workload}.${tier}`;
    const ceiling = callCeiling(model);
    let reason: string | undefined;
    if (!model.enabled || config.policy.disabledCapabilities.includes(id)) reason = 'Disabled by configuration';
    else if (tier === 'local' && !localOnline) reason = 'Local endpoint unavailable';
    else if (tier !== 'local' && !config.secrets[tier]) reason = 'Missing inference credential';
    else if (workload === 'coder' && !model.toolCalling) reason = 'Model does not support coding tools';
    else if (!budget.permits(ceiling + config.router.maxCallUsd)) reason = 'Insufficient request or daily budget';
    else if (scope && (scope.workload !== workload || scope.tier !== tier)) reason = 'Outside escalation scope';
    else if (!scope && tier === 'strong' && config.policy.budget.automaticEconomy) reason = 'Strong model reserved for evidence-based escalation';
    return validateManifest({
      id, name: id, type: 'subagent',
      description: `${workload === 'coder' ? 'Edit, debug, inspect and test software in the working repository.' : 'Explain, answer questions, research with optional search, or plan everyday activities; no filesystem or shell.'} ${tier === 'local' ? 'Prefer this local inference option when suitable.' : `${tier} cloud inference.`} Vision metadata: ${model.vision}; this host accepts text only. Web search is opt-in.`,
      verification: { status: 'verified', source: 'teapilot:built-in' },
      permissions: workload === 'coder' ? ['inference', 'repository.read'] : ['inference'],
      risk: { level: workload === 'coder' ? 'medium' : 'low', categories: workload === 'coder' ? ['project_modification'] : [] },
      availability: { available: !reason, reason },
      policy: { requires_confirmation: tier !== 'local' && (ceiling >= config.policy.budget.approvalThresholdUsd || (tier === 'strong' && config.policy.budget.strongRequiresApproval)) },
      execution: { mode: 'subagent', target: workload },
      metadata: { provider: model.provider, model: model.id, local: tier === 'local', cost_class: tier, context_tokens: model.contextTokens, vision: model.vision, web: Boolean(config.searchUrl), workload, max_steps: config.policy.limits.maxTurns, max_call_usd: ceiling },
    });
  }));
}
