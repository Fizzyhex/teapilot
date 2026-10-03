import type { AssistantMessage, ImageContent, Message, TextContent, ToolResultMessage } from '@earendil-works/pi-ai';
import { emptyUsage } from '../integration/inference.js';
import type { ConversationTurn } from '../integration/events.js';
import { estimateValueTokens } from '../inference/context.js';
import { savedLine } from '../workspace/scratch.js';
import { DEFAULT_READ_LINES } from './tools.js';

type Model = { provider: string; id: string };

/** `message` with pictures swapped for what `replace` returns (a part it leaves undefined stays); the same message when none is. */
function replacePictures(message: Message, replace: (picture: ImageContent) => TextContent | undefined): Message {
  if (message.role === 'assistant' || typeof message.content === 'string' || !message.content.some(part => part.type === 'image')) return message;
  let changed = false;
  const content = message.content.map(part => {
    const note = part.type === 'image' ? replace(part) : undefined;
    changed ||= Boolean(note);
    return note ?? part;
  });
  return changed ? { ...message, content } as Message : message;
}
const hiddenPicture = (why: string): TextContent => ({ type: 'text', text: `[picture ${why}; read the file again to see it]` });
/** The message as a transcript keeps it: a picture is a note, since its bytes are in the workspace file. */
export const withoutPictures = (message: Message): Message => replacePictures(message, () => hiddenPicture('not kept in the transcript'));

/**
 * The messages with every picture but the newest `keep` swapped for a note, as one model call is sent them: a
 * picture costs about a thousand tokens each time it is sent. Returns the same array when nothing changes.
 */
export function withoutOldPictures(messages: Message[], keep = 2): Message[] {
  let shown = 0, changed = false;
  const result = [...messages];
  for (let index = messages.length - 1; index >= 0; index--) {
    const message = replacePictures(messages[index]!, () => shown++ < keep ? undefined : hiddenPicture('no longer shown, to save room'));
    if (message !== messages[index]) { result[index] = message; changed = true; }
  }
  return changed ? result : messages;
}

/**
 * The part of a finished turn worth replaying: tool calls and their results, without reasoning or host
 * notices, and without a call whose result never came (a model server rejects that pairing). Pictures are not
 * kept: their bytes would fill the saved history, and the file is one read away.
 */
export function turnSteps(messages: Message[]): Message[] {
  const steps: Message[] = [];
  for (const message of messages) {
    if (message.role === 'assistant') {
      const content = message.content.filter(part => part.type !== 'thinking');
      if (content.length) steps.push({ ...message, content });
    } else if (message.role === 'toolResult') steps.push(replacePictures(message, () => hiddenPicture('not kept in history')));
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

/** Bound the aggregate raw tool evidence by actual estimated tokens, newest first, without losing tool pairings. */
export function fitRecentResults(messages: Message[], budget: number): Message[] {
  let changed = false;
  const result = [...messages];
  const controls = new Set(['task_state', 'report', 'artifact_read', 'request_escalation', 'request_capabilities', 'file_send']);
  const eligible: Array<{ index: number; cost: (content: string | Array<{ type: string; text?: string }>) => number; raw: string | Array<{ type: string; text?: string }>; candidate: (limit: number) => string | Array<{ type: string; text?: string }>; totalChars: number; minimumCost: number }> = [];
  for (let index = 0; index < messages.length; index++) {
    const message = messages[index]!;
    if (message.role !== 'toolResult' && (message as { role?: string }).role !== 'tool') continue;
    const meta = message as unknown as { toolName?: string; name?: string; isError?: boolean; content: string | Array<{ type: string; text?: string }> };
    const tool = meta.toolName ?? meta.name ?? '';
    if (controls.has(tool) || tool.startsWith('access_') || tool.startsWith('play_') || tool.startsWith('teachat_')) continue;
    const raw = meta.content;
    const texts = typeof raw === 'string' ? [raw] : Array.isArray(raw) ? raw.map(part => part.type === 'text' ? part.text ?? '' : '') : [];
    const cost = (content: typeof raw) => estimateValueTokens({ role: message.role, toolName: tool, content, isError: meta.isError }) + 16;
    const notes = texts.flatMap(text => [...text.matchAll(savedLine)].map(match => match[0]));
    const notices = texts.flatMap(text => text.split('\n').filter(line => /task state was not saved/i.test(line)));
    const error = meta.isError ? texts.flatMap(text => text.replace(savedLine, '').split('\n').filter(Boolean))[0]?.slice(0, 240) : undefined;
    const bodies = texts.map(text => text.replace(savedLine, '').split('\n').filter(line => !/task state was not saved/i.test(line)).join('\n').trim());
    const totalChars = bodies.reduce((total, text) => total + text.length, 0);
    const suffix = [...notes, ...notices, ...(error ? [`Tool error: ${error}`] : totalChars ? ['[older result excerpt shortened; reread the source or saved output for details]'] : [])].join('\n');
    const candidate = (limit: number) => {
      let left = limit;
      const body = bodies.map(text => {
        const take = Math.min(text.length, left);
        left -= take;
        return take ? clip(text, take) : '';
      });
      const combined = [...body, suffix].filter(Boolean).join('\n');
      if (typeof raw === 'string') return combined;
      let used = false;
      return raw.map(part => {
        if (part.type !== 'text') return part;
        if (used) return { ...part, text: '' };
        used = true;
        return { ...part, text: combined };
      });
    };
    eligible.push({ index, cost, raw, candidate, totalChars, minimumCost: cost(candidate(0)) });
  }
  // Reserve all mandatory handles/errors/notice and message-wrapper costs before allocating any raw excerpts.
  // If that floor alone exceeds the budget, preserve it; the enclosing context compactor is responsible for pressure.
  const floor = eligible.reduce((sum, item) => sum + item.minimumCost, 0);
  let excerptBudget = Math.max(0, budget - floor);
  for (let itemIndex = eligible.length - 1; itemIndex >= 0; itemIndex--) {
    const item = eligible[itemIndex]!;
    const message = messages[item.index]!;
    const fullCost = item.cost(item.raw);
    if (fullCost <= item.minimumCost + excerptBudget) {
      excerptBudget -= Math.max(0, fullCost - item.minimumCost);
      continue;
    }
    let low = 0, high = item.totalChars;
    while (low < high) {
      const mid = Math.ceil((low + high) / 2);
      if (item.cost(item.candidate(mid)) <= item.minimumCost + excerptBudget) low = mid; else high = mid - 1;
    }
    const content = item.candidate(low);
    excerptBudget = Math.max(0, excerptBudget - Math.max(0, item.cost(content) - item.minimumCost));
    result[item.index] = { ...message, content } as Message;
    changed = true;
  }
  return changed ? result : messages;
}

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
/** Calls that carry an app's code: it is written to its file, then run by the play tools. */
const appCalls = new Set([...playCalls, 'write', 'edit']);
/**
 * An attempt's messages with app calls a later one superseded cut down: a play call that changed nothing keeps only
 * its outcome. Under `pressure`, earlier calls that did apply lose their long arguments and code blocks too, the
 * code written to files included; the app's file stays one read away. The newest call is never touched. Returns
 * the same array when nothing changes.
 */
export function supersedePlayCalls(messages: Message[], pressure: boolean): Message[] {
  const newest = messages.findLastIndex(message => message.role === 'assistant' && message.content.some(part => part.type === 'toolCall' && appCalls.has(part.name)));
  if (newest < 0) return messages;
  const unapplied = new Set(messages.flatMap(message => message.role === 'toolResult' && playCalls.has(message.toolName)
    && (message.isError || message.content.some(part => part.type === 'text' && /Nothing was (changed|started)|^No file named|unchanged since it was rejected/.test(part.text))) ? [message.toolCallId] : []));
  let changed = false;
  const result = messages.map((message, index) => {
    if (index >= newest || message.role !== 'assistant') return message;
    const content = message.content.map(part => {
      if (part.type === 'toolCall' && appCalls.has(part.name) && (pressure || unapplied.has(part.id))) {
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
 * Thinking serves the step it led to, so every reply before the newest loses it, as Qwen's guidance does for
 * history: old reasoning costs context that the calls and results after it already cover. A reply of nothing but
 * thinking keeps it. Returns the same array when nothing changes.
 */
export function withoutOldThinking(messages: Message[]): Message[] {
  const newest = messages.findLastIndex(message => message.role === 'assistant');
  let changed = false;
  const result = messages.map((message, index) => {
    if (index >= newest || message.role !== 'assistant' || !message.content.some(part => part.type === 'thinking')) return message;
    const content = message.content.filter(part => part.type !== 'thinking');
    if (!content.length) return message;
    changed = true;
    return { ...message, content };
  });
  return changed ? result : messages;
}

/**
 * Reads a later read of the same file covers, each cut to a note: the later one shows those lines as they are now,
 * and a model that reads a file again after losing track of it otherwise carries every copy. `resolve` makes the
 * paths the model gave comparable. Returns the same array when nothing changes.
 */
export function supersedeReads(messages: Message[], resolve: (path: string) => string): Message[] {
  const reads = new Map<string, { path: string; file: string; from: number; to: number }>();
  for (const message of messages) {
    if (message.role !== 'assistant') continue;
    for (const part of message.content) {
      if (part.type !== 'toolCall' || part.name !== 'read') continue;
      const { path, offset, limit } = (part.arguments ?? {}) as { path?: unknown; offset?: unknown; limit?: unknown };
      if (typeof path !== 'string' || !path) continue;
      const from = typeof offset === 'number' && offset > 0 ? offset : 1;
      reads.set(part.id, { path, file: resolve(path), from, to: from + (typeof limit === 'number' && limit > 0 ? limit : DEFAULT_READ_LINES) - 1 });
    }
  }
  const newer: Array<{ file: string; from: number; to: number }> = [];
  const result = [...messages];
  let changed = false;
  for (let index = messages.length - 1; index >= 0; index--) {
    const message = messages[index]!;
    if (message.role !== 'toolResult' || message.toolName !== 'read' || message.isError) continue;
    const read = reads.get(message.toolCallId);
    if (!read) continue;
    if (!newer.some(later => later.file === read.file && later.from <= read.from && later.to >= read.to)) { newer.push(read); continue; }
    const note = `[Superseded: a later read of ${read.path} shows these lines as they are now.]`;
    if (message.content.length === 1 && message.content[0]!.type === 'text' && message.content[0]!.text === note) continue;
    result[index] = { ...message, content: [{ type: 'text', text: note }] };
    changed = true;
  }
  return changed ? result : messages;
}

/**
 * An attempt's messages, ready for another attempt on the same model to carry on from: without a reply that failed,
 * was cut off, or announced calls it never made at the end, and without calls and results that lost their other
 * half. Nothing is returned when no reply is left.
 */
export function carryOver(messages: Message[]): Message[] | undefined {
  const kept = [...messages];
  const unusable = (message: Message) => message.role === 'assistant' && (['error', 'aborted', 'length'].includes(message.stopReason)
    || (message.stopReason === 'toolUse' && !message.content.some(part => part.type === 'toolCall')));
  while (kept.length && unusable(kept.at(-1)!)) kept.pop();
  const answered = new Set(kept.flatMap(message => message.role === 'toolResult' ? [message.toolCallId] : []));
  const called = new Set<string>();
  const paired = kept.flatMap((message): Message[] => {
    if (message.role === 'toolResult') return called.has(message.toolCallId) ? [message] : [];
    if (message.role !== 'assistant') return [message];
    const content = message.content.filter(part => part.type !== 'toolCall' || answered.has(part.id));
    for (const part of content) if (part.type === 'toolCall') called.add(part.id);
    // A reply whose every call went reads as an ordinary answer, not as a call the server lost.
    const calls = content.some(part => part.type === 'toolCall');
    return content.length ? [content.length === message.content.length ? message : { ...message, content, ...(calls ? {} : { stopReason: 'stop' as const }) }] : [];
  });
  return paired.some(message => message.role === 'assistant') ? paired : undefined;
}

/** A turn as messages: in full, with its steps compacted, and as its text alone. */
export function turnForms(turn: ConversationTurn, model: Model): [Message[], Message[], Message[]] {
  const user: Message = { role: 'user', content: turn.user, timestamp: 0 };
  const assistant: AssistantMessage = { role: 'assistant', content: [{ type: 'text', text: turn.assistant }], api: 'openai-completions', provider: model.provider, model: model.id, timestamp: 0, usage: emptyUsage(), stopReason: 'stop' };
  const steps = turn.steps ?? [];
  // A turn that stopped without a reply of the model's own has none: host text there reads as the model's words, and it copies them.
  const reply = turn.assistant.trim() ? [assistant] : [];
  return [[user, ...steps, ...reply], [user, ...compact(steps), ...reply], [user, ...reply]];
}

/**
 * Replays earlier turns within `budget` tokens. The newest turn keeps its steps in full (compacted too with
 * `compactAll`); older ones keep them compacted. When that is too much, the oldest turns fall back to their
 * text, then drop out, and the newest is cut down last. Turns that drop out are counted where the rest begin,
 * so the model knows its memory of the conversation has a gap, and where its `transcript` is when there is one.
 */
export interface HistoryFit { turns: number; kept: number; compacted: number; textOnly: number; budget: number; fullTokens: number; tokens: number }
export function fitHistory(turns: ConversationTurn[], budget: number, model: Model, report?: (fit: HistoryFit) => void, compactAll = false, transcript?: string): Message[] {
  const forms = turns.map(turn => turnForms(turn, model).map(messages => ({ messages, tokens: estimateValueTokens(messages) + messages.length * 32 })));
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
  const gap = `[${first} earlier turn${first === 1 ? ' of this conversation is' : 's of this conversation are'} not shown here${transcript ? `; the full transcript is ${transcript}` : ''}.]`;
  return [{ ...opening, content: typeof opening.content === 'string' ? `${gap}
${opening.content}` : [{ type: 'text', text: gap }, ...opening.content] }, ...messages.slice(1)];
}
