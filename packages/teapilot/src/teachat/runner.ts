import { Agent, type AgentTool } from '@earendil-works/pi-agent-core';
import type { Config, Tier } from '../config.js';
import type { SpendGovernor } from '../inference/budget.js';
import { guardedStream, piModel, type InferenceState } from '../inference/providers.js';
import { effectiveProfile, modelFor, profileAvailable, profileFor } from '../routing/execution.js';
import type { Telemetry } from '../telemetry/outcome.js';

/** The first tier that can run here, in order of preference. */
export function gossipTier(config: Config, preferred: Tier[]): Tier | undefined {
  return preferred.find(tier => profileAvailable(config, tier).available);
}

const system = [
  '- You are a teapilot agent on a break, chatting with the other teapilot agents in teachat.',
  '- Casual, lowercase, brief. Talk like a colleague, not an assistant.',
  '- Never include secrets, credentials, code, file contents, paths, or personal details about the user or anyone else.',
].join('\n');

/** One agent run on spare compute, metered like any other call. Returns the final text. */
export async function gossipCall(config: Config, tier: Tier, budget: SpendGovernor, telemetry: Telemetry, prompt: string, options: { tools?: AgentTool[]; maxTurns?: number; signal?: AbortSignal }): Promise<string> {
  const scoped = structuredClone(config);
  scoped.policy.limits.maxTurns = Math.min(options.maxTurns ?? 1, config.policy.limits.maxTurns);
  const state: InferenceState = { turns: 0 };
  const agent = new Agent({
    initialState: { model: piModel(modelFor(scoped, tier), effectiveProfile(scoped, tier)), systemPrompt: system, tools: options.tools ?? [], thinkingLevel: profileFor(tier).thinking },
    streamFn: guardedStream(scoped, tier, budget, telemetry, state), toolExecution: 'sequential',
  });
  const abort = () => agent.abort();
  const timer = setTimeout(abort, config.policy.limits.attemptTimeoutMs);
  options.signal?.addEventListener('abort', abort, { once: true });
  try {
    options.signal?.throwIfAborted();
    await agent.prompt(profileFor(tier).thinking === 'off' ? `${prompt}\n/no_think` : prompt);
  } finally { clearTimeout(timer); options.signal?.removeEventListener('abort', abort); }
  options.signal?.throwIfAborted();
  const last = agent.state.messages.findLast(message => message.role === 'assistant');
  if (last?.role !== 'assistant' || (last.stopReason !== 'stop' && !(options.tools?.length && state.stop === 'turn_limit'))) {
    throw new Error(`Gossip inference stopped (${state.stop ?? (last?.role === 'assistant' ? last.stopReason : 'no response')}).`);
  }
  return telemetry.redact(last.content.filter(part => part.type === 'text').map(part => part.text).join('').replace(/<think>[\s\S]*?<\/think>/g, '').trim());
}
