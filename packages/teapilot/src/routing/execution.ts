import type { Config, ModelConfig, PhysicalModel, ReasoningLevel, Tier, Workload } from '../config.js';

export type ThinkingLevel = ReasoningLevel;
/** How each level is requested on the wire belongs to the model's reasoning protocol. */
export interface ExecutionProfile {
  tier: Tier; model: PhysicalModel; contextTokens: number; maxOutputTokens: number; thinking: ThinkingLevel;
}
export const executionProfiles: Record<Tier, ExecutionProfile> = {
  fast: { tier: 'fast', model: 'fast', contextTokens: 8192, maxOutputTokens: 2048, thinking: 'off' },
  normal: { tier: 'normal', model: 'capable', contextTokens: 16384, maxOutputTokens: 4096, thinking: 'off' },
  reasoning: { tier: 'reasoning', model: 'capable', contextTokens: 24576, maxOutputTokens: 8192, thinking: 'medium' },
  deep: { tier: 'deep', model: 'capable', contextTokens: 32768, maxOutputTokens: 16384, thinking: 'xhigh' },
};
/** The tier that runs a reasoning level on the capable model. */
export const reasoningTier: Record<ThinkingLevel, Tier> = { off: 'normal', medium: 'reasoning', xhigh: 'deep' };
export const escalationOrder: Tier[] = ['fast', 'normal', 'reasoning', 'deep'];
export function profileFor(tier: Tier): ExecutionProfile { return executionProfiles[tier]; }
export function effectiveProfile(config: Config, tier: Tier): ExecutionProfile {
  const profile = profileFor(tier); const model = modelFor(config, tier);
  // With no higher tier able to run on this model (e.g. local models without native
  // reasoning), this tier is the ceiling: use the model's configured limits in full.
  const ceiling = !escalationOrder.slice(escalationOrder.indexOf(tier) + 1)
    .some(next => profileFor(next).model === profile.model && profileAvailable(config, next).available);
  if (ceiling) return { ...profile, contextTokens: model.contextTokens, maxOutputTokens: model.maxOutputTokens };
  return { ...profile, contextTokens: Math.min(profile.contextTokens, model.contextTokens), maxOutputTokens: Math.min(profile.maxOutputTokens, model.maxOutputTokens) };
}
export function modelFor(config: Config, tier: Tier): ModelConfig { return config.models[profileFor(tier).model]; }
export function profileAvailable(config: Config, tier: Tier): { available: boolean; reason?: string } {
  const profile = profileFor(tier); const model = modelFor(config, tier);
  if (!model.enabled) return { available: false, reason: 'Physical model is disabled' };
  if (model.contextTokens < 4096) return { available: false, reason: 'Model context is too small' };
  if (!model.reasoningEfforts.includes(profile.thinking)) return { available: false, reason: `Native ${profile.thinking} reasoning is not verified` };
  return { available: true };
}
export function tierSupportsWorkload(tier: Tier, workload: Workload, explicit = false): boolean {
  if (tier !== 'fast') return true;
  // Fast is allowed for a genuinely tiny isolated coding request only when the
  // caller explicitly selects it. Automatic agentic/repository work stays capable.
  return workload === 'ask' || explicit;
}
export function nextTier(tier: Tier): Tier | undefined { return escalationOrder[escalationOrder.indexOf(tier) + 1]; }
const deepSignals = /\b(architecture|repository[- ]wide|root cause across|long[- ]horizon|complex debugging|migration strategy)\b/i;
const reasoningSignals = /\b(debug|diagnos|plan|ambigu|trade[- ]?off|investigat|coordinate|several dependent|substantial context)\b/i;
const fastSignals = /^(?:\s*)(?:define|classify|translate|rewrite|summarize|convert|what is|who is|when is|list\b|explain briefly|fix (?:this )?(?:typo|spelling))\b/i;

/** Conservative local selection shared by the CLI host and service inference. */
export function directTier(workload: Workload, explicit?: Tier, request = '', relatedLock?: Tier, hasTools = false): Tier {
  if (explicit) return explicit;
  if (relatedLock && relatedLock !== 'fast') {
    if (deepSignals.test(request)) return 'deep';
    if (reasoningSignals.test(request)) return 'reasoning';
    return 'normal';
  }
  if (deepSignals.test(request)) return 'deep';
  if (reasoningSignals.test(request)) return 'reasoning';
  if (workload === 'ask' && !hasTools && request.length <= 500 && fastSignals.test(request)) return 'fast';
  return 'normal';
}
