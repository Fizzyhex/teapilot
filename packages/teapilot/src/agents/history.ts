import type { AssistantMessage, Message, ToolResultMessage } from '@earendil-works/pi-ai';
import { emptyUsage } from '../integration/inference.js';
import type { ConversationTurn } from '../integration/events.js';
import { estimateValueTokens } from '../inference/context.js';

type Model = { provider: string; id: string };

/**
 * The part of a finished turn worth replaying: tool calls and their results, without reasoning or host
 * notices, and without a call whose result never came (a model server rejects that pairing).
 */
export function turnSteps(messages: Message[]): Message[] {
  const steps: Message[] = [];
  for (const message of messages) {
    if (message.role === 'assistant') {
      const content = message.content.filter(part => part.type !== 'thinking');
      if (content.length) steps.push({ ...message, content });
    } else if (message.role === 'toolResult') steps.push(message);
  }
  const answered = new Set(steps.flatMap(message => message.role === 'toolResult' ? [message.toolCallId] : []));
  const called = new Set<string>();
  return steps.flatMap((message): Message[] => {
    if (message.role === 'toolResult') return called.has(message.toolCallId) ? [message] : [];
    if (message.role !== 'assistant') return [message];
    const content = message.content.filter(part => part.type !== 'toolCall' || answered.has(part.id));
    for (const part of content) if (part.type === 'toolCall') called.add(part.id);
    return content.length ? [{ ...message, content }] : [];
  });
}

/** Cut to `limit`, never through the middle of an emoji. */
const clip = (text: string, limit: number) => text.length > limit ? `${text.slice(0, /[\uD800-\uDBFF]/.test(text[limit - 1] ?? '') ? limit - 1 : limit)}…[clipped]` : text;
const clipValue = (value: unknown): unknown => typeof value === 'string' ? clip(value, 300)
  : Array.isArray(value) ? value.map(clipValue)
  : value && typeof value === 'object' ? Object.fromEntries(Object.entries(value).map(([key, item]) => [key, clipValue(item)])) : value;
/** Later turns carry the current version; an earlier one's code only costs context. */
const withoutCode = (text: string) => text.replace(/```[^\n`]*\n([\s\S]*?)```/g, (block, body: string) =>
  body.length > 300 ? `[${body.trimEnd().split('\n').length}-line code block from an earlier turn omitted]` : block);

/** An earlier turn's steps with long code, arguments and results cut down; the calls and their outcome remain. */
function compact(steps: Message[]): Message[] {
  return steps.map(message => message.role === 'assistant'
    ? { ...message, content: message.content.map(part => part.type === 'text' ? { ...part, text: withoutCode(part.text) }
      : part.type === 'toolCall' ? { ...part, arguments: clipValue(part.arguments) as typeof part.arguments } : part) }
    : message.role === 'toolResult'
      ? { ...message, content: message.content.map(part => part.type === 'text' ? { ...part, text: clip(part.text, 400) } : part) } as ToolResultMessage
      : message);
}

/**
 * Replays earlier turns within `budget` tokens. The newest turn keeps its steps in full; older ones keep
 * them compacted. When that is too much, the oldest turns fall back to their text, then drop out, and the
 * newest is cut down last.
 */
export function fitHistory(turns: ConversationTurn[], budget: number, model: Model): Message[] {
  const forms = turns.map(turn => {
    const user: Message = { role: 'user', content: turn.user, timestamp: 0 };
    const assistant: AssistantMessage = { role: 'assistant', content: [{ type: 'text', text: turn.assistant }], api: 'openai-completions', provider: model.provider, model: model.id, timestamp: 0, usage: emptyUsage(), stopReason: 'stop' };
    const steps = turn.steps ?? [];
    return [[user, ...steps, assistant], [user, ...compact(steps), assistant], [user, assistant]].map(messages => ({ messages, tokens: estimateValueTokens(messages) + messages.length * 32 }));
  });
  const levels: number[] = forms.map((_, index) => index === forms.length - 1 ? 0 : 1);
  let first = 0;
  const total = () => forms.slice(first).reduce((sum, form, index) => sum + form[levels[first + index]!]!.tokens, 0);
  for (let index = 0; index < forms.length - 1 && total() > budget; index++) levels[index] = 2;
  while (first < forms.length - 1 && total() > budget) first++;
  while (first < forms.length && total() > budget) {
    const newest = forms.length - 1;
    if (levels[newest]! < 2) levels[newest] = levels[newest]! + 1; else first++;
  }
  return forms.slice(first).flatMap((form, index) => form[levels[first + index]!]!.messages);
}
