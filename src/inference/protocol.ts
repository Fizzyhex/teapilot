import type { ModelConfig, ReasoningLevel } from '../config.js';

type Payload = Record<string, unknown>;

function mergeTemplateVars(payload: Payload, templateVars: Record<string, string | number | boolean>): Payload {
  const existing = payload.chat_template_kwargs;
  const current = existing && typeof existing === 'object' && !Array.isArray(existing)
    ? existing as Record<string, unknown> : {};
  return { ...payload, chat_template_kwargs: { ...current, ...templateVars } };
}

/**
 * Apply model-declared request protocol controls. Runtime identity is
 * intentionally absent: once setup has produced a ModelConfig, inference only
 * depends on its API contract.
 */
export function applyModelProtocol(payload: Payload, model: ModelConfig, level: ReasoningLevel): Payload | undefined {
  const protocol = model.reasoning;
  if (!protocol) return undefined;
  const value = protocol.values[level];
  if (value === undefined) return undefined;
  if (typeof value === 'string') return { ...payload, reasoning_effort: value };
  let transformed = { ...payload };
  if (value.reasoningEffort) transformed.reasoning_effort = value.reasoningEffort;
  if (value.templateVars) transformed = mergeTemplateVars(transformed, value.templateVars);
  return transformed;
}
