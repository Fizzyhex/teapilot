import { reasoningLevels, tierPreferences, type ReasoningLevel, type TierPreference } from '../config.js';
import { modes, permissions, type Mode } from '../execution/grants.js';
import { reasoningTier } from '../routing/execution.js';

type Choice = { name: string; value: string };
/** 3 = string, 5 = boolean, 11 = attachment. */
type Option = { type: 3; name: string; description: string; required: boolean; choices?: Choice[] }
  | { type: 5 | 11; name: string; description: string; required: boolean };
/** Discord application-command JSON; kept free of discord.js so it can be tested and registered from anywhere. */
export type CommandDefinition = Placement & (
  | { name: string; description: string; options?: Array<Option | { type: 1; name: string; description: string; options?: Option[] }> }
  /** Message context menu entry (right-click → Apps); Discord forbids a description here. */
  | { type: 3; name: string });
/** 0 = installed to a server, 1 = installed to a user; contexts 0 = server, 1 = bot DM, 2 = other DMs and group chats. */
interface Placement { integration_types?: Array<0 | 1>; contexts?: Array<0 | 1 | 2> }
const everywhere: Placement = { integration_types: [0, 1], contexts: [0, 1, 2] };

/** Discord expires an interaction's webhook after 15 minutes; stop a little before so replies never race it. */
export const interactionLifetimeMs = 14 * 60_000;

/** Commands that start or continue a conversation instead of controlling one; the gateway handles them itself. */
export const replyCommand = 'reply';
export const promptCommand = 'prompt';
/** Like /prompt, but where teapilot answers through the interaction, everyone in the channel shares one history. */
export const collabCommand = 'collab';
/** Ends the conversation and its history: the session's /exit, or leaving a collab. */
export const clearCommand = 'clear';
export const replyMenu = 'Reply';

const value = (description: string, values: readonly string[]): Option =>
  ({ type: 3, name: 'value', description, required: true, choices: values.map(item => ({ name: item, value: item })) });
const optional = (name: string, description: string, values: readonly string[]): Option =>
  ({ type: 3, name, description, required: false, choices: values.map(item => ({ name: item, value: item })) });
const choice = (name: string, description: string, values: readonly string[]): CommandDefinition =>
  ({ name, description, options: [value(description, values)] });
/** How many files /prompt and /collab take: `attachment1` to `attachment4`. */
export const promptAttachments = 4;
export const attachmentOption = (index: number) => `attachment${index + 1}`;
// Each runs its own tier; medium picks deep, which runs xhigh only when the policy opts in.
const promptEfforts: readonly ReasoningLevel[] = reasoningLevels.filter(level => level !== 'xhigh');
/** /prompt and /collab take the same options. */
const promptOptions: Option[] = [
  { type: 3, name: 'prompt', description: 'What to ask teapilot', required: true },
  optional('mode', 'Session mode for this and later turns', modes),
  optional('reasoning', 'Reasoning effort for this and later turns', promptEfforts),
  { type: 5, name: 'yolo', description: 'Approve every action this prompt asks for without asking (operators only)', required: false },
  ...Array.from({ length: promptAttachments }, (_, index): Option => ({ type: 11, name: attachmentOption(index), description: 'A file for teapilot to read', required: false })),
];
const subcommand = (name: string, description: string, options?: Option[]) => ({ type: 1 as const, name, description, ...(options ? { options } : {}) });

/** These mirror the session commands the bridge already understands; /cd is fixed for Discord. */
export const commandDefinitions: CommandDefinition[] = [
  choice('mode', 'Switch the session mode', modes),
  choice('tier', 'Set the model tier preference', tierPreferences),
  {
    name: 'permissions', description: 'Show, grant or revoke session access',
    options: [
      subcommand('list', 'List the access granted to this session'),
      subcommand('grant', 'Ask to grant a permission for this session', [value('Permission to grant', permissions)]),
      subcommand('revoke', 'Revoke a session permission', [value('Permission to revoke', permissions)]),
    ],
  },
  {
    name: replyCommand, description: 'Talk to teapilot in this channel',
    options: [{ type: 3, name: 'message', description: 'What to ask teapilot', required: true }],
    ...everywhere,
  },
  { name: promptCommand, description: 'Talk to teapilot with a chosen mode and reasoning', options: promptOptions, ...everywhere },
  { name: collabCommand, description: 'Talk to teapilot in a conversation everyone here shares', options: promptOptions, ...everywhere },
  { type: 3, name: replyMenu, ...everywhere },
  // Also where teapilot is not invited, where they act on the conversation /reply, /prompt or /collab keeps there.
  { name: clearCommand, description: 'End your conversation here and clear its history', ...everywhere },
  { name: 'stop', description: 'Cancel the running turn', ...everywhere },
  { name: 'help', description: 'Show teapilot commands' },
];

/** Server-install only, for when Discord rejects user-install registration because the portal has it disabled. */
export const withoutUserInstall = (definitions: CommandDefinition[]): CommandDefinition[] =>
  definitions.map(({ integration_types: _types, contexts: _contexts, ...rest }) => rest as CommandDefinition);

/** The session text equivalent to an invocation, or undefined for anything teapilot does not define. */
export function commandText(name: string, subcommandName?: string | null, argument?: string | null): string | undefined {
  const definition = commandDefinitions.find(candidate => candidate.name === name);
  if (!definition || !('description' in definition) || [replyCommand, promptCommand, collabCommand].includes(name)) return undefined;
  if (name === 'permissions') {
    if (subcommandName === 'list') return '/permissions';
    return (subcommandName === 'grant' || subcommandName === 'revoke') && argument ? `/${subcommandName} ${argument}` : undefined;
  }
  if (name === clearCommand) return '/exit';
  return definition.options ? (argument ? `/${name} ${argument}` : undefined) : `/${name}`;
}

/** The mode and tier /prompt or /collab asks for; either is left out when not chosen or not recognised. */
export interface PromptSetup { mode?: Mode; tier?: TierPreference }

export function promptSetup(mode?: string | null, reasoning?: string | null): PromptSetup {
  return {
    ...(modes.includes(mode as Mode) ? { mode: mode as Mode } : {}),
    ...(promptEfforts.includes(reasoning as ReasoningLevel) ? { tier: reasoningTier[reasoning as ReasoningLevel] } : {}),
  };
}

/** The session commands that apply `setup` to a conversation that is already running. */
export const setupCommands = (setup: PromptSetup): string[] =>
  [...(setup.mode ? [`/mode ${setup.mode}`] : []), ...(setup.tier ? [`/tier ${setup.tier}`] : [])];
