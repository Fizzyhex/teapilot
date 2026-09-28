import type { ModelConfig, ReasoningLevel, Sampling } from '../config.js';

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

/** Decoding settings for a reasoning level: the level's own sampling, else the model's temperature. */
export function samplingFor(model: Pick<ModelConfig, 'sampling' | 'temperature'>, level: ReasoningLevel): Sampling {
  const sampling = model.sampling?.[level];
  return sampling ? { ...sampling, temperature: sampling.temperature ?? model.temperature } : model.temperature === undefined ? {} : { temperature: model.temperature };
}
