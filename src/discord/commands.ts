import { tierPreferences } from '../config.js';
import { modes, permissions } from '../execution/grants.js';

type Choice = { name: string; value: string };
type Option = { type: 3; name: string; description: string; required: true; choices: Choice[] };
/** Discord application-command JSON; kept free of discord.js so it can be tested and registered from anywhere. */
export interface CommandDefinition {
  name: string;
  description: string;
  options?: Array<Option | { type: 1; name: string; description: string; options?: Option[] }>;
}

const value = (description: string, values: readonly string[]): Option =>
  ({ type: 3, name: 'value', description, required: true, choices: values.map(item => ({ name: item, value: item })) });
const choice = (name: string, description: string, values: readonly string[]): CommandDefinition =>
  ({ name, description, options: [value(description, values)] });
const subcommand = (name: string, description: string, options?: Option[]) => ({ type: 1 as const, name, description, ...(options ? { options } : {}) });

/** Slash commands mirror the session commands the bridge already understands; /cd is fixed for Discord. */
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
  { name: 'new', description: 'Start a new task with a clean history' },
  { name: 'stop', description: 'Cancel the running turn' },
  { name: 'exit', description: 'End this conversation' },
  { name: 'help', description: 'Show teapilot commands' },
];

/** The session text equivalent to an invocation, or undefined for anything teapilot does not define. */
export function commandText(name: string, subcommandName?: string | null, argument?: string | null): string | undefined {
  const definition = commandDefinitions.find(candidate => candidate.name === name);
  if (!definition) return undefined;
  if (name === 'permissions') {
    if (subcommandName === 'list') return '/permissions';
    return (subcommandName === 'grant' || subcommandName === 'revoke') && argument ? `/${subcommandName} ${argument}` : undefined;
  }
  return definition.options ? (argument ? `/${name} ${argument}` : undefined) : `/${name}`;
}
