import { homedir } from 'node:os';
import { resolve } from 'node:path';
import type { HostRequest, HostResult } from './host.js';
import { prepareConversation, type ConversationTurn } from './integration/events.js';
import type { ChatPromptState } from './composer.js';
import { isMode, modes, permissions, repositoryPermissions, workloadFor, type Mode } from './execution/grants.js';
import type { Approve } from './execution/policy.js';
import type { EventSink } from './integration/events.js';
import { isTierPreference, tierPreferences, type Tier, type TierPreference } from './config.js';

const sessionHelp = `Commands: /mode ${modes.join('|')}, /tier ${tierPreferences.join('|')}, /new, /cd <path>, /permissions, /revoke <permission>, /exit, /quit`;

/**
 * One session loop for every mode (chat, ask, code). The mode selects instructions
 * and default access; history, tiers, grants and commands behave identically.
 * A session stays interactive even when an opening prompt was supplied.
 */
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
  let cwd = options.request.cwd;
  let prompt = options.request.prompt;
  let correction = options.request.correction;
  let tier: TierPreference = options.request.tier ?? 'auto';
  let relatedTier: Tier | undefined = options.request.relatedTier;
  let exitCode = 0;
  let spentUsd = 0;
  let lastModel: string | undefined;
  while (!options.request.signal?.aborted) {
    if (!prompt.trim()) {
      try { prompt = await options.input({ spentUsd, lastModel, tier, ...(grants ? { mode, grants: grants.list(), cwd: grants.root } : {}) }); }
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
      if (command === '/cd') {
        const target = prompt.slice(3).trim().replace(/^(["'])(.*)\1$/, '$2');
        let moved = !target;
        if (!grants) options.log?.('/cd needs a session with access grants.');
        else if (target) try {
          await grants.reroot(resolve(grants.root, target.replace(/^~(?=$|[\\/])/, homedir())), mode, options.onEvent);
          cwd = grants.root; moved = true;
        } catch (error) {
          options.log?.(`Cannot change directory: ${(error as NodeJS.ErrnoException).code === 'ENOENT' ? `${target} does not exist` : error instanceof Error ? error.message : String(error)}. Root unchanged: ${grants.root}`);
        }
        if (grants && moved) options.log?.(`Root: ${grants.root}\nSession access: ${grants.list().join(', ') || 'none'}${mode === 'code'
          && !(grants.allows('repository.write') && grants.allows('repository.shell')) ? ' (write and shell are requested for this root when first needed)' : ''}`);
      } else if (command === '/permissions' && !value) options.log?.(`Session access (${grants?.root ?? cwd}): ${grants?.list().join(', ') || 'none'}`);
      else if (command === '/revoke' && !extra && permissions.includes(value as typeof permissions[number])) {
        grants?.revoke(value as typeof permissions[number], options.onEvent);
        options.log?.(`Session access: ${grants?.list().join(', ') || 'none'}`);
      } else if (command === '/tier' && !extra && isTierPreference(value)) {
        tier = value; options.log?.(`Tier preference: ${tier}`);
      } else if (command === '/new' && !value) {
        history = []; correction = undefined; relatedTier = undefined; tier = 'auto'; options.log?.('Started a new task. Session access and spending remain available.');
      } else if (command === '/mode' && !extra && isMode(value)) {
        const approved = value !== 'code' || !grants || await grants.request(repositoryPermissions.filter(permission => grants.available().includes(permission)),
          'You requested Code mode.', options.approve ?? (async () => false), options.request.signal,
          async (type, fields) => { options.onEvent?.({ type, ...fields }); });
        if (approved) { mode = value; options.log?.(`Mode: ${mode}`); }
        else options.log?.('Code access was not approved; mode unchanged.');
      } else options.log?.(sessionHelp);
      prompt = '';
      if (options.once) break;
      continue;
    }
    // With session grants the host routes by mode and activates access on demand;
    // without them the mode's workload is fixed for the turn.
    const result = await options.run({ ...options.request, cwd, prompt, correction, tier, relatedTier, history,
      mode, conversational: !options.once, workload: grants ? undefined : workloadFor(mode) });
    spentUsd += result.spentUsd;
    lastModel = result.models?.at(-1) ?? lastModel;
    if (result.tier && result.tier !== 'fast') relatedTier = result.tier;
    if (!result.success) exitCode = 2;
    const user = prompt + (correction ? `\nUser correction:\n${correction}` : '');
    history = prepareConversation('', [], [...history, { user, assistant: result.text }], options.maxPromptChars).history;
    correction = undefined;
    prompt = '';
    if (options.once) break;
  }
  return exitCode;
}

// Compatibility for existing embedders; CLI ask/chat/code all use runSession.
export const runChat = runSession;
