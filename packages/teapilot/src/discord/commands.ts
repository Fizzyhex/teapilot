import { reasoningLevels, tierPreferences, type ReasoningLevel, type TierPreference } from '../config.js';
import { modes, permissions, type Mode } from '../execution/grants.js';
import { reasoningTier } from '../routing/execution.js';

type Choice = { name: string; value: string };
type Option = { type: 3; name: string; description: string; required: boolean; choices?: Choice[] };
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
export const replyMenu = 'Reply';

const value = (description: string, values: readonly string[]): Option =>
  ({ type: 3, name: 'value', description, required: true, choices: values.map(item => ({ name: item, value: item })) });
const optional = (name: string, description: string, values: readonly string[]): Option =>
  ({ type: 3, name, description, required: false, choices: values.map(item => ({ name: item, value: item })) });
const choice = (name: string, description: string, values: readonly string[]): CommandDefinition =>
  ({ name, description, options: [value(description, values)] });
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
  {
    name: promptCommand, description: 'Talk to teapilot with a chosen mode and reasoning',
    options: [
      { type: 3, name: 'prompt', description: 'What to ask teapilot', required: true },
      optional('mode', 'Session mode for this and later turns', modes),
      optional('reasoning', 'Reasoning effort for this and later turns', reasoningLevels),
    ],
    ...everywhere,
  },
  { type: 3, name: replyMenu, ...everywhere },
  { name: 'new', description: 'Start a new task with a clean history' },
  { name: 'stop', description: 'Cancel the running turn' },
  { name: 'exit', description: 'End this conversation' },
  { name: 'help', description: 'Show teapilot commands' },
];

/** Server-install only, for when Discord rejects user-install registration because the portal has it disabled. */
export const withoutUserInstall = (definitions: CommandDefinition[]): CommandDefinition[] =>
  definitions.map(({ integration_types: _types, contexts: _contexts, ...rest }) => rest as CommandDefinition);

/** The session text equivalent to an invocation, or undefined for anything teapilot does not define. */
export function commandText(name: string, subcommandName?: string | null, argument?: string | null): string | undefined {
  const definition = commandDefinitions.find(candidate => candidate.name === name);
  if (!definition || !('description' in definition) || name === replyCommand || name === promptCommand) return undefined;
  if (name === 'permissions') {
    if (subcommandName === 'list') return '/permissions';
    return (subcommandName === 'grant' || subcommandName === 'revoke') && argument ? `/${subcommandName} ${argument}` : undefined;
  }
  return definition.options ? (argument ? `/${name} ${argument}` : undefined) : `/${name}`;
}

/** The mode and tier /prompt asks for; either is left out when not chosen or not recognised. */
export interface PromptSetup { mode?: Mode; tier?: TierPreference }

export function promptSetup(mode?: string | null, reasoning?: string | null): PromptSetup {
  return {
    ...(modes.includes(mode as Mode) ? { mode: mode as Mode } : {}),
    ...(reasoningLevels.includes(reasoning as ReasoningLevel) ? { tier: reasoningTier[reasoning as ReasoningLevel] } : {}),
  };
}

/** The session commands that apply `setup` to a conversation that is already running. */
export const setupCommands = (setup: PromptSetup): string[] =>
  [...(setup.mode ? [`/mode ${setup.mode}`] : []), ...(setup.tier ? [`/tier ${setup.tier}`] : [])];
