import type { HostRequest, HostResult } from './host.js';
import { prepareConversation, type ConversationTurn } from './integration/events.js';
import type { ChatPromptState } from './composer.js';
import { permissions, repositoryPermissions, type Mode } from './execution/grants.js';
import type { Approve } from './execution/policy.js';
import type { EventSink } from './integration/events.js';

/** A session stays interactive even when an opening prompt was supplied. */
export async function runSession(options: {
  request: HostRequest;
  maxPromptChars: number;
  input: (state: ChatPromptState) => Promise<string>;
  run: (request: HostRequest) => Promise<HostResult>;
  once?: boolean;
  approve?: Approve;
  log?: (text: string) => void;
  onEvent?: EventSink;
}): Promise<number> {
  let history: ConversationTurn[] = options.request.history ?? [];
  let mode: Mode = options.request.mode ?? 'chat';
  const grants = options.request.authorization;
  let prompt = options.request.prompt;
  let correction = options.request.correction;
  let exitCode = 0;
  let spentUsd = 0;
  let lastModel: string | undefined;
  while (!options.request.signal?.aborted) {
    if (!prompt.trim()) {
      try { prompt = await options.input({ spentUsd, lastModel, ...(grants ? { mode, grants: grants.list() } : {}) }); }
      catch (error) {
        if (error instanceof Error && error.name === 'TerminalClosedError') break;
        throw error;
      }
    }
    prompt = prompt.trim();
    if (['/exit', '/quit'].includes(prompt)) break;
    if (!prompt) continue;
    if (prompt.startsWith('/')) {
      const [command, value, extra] = prompt.split(/\s+/);
      if (command === '/permissions' && !value) options.log?.(`Session access (${grants?.root ?? options.request.cwd}): ${grants?.list().join(', ') || 'none'}`);
      else if (command === '/revoke' && !extra && permissions.includes(value as typeof permissions[number])) {
        grants?.revoke(value as typeof permissions[number], options.onEvent);
        options.log?.(`Session access: ${grants?.list().join(', ') || 'none'}`);
      } else if (command === '/mode' && !extra && ['chat', 'ask', 'code'].includes(value ?? '')) {
        const approved = value !== 'code' || !grants || await grants.request(repositoryPermissions.filter(permission => grants.available().includes(permission)),
          'You requested Code mode.', options.approve ?? (async () => false), options.request.signal,
          async (type, fields) => { options.onEvent?.({ type, ...fields }); });
        if (approved) { mode = value as Mode; options.log?.(`Mode: ${mode}`); }
        else options.log?.('Code access was not approved; mode unchanged.');
      } else options.log?.('Commands: /mode chat|ask|code, /permissions, /revoke <permission>, /exit, /quit');
      prompt = '';
      if (options.once) break;
      continue;
    }
    const result = await options.run({ ...options.request, prompt, correction,
      ...(grants ? { mode, workload: undefined, conversational: !options.once } : { workload: 'ask' as const, chat: true }), history });
    spentUsd += result.spentUsd;
    lastModel = result.models?.at(-1) ?? lastModel;
    if (!result.success) exitCode = 2;
    const user = prompt + (correction ? `\nUser correction:\n${correction}` : '');
    history = prepareConversation('', [], [...history, { user, assistant: result.text }], options.maxPromptChars).history;
    correction = undefined;
    prompt = '';
    if (options.once) break;
  }
  return exitCode;
}

// Compatibility for existing embedders; CLI modes all use runSession.
export const runChat = runSession;
