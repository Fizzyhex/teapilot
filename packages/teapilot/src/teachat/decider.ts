import { getChoiceAnswer, type StateValue } from 'jevrouter';
import type { Decider, Decision, Question } from 'teachat';
import type { Config } from '../config.js';
import type { SpendGovernor } from '../inference/budget.js';
import { budgetedJev, type CancellableJevProvider } from '../inference/providers.js';
import type { Telemetry } from '../telemetry/outcome.js';

/** Jev for teachat: one choice question per call, charged to the gossip round's own budget. Undefined without hosted routing. */
export function jevDecider(config: Config, governor: SpendGovernor, telemetry: Telemetry, provider?: CancellableJevProvider): Decider | undefined {
  if (config.routingMode === 'direct' || (!provider && !config.router.apiKey)) return undefined;
  return {
    async choose<K extends string>(question: Question<K>, signal?: AbortSignal): Promise<Decision<K>> {
      const raw = await budgetedJev(config, governor, telemetry, provider, signal).decide({
        state: question.state as StateValue, candidates: [],
        questions: { choice: { type: 'choice', instructions: question.instructions, criteria: question.options } },
      });
      const answer = getChoiceAnswer(raw, 'choice');
      return { choice: answer.choice as K, probabilities: answer.probabilities as Partial<Record<K, number>>, confidence: answer.confidence };
    },
  };
}
