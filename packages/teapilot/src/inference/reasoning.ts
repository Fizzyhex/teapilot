import type { ModelConfig, ReasoningLevel } from '../config.js';

/**
 * Request fields asking the model's server for a reasoning level, built from the
 * protocol the model declares. Models without a protocol, or without a value for
 * this level, get no reasoning field at all.
 */
export function reasoningFields(model: Pick<ModelConfig, 'reasoning'>, level: ReasoningLevel): Record<string, unknown> | undefined {
  const protocol = model.reasoning;
  switch (protocol?.type) {
    case undefined: return undefined;
    case 'reasoning_effort': return protocol.values[level] === undefined ? undefined : { reasoning_effort: protocol.values[level] };
    case 'chat_template_kwargs': return protocol.values[level] === undefined ? undefined : { chat_template_kwargs: protocol.values[level] };
  }
}
