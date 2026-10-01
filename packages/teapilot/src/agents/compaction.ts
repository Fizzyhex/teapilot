import { createHash, randomUUID } from 'node:crypto';
import { appendFile, lstat, readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { AgentMessage, StreamFn } from '@earendil-works/pi-agent-core';
import type { Message, Model } from '@earendil-works/pi-ai';
import { compact, convertToLlm, DEFAULT_COMPACTION_SETTINGS, SessionManager, shouldCompact, type CompactionEntry, type CompactionResult, type FileEntry } from '@earendil-works/pi-coding-agent';
import type { ConversationTurn } from '../integration/events.js';
import { estimateValueTokens, replyRoom } from '../inference/context.js';
import type { Scratch } from '../workspace/scratch.js';
import { withoutPictures } from './history.js';

/**
 * pi's session compaction, run on teapilot's conversations. When earlier context nears the model's limit, pi's own
 * prompts summarise it and the summary replaces it; the session's whole transcript is a pi session file in the
 * scratchpad, so the summary can say where to look for anything it left out.
 */

/**
 * Which conversation turn a compaction reaches: through a whole earlier turn (`turns`), or into the request it ran
 * in (`request`), whose turn then keeps only what came after the cut. `turn` is a fingerprint of that turn's text.
 */
export type Marker = { through: 'turns' | 'request'; turn: string; request: string };
export interface CompactionDetails { readFiles: string[]; modifiedFiles: string[]; teapilot?: Marker }
/** pi's compaction settings (the package exports only its settings-file form, where each is optional). */
export type CompactionSettings = typeof DEFAULT_COMPACTION_SETTINGS;
export type Compaction = Pick<CompactionEntry<CompactionDetails>, 'summary' | 'tokensBefore' | 'details'>;

/** A turn's words, fingerprinted so a later request can find the turn again among its history. */
export const turnMark = (text: string) => createHash('sha256').update(text.trim()).digest('hex').slice(0, 16);
const turnText = (turn: ConversationTurn) => `${turn.user.trim()}\n${turn.assistant.trim()}`;
export const markTurn = (turn: ConversationTurn) => turnMark(turnText(turn));

/**
 * pi's defaults, scaled to the smaller contexts local models have: room for a reply and some headroom stays
 * free, and about a quarter of the context is kept word for word after a compaction.
 */
export function compactionSettings(profile: { contextTokens: number; maxOutputTokens: number }, enabled = true): CompactionSettings {
  // The room the admission check insists on (inference/context.ts), not the tier's whole reply limit.
  const room = replyRoom(profile);
  return {
    enabled,
    // pi's reserve, but always that room and 2048 more, so compaction comes before the admission check refuses a call.
    reserveTokens: Math.min(Math.max(DEFAULT_COMPACTION_SETTINGS.reserveTokens, room + 2048), room + Math.max(2048, Math.floor(profile.contextTokens * 0.1))),
    keepRecentTokens: Math.min(DEFAULT_COMPACTION_SETTINGS.keepRecentTokens, Math.floor(profile.contextTokens * 0.25)),
  };
}
export { shouldCompact };

/**
 * How long a summary may be: asked for in words, with twice as many tokens as the hard limit, since pi fails a
 * summary cut short. Each summary folds in the one before it, so without a limit they grow with every compaction.
 */
export function summaryLength(contextTokens: number): { words: number; maxTokens: number } {
  const tokens = Math.min(4096, Math.max(768, Math.floor(contextTokens * 0.06)));
  return { words: Math.floor(tokens * 0.6), maxTokens: tokens * 2 };
}

const tokens = (message: Message) => estimateValueTokens(message) + 32;

/**
 * Where to cut `messages` so about `keepRecentTokens` of the newest stay, by pi's rules: only at a user or assistant
 * message, never at a tool result, which must follow its call. A cut inside a turn splits it; the turn's start is
 * then summarised on its own. Nothing is returned when everything fits or there is nothing before the cut.
 */
export function cutMessages(messages: Message[], keepRecentTokens: number): { summarise: Message[]; turnPrefix: Message[]; kept: Message[] } | undefined {
  const cuttable = (index: number) => messages[index]!.role !== 'toolResult';
  let total = 0, cut = -1;
  for (let index = messages.length - 1; index >= 0; index--) {
    total += tokens(messages[index]!);
    if (total < keepRecentTokens) continue;
    for (let at = index; at < messages.length && cut < 0; at++) if (cuttable(at)) cut = at;
    if (cut < 0) for (let at = index - 1; at >= 0 && cut < 0; at--) if (cuttable(at)) cut = at;
    break;
  }
  if (cut <= 0) return undefined;
  const turnStart = messages[cut]!.role === 'user' ? -1 : messages.findLastIndex((message, index) => index < cut && message.role === 'user');
  const end = turnStart >= 0 ? turnStart : cut;
  return { summarise: messages.slice(0, end), turnPrefix: messages.slice(end, cut), kept: messages.slice(cut) };
}

/**
 * pi's summary of `summarise` (and, for a split turn, of `turnPrefix`), updating `previous` when there is one, with
 * the files read and changed. Every prompt is pi's own, with a length limit added; `streamFn` is how teapilot calls models.
 */
export async function summarise(request: {
  summarise: Message[]; turnPrefix?: Message[]; previous?: Compaction; tokensBefore: number;
  settings: CompactionSettings; model: Model<any>; streamFn: StreamFn; signal?: AbortSignal; words?: number;
}): Promise<CompactionResult<CompactionDetails>> {
  const turnPrefix = request.turnPrefix ?? [];
  const fileOps = { read: new Set(request.previous?.details?.readFiles ?? []), written: new Set<string>(), edited: new Set(request.previous?.details?.modifiedFiles ?? []) };
  for (const message of [...request.summarise, ...turnPrefix]) {
    if (message.role !== 'assistant') continue;
    for (const part of message.content) {
      const path = part.type === 'toolCall' ? (part.arguments as { path?: unknown } | undefined)?.path : undefined;
      if (typeof path !== 'string') continue;
      if (part.type === 'toolCall' && part.name === 'read') fileOps.read.add(path);
      else if (part.type === 'toolCall' && part.name === 'write') fileOps.written.add(path);
      else if (part.type === 'toolCall' && part.name === 'edit') fileOps.edited.add(path);
    }
  }
  const result = await compact({
    firstKeptEntryId: 'kept', messagesToSummarize: request.summarise, turnPrefixMessages: turnPrefix, isSplitTurn: turnPrefix.length > 0,
    tokensBefore: request.tokensBefore, previousSummary: request.previous?.summary, fileOps, settings: request.settings,
  }, request.model, undefined, undefined, request.words ? `Keep the whole summary under ${request.words} words: short bullets with only what is needed to carry on. Name files by path rather than quoting them; they can be read again.` : undefined,
  request.signal, undefined, request.streamFn);
  return result as CompactionResult<CompactionDetails>;
}

/** pi's compaction summary message, as pi sends it, and after it where the whole transcript is. */
export function summaryMessage(compaction: Pick<Compaction, 'summary' | 'tokensBefore'>, transcript?: string): Message {
  const [message] = convertToLlm([{ role: 'compactionSummary', summary: compaction.summary, tokensBefore: compaction.tokensBefore, timestamp: Date.now() } as AgentMessage]);
  if (!transcript || message?.role !== 'user' || typeof message.content === 'string') return message!;
  const footer = `\n\nFull historical transcript:\n${transcript}\n\nIf information required to continue is missing from this summary,\nsearch/read that transcript rather than guessing.`;
  const content = [...message.content];
  const last = content.findLastIndex(part => part.type === 'text');
  if (last >= 0) content[last] = { ...content[last]!, text: (content[last] as { text: string }).text + footer } as typeof content[number];
  else content.push({ type: 'text', text: footer.trimStart() });
  return { ...message, content };
}

/**
 * How many of `turns`, oldest first, a compaction already covers, so the summary stands in for them. Turns the
 * surface has since trimmed away cannot be found; then every remaining turn is newer and none is covered. A request
 * cut into by an earlier attempt of this same request has everything before it covered.
 */
export function coveredTurns(turns: ConversationTurn[], marker: Marker | undefined, requestId: string): number {
  if (!marker) return 0;
  if (marker.through === 'request') {
    if (marker.request === requestId) return turns.length;
    return Math.max(0, turns.findLastIndex(turn => turnMark(turn.user) === marker.turn));
  }
  return turns.findLastIndex(turn => markTurn(turn) === marker.turn) + 1;
}

const sessionName = /^[0-9a-f]{8}\.jsonl$/;

/**
 * A conversation's transcript, as a pi session file at <scratchpad>/sessions/<id>.jsonl: every message each attempt
 * saw or produced, which attempt it was, and each compaction. pi keeps the entries; teapilot writes the file, redacted
 * like everything else it keeps, and only ever to a plain file, since sandboxed commands can write around it.
 */
export class SessionLog {
  private queue = Promise.resolve();
  private broken = false;
  private readonly entries = new WeakMap<object, string>();

  private constructor(readonly path: string, private readonly manager: SessionManager, private readonly redact: (text: string) => string, private readonly failed?: (error: unknown) => void) {}

  /** The scratchpad's session, or a new one when it has none yet. */
  static async open(scratch: Scratch, cwd: string, redact: (text: string) => string = text => text, failed?: (error: unknown) => void): Promise<SessionLog> {
    const directory = await scratch.sessions();
    let loaded: FileEntry[] = [], path: string | undefined;
    const names = (await readdir(directory)).filter(name => sessionName.test(name));
    const dated = await Promise.all(names.map(async name => ({ name, info: await lstat(join(directory, name)).catch(() => undefined) })));
    const newest = dated.filter(file => file.info?.isFile()).sort((a, b) => b.info!.mtimeMs - a.info!.mtimeMs)[0];
    if (newest) {
      const entries = (await readFile(join(directory, newest.name), 'utf8')).split('\n').flatMap(line => { try { return line.trim() ? [JSON.parse(line) as FileEntry] : []; } catch { return []; } });
      // A file that does not start as a pi session is not ours to continue.
      if (entries[0]?.type === 'session') { loaded = entries; path = join(directory, newest.name); }
    }
    const id = path ? newest!.name.slice(0, -'.jsonl'.length) : randomUUID().slice(0, 8);
    const manager = SessionManager.inMemory(cwd, { id }, loaded.length ? loaded : undefined);
    return new SessionLog(path ?? join(directory, `${id}.jsonl`), manager, redact, failed);
  }

  /** Marks where an attempt begins, so retries of one request can be told apart. */
  mark(data: { request: string; attempt: number; tier: string; model: string }): void {
    this.write(this.manager.appendCustomEntry('teapilot.attempt', data));
  }

  record(message: Message): void {
    const id = this.manager.appendMessage(withoutPictures(message));
    this.entries.set(message, id);
    this.write(id);
  }

  /** The newest compaction teapilot made in this session. */
  latest(): Compaction | undefined {
    return this.manager.getEntries().findLast((entry): entry is CompactionEntry<CompactionDetails> => entry.type === 'compaction' && Boolean((entry.details as CompactionDetails | undefined)?.teapilot));
  }

  /** Keeps a compaction, pointing at the first message it kept when that message is in the transcript. */
  compaction(result: CompactionResult<CompactionDetails>, marker: Marker, firstKept?: Message): Compaction {
    const details: CompactionDetails = { readFiles: result.details?.readFiles ?? [], modifiedFiles: result.details?.modifiedFiles ?? [], teapilot: marker };
    const id = this.manager.appendCompaction(result.summary, (firstKept && this.entries.get(firstKept)) ?? null, result.tokensBefore, details, false, result.usage);
    this.write(id);
    return { summary: result.summary, tokensBefore: result.tokensBefore, details };
  }

  /** Waits for everything recorded so far to reach the file. */
  flush(): Promise<void> { return this.queue; }

  private write(id: string): void {
    const entry = this.manager.getEntry(id);
    if (!entry || this.broken) return;
    this.queue = this.queue.then(async () => {
      if (this.broken) return;
      const info = await lstat(this.path).catch(() => undefined);
      if (info && (!info.isFile() || info.nlink > 1)) throw new Error('The session transcript is not a plain file');
      // Redaction that breaks an entry's JSON leaves the entry out rather than the file unreadable.
      const lines = [...info ? [] : [this.manager.getHeader()], entry].map(value => this.redact(JSON.stringify(value)))
        .filter(line => { try { JSON.parse(line); return true; } catch { return false; } });
      await appendFile(this.path, `${lines.join('\n')}\n`, { mode: 0o600 });
    }).catch(error => { this.broken = true; this.failed?.(error); });
  }
}
