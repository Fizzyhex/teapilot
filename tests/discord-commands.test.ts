import { expect, it } from 'vitest';
import { commandDefinitions, commandText } from '../src/discord/commands.js';

it('maps slash commands to session commands', () => {
  expect(commandText('mode', null, 'code')).toBe('/mode code');
  expect(commandText('stop')).toBe('/stop');
  expect(commandText('mode')).toBeUndefined();
  expect(commandText('cd', null, '..')).toBeUndefined();
});

it('maps permissions subcommands', () => {
  expect(commandText('permissions', 'list')).toBe('/permissions');
  expect(commandText('permissions', 'grant', 'web.search')).toBe('/grant web.search');
  expect(commandText('permissions', 'revoke', 'repository.write')).toBe('/revoke repository.write');
  expect(commandText('permissions', 'grant')).toBeUndefined();
  expect(commandText('permissions')).toBeUndefined();
});

it('offers valid choices for option commands', () => {
  const mode = commandDefinitions.find(command => command.name === 'mode' && 'options' in command)! as Extract<typeof commandDefinitions[number], { options?: unknown }>;
  expect(mode.options![0]).toMatchObject({ choices: [{ value: 'chat' }, { value: 'ask' }, { value: 'code' }] });
  for (const command of commandDefinitions) if ('description' in command) expect(command.description.length).toBeLessThanOrEqual(100);
});

it('registers reply as a slash command and a message context menu without session text', () => {
  expect(commandDefinitions).toContainEqual({ type: 3, name: 'Reply' });
  expect(commandDefinitions.some(command => command.name === 'reply' && 'options' in command)).toBe(true);
  expect(commandText('reply', null, 'hello')).toBeUndefined();
});
