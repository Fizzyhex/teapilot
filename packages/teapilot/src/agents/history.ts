import type { AssistantMessage, Message, ToolResultMessage } from '@earendil-works/pi-ai';
import { emptyUsage } from '../integration/inference.js';
import type { ConversationTurn } from '../integration/events.js';
import { estimateValueTokens } from '../inference/context.js';
import { savedLine } from '../workspace/scratch.js';

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
/** A result cut down still says where its full output was saved, so the detail it lost can be found again. */
const clipResult = (text: string) => {
  const clipped = clip(text, 400);
  const saved = clipped === text ? null : text.match(savedLine);
  return saved ? [clipped, ...saved].join('\n') : clipped;
};
/** Later turns carry the current version; an earlier one's code only costs context. */
const withoutCode = (text: string) => text.replace(/```[^\n`]*\n([\s\S]*?)```/g, (block, body: string) =>
  body.length > 300 ? `[${body.trimEnd().split('\n').length}-line code block from an earlier turn omitted]` : block);

/** An earlier turn's steps with long code, arguments and results cut down; the calls and their outcome remain. */
function compact(steps: Message[]): Message[] {
  return steps.map(message => message.role === 'assistant'
    ? { ...message, content: message.content.map(part => part.type === 'text' ? { ...part, text: withoutCode(part.text) }
      : part.type === 'toolCall' ? { ...part, arguments: clipValue(part.arguments) as typeof part.arguments } : part) }
    : message.role === 'toolResult'
      ? { ...message, content: message.content.map(part => part.type === 'text' ? { ...part, text: clipResult(part.text) } : part) } as ToolResultMessage
      : message);
}

const playCalls = new Set(['play_start', 'play_update', 'play_test']);
/**
 * An attempt's messages with app calls a later one superseded cut down: a call that changed nothing keeps only
 * its outcome, since its code or edits were never applied. Under `pressure`, earlier calls that did apply lose
 * their long arguments and code blocks too; the running app's source stays one play_inspect away. The newest
 * call is never touched. Returns the same array when nothing changes.
 */
export function supersedePlayCalls(messages: Message[], pressure: boolean): Message[] {
  const newest = messages.findLastIndex(message => message.role === 'assistant' && message.content.some(part => part.type === 'toolCall' && playCalls.has(part.name)));
  if (newest < 0) return messages;
  const unapplied = new Set(messages.flatMap(message => message.role === 'toolResult' && playCalls.has(message.toolName)
    && (message.isError || message.content.some(part => part.type === 'text' && /Nothing was (changed|started)|^No app code found/.test(part.text))) ? [message.toolCallId] : []));
  let changed = false;
  const result = messages.map((message, index) => {
    if (index >= newest || message.role !== 'assistant') return message;
    const content = message.content.map(part => {
      if (part.type === 'toolCall' && playCalls.has(part.name) && (pressure || unapplied.has(part.id))) {
        const args = clipValue(part.arguments) as typeof part.arguments;
        if (JSON.stringify(args) === JSON.stringify(part.arguments)) return part;
        changed = true;
        return { ...part, arguments: args };
      }
      if (part.type === 'text' && pressure) {
        const text = withoutCode(part.text);
        if (text === part.text) return part;
        changed = true;
        return { ...part, text };
      }
      return part;
    });
    return content.every((part, at) => part === message.content[at]) ? message : { ...message, content };
  });
  return changed ? result as Message[] : messages;
}

/**
 * Replays earlier turns within `budget` tokens. The newest turn keeps its steps in full (compacted too with
 * `compactAll`); older ones keep them compacted. When that is too much, the oldest turns fall back to their
 * text, then drop out, and the newest is cut down last. Turns that drop out are counted where the rest begin,
 * so the model knows its memory of the conversation has a gap.
 */
export interface HistoryFit { turns: number; kept: number; compacted: number; textOnly: number; budget: number; fullTokens: number; tokens: number }
export function fitHistory(turns: ConversationTurn[], budget: number, model: Model, report?: (fit: HistoryFit) => void, compactAll = false): Message[] {
  const forms = turns.map(turn => {
    const user: Message = { role: 'user', content: turn.user, timestamp: 0 };
    const assistant: AssistantMessage = { role: 'assistant', content: [{ type: 'text', text: turn.assistant }], api: 'openai-completions', provider: model.provider, model: model.id, timestamp: 0, usage: emptyUsage(), stopReason: 'stop' };
    const steps = turn.steps ?? [];
    return [[user, ...steps, assistant], [user, ...compact(steps), assistant], [user, assistant]].map(messages => ({ messages, tokens: estimateValueTokens(messages) + messages.length * 32 }));
  });
  const levels: number[] = forms.map((_, index) => index === forms.length - 1 && !compactAll ? 0 : 1);
  let first = 0;
  const total = () => forms.slice(first).reduce((sum, form, index) => sum + form[levels[first + index]!]!.tokens, 0);
  for (let index = 0; index < forms.length - 1 && total() > budget; index++) levels[index] = 2;
  while (first < forms.length - 1 && total() > budget) first++;
  while (first < forms.length && total() > budget) {
    const newest = forms.length - 1;
    if (levels[newest]! < 2) levels[newest] = levels[newest]! + 1; else first++;
  }
  const kept = levels.slice(first);
  report?.({ turns: turns.length, kept: kept.length, compacted: kept.filter(level => level === 1).length, textOnly: kept.filter(level => level === 2).length,
    budget, fullTokens: forms.reduce((sum, form) => sum + form[0]!.tokens, 0), tokens: forms.length ? total() : 0 });
  const messages = forms.slice(first).flatMap((form, index) => form[levels[first + index]!]!.messages);
  const opening = messages[0];
  if (!first || opening?.role !== 'user') return messages;
  const gap = `[${first} earlier turn${first === 1 ? ' of this conversation is' : 's of this conversation are'} not shown here.]`;
  return [{ ...opening, content: typeof opening.content === 'string' ? `${gap}
${opening.content}` : [{ type: 'text', text: gap }, ...opening.content] }, ...messages.slice(1)];
}
