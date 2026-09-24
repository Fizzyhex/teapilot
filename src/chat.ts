import type { HostRequest, HostResult } from './host.js';
import { prepareConversation, type ConversationTurn } from './integration/events.js';

/** A session stays interactive even when an opening prompt was supplied. */
export async function runChat(options: {
  request: HostRequest;
  maxPromptChars: number;
  input: () => Promise<string>;
  run: (request: HostRequest) => Promise<HostResult>;
}): Promise<number> {
  let history: ConversationTurn[] = [];
  let prompt = options.request.prompt;
  let correction = options.request.correction;
  let exitCode = 0;
  while (!options.request.signal?.aborted) {
    if (!prompt.trim()) {
      try { prompt = await options.input(); }
      catch (error) {
        if (error instanceof Error && error.name === 'TerminalClosedError') break;
        throw error;
      }
    }
    prompt = prompt.trim();
    if (['/exit', '/quit'].includes(prompt)) break;
    if (!prompt) continue;
    const result = await options.run({ ...options.request, prompt, correction, workload: 'ask', chat: true, history });
    if (!result.success) exitCode = 2;
    const user = prompt + (correction ? `\nUser correction:\n${correction}` : '');
    history = prepareConversation('', [], [...history, { user, assistant: result.text }], options.maxPromptChars).history;
    correction = undefined;
    prompt = '';
  }
  return exitCode;
}
