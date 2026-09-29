import { homedir } from 'node:os';
import { resolve } from 'node:path';
import type { HostRequest, HostResult } from './host.js';
import { prepareConversation, type ConversationTurn } from './integration/events.js';
import type { ChatPromptState } from './composer.js';
import { isMode, modes, permissions, repositoryPermissions, workloadFor, type Mode } from './execution/grants.js';
import type { Approve } from './execution/policy.js';
import type { EventSink } from './integration/events.js';
import type { SessionWorkspace } from './workspace/terminal.js';
import { isTierPreference, tierPreferences, type Tier, type TierPreference } from './config.js';

const sessionHelp = `Commands: /mode ${modes.join('|')}, /tier ${tierPreferences.join('|')}, /new, /cd <path>, /permissions, /grant <permission>, /revoke <permission>, /btw <question>, /plan <idea>, /exit, /quit`;

const keptSteps = 6;

/** A side question: `/btw` and what follows, answered from the conversation without joining it. */
export const isAside = (text: string): boolean => /^\/btw(?:\s|$)/i.test(text.trim());

/** A request for a proposal: `/plan` and what follows, sent as an ordinary turn that asks for a plan and no changes yet. */
export const isPlan = (text: string): boolean => /^\/plan(?:\s|$)/i.test(text.trim());

const planTemplate = `Hi, your job is to plan out this feature:

---

%prompt%

---

CRITICAL: DO NOT MAKE ANY CHANGES UNTIL I GIVE YOU AN EXPLICIT "go ahead"! Your reply MUST use the template below, starting with the "<plan>" tag - with NOTHING else extra.

\`\`\`template
<plan>
# Proposal name

## Summary

Briefly explain the proposal, its purpose, and intended outcome.

## Motivation

Describe the problem or opportunity, relevant use cases, and why this is worth doing.

## Design

Explain the proposed approach in enough detail to understand how it would work. Cover key decisions, constraints, dependencies, responsibilities, and practical examples where useful.

## Drawbacks

Identify the main risks, costs, trade-offs, and reasons not to proceed.

## Alternatives

Describe other approaches considered, including doing nothing, and their likely impact.

## Prior Art

Reference similar approaches used elsewhere or internally. Compare relevant patterns, supporting practices, and constraints, and note how this proposal aligns or differs.
</plan>
\`\`\``;

/** The idea wrapped in the planning template. */
export const planPrompt = (idea: string): string => planTemplate.replace('%prompt%', () => idea);

/** Optional behaviour layered on a session, such as teachat. Every hook is awaited in turn order. */
export interface SessionExtension {
  /** Runs before any command or turn: background work must get out of the way first. */
  busy?(): Promise<void>;
  /** Extra fields for each turn's request. */
  request?(): Partial<HostRequest>;
  turnEnd?(turn: ConversationTurn, result: HostResult): Promise<void>;
  /** The conversation was cleared with /new. */
  reset?(): Promise<void>;
  /** Handles a slash command it owns; false leaves it to the session. */
  command?(command: string, args: string): Promise<boolean>;
  help?: string;
}

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
  extension?: SessionExtension;
  /** The conversation's turns after each change, for surfaces that keep them across restarts; empty once cleared. */
  onHistory?: (history: ConversationTurn[]) => void;
  /** Files the session works on outside Code mode: @mentioned files come in, and files sent back land beside the user. */
  workspace?: SessionWorkspace;
}): Promise<number> {
  const extension = options.extension;
  const help = sessionHelp + (extension?.help ? `, ${extension.help}` : '');
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
    if (['/exit', '/quit'].includes(prompt)) { options.onHistory?.([]); break; }
    if (!prompt) continue;
    await extension?.busy?.();
    // A side question sees the conversation but stays out of it: no history, no correction, and extensions never learn of it.
    const aside = isAside(prompt) ? prompt.slice(4).trim() : undefined;
    if (aside !== undefined) {
      if (!aside) options.log?.('/btw <question> asks an aside about this conversation without adding it to the conversation.');
      else {
        const workspace = mode !== 'code' ? options.workspace : undefined;
        const question = workspace ? await workspace.attach(aside, cwd, options.maxPromptChars - aside.length - 1500) : aside;
        // No scratchpad either: that is where the session's transcript is kept.
        const result = await options.run({ ...options.request, ...extension?.request?.(), cwd, prompt: question, correction: undefined, tier, relatedTier, history,
          mode, conversational: !options.once, side: true, scratch: undefined, workload: grants ? undefined : workloadFor(mode), ...(workspace ? { workspace: workspace.context(cwd) } : {}) });
        spentUsd += result.spentUsd;
        lastModel = result.models?.at(-1) ?? lastModel;
        if (!result.success) exitCode = 2;
      }
      prompt = '';
      if (options.once) break;
      continue;
    }
    // A plan request is an ordinary turn, so the proposal stays in the conversation for the talk that follows.
    if (isPlan(prompt)) {
      const idea = prompt.slice(5).trim();
      if (!idea) {
        options.log?.('/plan <idea> asks for a proposal to discuss before any changes are made.');
        prompt = '';
        if (options.once) break;
        continue;
      }
      prompt = planPrompt(idea);
    }
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
      else if (command === '/grant' && !extra && permissions.includes(value as typeof permissions[number])) {
        const permission = value as typeof permissions[number];
        const approved = !!grants && await grants.request([permission], 'You requested it.', options.approve ?? (async () => false), options.request.signal,
          async (type, fields) => { options.onEvent?.({ type, ...fields }); });
        options.log?.(approved ? `Session access: ${grants.list().join(', ')}` : `${permission} was not granted (denied or unavailable).`);
      } else if (command === '/revoke' && !extra && permissions.includes(value as typeof permissions[number])) {
        grants?.revoke(value as typeof permissions[number], options.onEvent);
        options.log?.(`Session access: ${grants?.list().join(', ') || 'none'}`);
      } else if (command === '/tier' && !extra && isTierPreference(value)) {
        tier = value; options.log?.(`Tier preference: ${tier}`);
      } else if (command === '/new' && !value) {
        history = []; options.onHistory?.(history); correction = undefined; relatedTier = undefined; tier = 'auto'; await extension?.reset?.(); await options.workspace?.reset(); options.log?.('Started a new task. Session access and spending remain available.');
      } else if (command === '/mode' && !extra && isMode(value)) {
        const approved = value !== 'code' || !grants || await grants.request(repositoryPermissions.filter(permission => grants.available().includes(permission)),
          'You requested Code mode.', options.approve ?? (async () => false), options.request.signal,
          async (type, fields) => { options.onEvent?.({ type, ...fields }); });
        if (approved) { mode = value; options.log?.(`Mode: ${mode}`); }
        else options.log?.('Code access was not approved; mode unchanged.');
      } else if (!await extension?.command?.(command!, prompt.slice(command!.length).trim())) options.log?.(help);
      prompt = '';
      if (options.once) break;
      continue;
    }
    // Code mode works on the repository itself; the other modes keep files in the session's workspace.
    const workspace = mode !== 'code' ? options.workspace : undefined;
    if (workspace) prompt = await workspace.attach(prompt, cwd, options.maxPromptChars - prompt.length - (correction?.length ?? 0) - 1500);
    // With session grants the host routes by mode and activates access on demand;
    // without them the mode's workload is fixed for the turn.
    const result = await options.run({ ...options.request, ...extension?.request?.(), cwd, prompt, correction, tier, relatedTier, history,
      mode, conversational: !options.once, workload: grants ? undefined : workloadFor(mode), ...(workspace ? { workspace: workspace.context(cwd) } : {}),
      ...(options.workspace ? { scratch: options.workspace.scratch() } : {}) });
    spentUsd += result.spentUsd;
    lastModel = result.models?.at(-1) ?? lastModel;
    if (result.tier && result.tier !== 'fast') relatedTier = result.tier;
    if (!result.success) exitCode = 2;
    const user = prompt + (correction ? `\nUser correction:\n${correction}` : '');
    // A failed turn's text is the host's diagnostic, not a reply; models imitate it on the next turn.
    const assistant = result.success ? result.text : `[that request stopped before finishing: ${result.status.replaceAll('_', ' ')}]`;
    // Only recent turns keep their steps: fitting history to a model replays older ones as text anyway.
    const turns = [...history, { user, assistant, ...(result.steps?.length ? { steps: result.steps } : {}) }];
    history = prepareConversation('', [], turns.map((turn, index) => index < turns.length - keptSteps ? { user: turn.user, assistant: turn.assistant } : turn), options.maxPromptChars).history;
    options.onHistory?.(history);
    await extension?.turnEnd?.({ user, assistant }, result);
    correction = undefined;
    prompt = '';
    if (options.once) break;
  }
  return exitCode;
}

// Compatibility for existing embedders; CLI ask/chat/code all use runSession.
export const runChat = runSession;
