import { readFile, realpath, stat } from 'node:fs/promises';
import { resolve } from 'node:path';
import { parse } from 'dotenv';
import { during } from '../activity.js';
import { exists } from '../config.js';
import { singleRepository } from '../execution/grants.js';
import { saveEnvironment } from '../setup/index.js';
import type { SetupUI } from '../setup/terminal.js';
import { discordKeys, DiscordNotConfigured, idList, isSnowflake, readDiscordSettings } from './settings.js';

export const discordApi = 'https://discord.com/api/v10';
const intents = { messageContent: 1 << 18, messageContentLimited: 1 << 19 };
/** The minimum the bot needs: read and answer in the configured channels and their threads. */
const permissions = { viewChannel: 1n << 10n, sendMessages: 1n << 11n, readMessageHistory: 1n << 16n, createPublicThreads: 1n << 35n, sendMessagesInThreads: 1n << 38n };
export const invitePermissions = Object.values(permissions).reduce((total, bit) => total | bit, 0n);
export const inviteUrl = (applicationId: string) => `https://discord.com/oauth2/authorize?client_id=${applicationId}&scope=bot&permissions=${invitePermissions}`;

export interface DiscordSetupOptions { directory: string; cwd: string; api?: string }
export interface Application { id: string; name: string; flags: number }

export async function fetchApplication(api: string, token: string, signal: AbortSignal): Promise<Application> {
  const response = await fetch(`${api}/oauth2/applications/@me`, { headers: { Authorization: `Bot ${token}` }, signal });
  if (response.status === 401) throw new Error('Discord rejected the token. Copy it again from Bot → Reset Token.');
  if (!response.ok) throw new Error(`Discord answered HTTP ${response.status}.`);
  const body = await response.json() as Partial<Application>;
  if (typeof body.id !== 'string') throw new Error('Discord returned an unexpected response.');
  return { id: body.id, name: String(body.name ?? 'application'), flags: Number(body.flags ?? 0) };
}
export const messageContentEnabled = (flags: number) => Boolean(flags & (intents.messageContent | intents.messageContentLimited));
export const intentWarning = 'Message Content Intent: not enabled. Without it, messages reach teapilot empty. Enable it under Bot → Privileged Gateway Intents.';
export const validToken = (token: string) => Boolean(token) && !/[\s"\\]/.test(token);
export const createBot = [
  'Create a bot at https://discord.com/developers/applications:',
  '  1. New Application, then open Bot.',
  '  2. Reset Token and copy it.',
  '  3. Under Privileged Gateway Intents, enable Message Content Intent and save.',
];

export async function profileEnvironment(directory: string): Promise<Record<string, string> | undefined> {
  const path = resolve(directory, '.env');
  return await exists(path) ? parse(await readFile(path)) : undefined;
}

/** The saved channel list, including one saved as DISCORD_CHANNEL_ID. */
export const savedChannels = (env: Record<string, string>) => idList(env.DISCORD_CHANNEL_IDS ?? env.DISCORD_CHANNEL_ID);

/** An existing directory, resolved from cwd, or undefined. */
export async function resolveRoot(cwd: string, answer: string): Promise<string | undefined> {
  try {
    const root = await realpath(resolve(cwd, answer || cwd));
    return (await stat(root)).isDirectory() ? root : undefined;
  } catch { return undefined; }
}

export interface DiscordDraft { token: string; application: Application; operators: string[]; channels: string[]; root: string }

const where = (channels: string[]) => channels.length ? `DMs and @mentions in ${channels.length === 1 ? 'channel' : 'channels'} ${channels.join(', ')}` : 'DMs only';

/** The review before saving, marking what differs from the saved settings. */
export function summaryLines(draft: DiscordDraft, env: Record<string, string>): string[] {
  const configured = Boolean(env.DISCORD_BOT_TOKEN);
  const was = (now: string, before: string) => configured && now !== before ? ` (was ${before})` : '';
  const operators = draft.operators.join(', ');
  return [
    `  Bot:        ${draft.application.name}${configured && draft.token !== env.DISCORD_BOT_TOKEN ? ' (new token)' : ''}`,
    `  Operators:  ${operators}${was(operators, idList(env.DISCORD_ALLOWED_USER_IDS).join(', '))}`,
    `  Where:      ${where(draft.channels)}${was(where(draft.channels), where(savedChannels(env)))}`,
    `  Repository: ${draft.root}${was(draft.root.replace(/\\/g, '/'), env.DISCORD_ROOT ?? '')}`,
    '  Sessions start in ask mode, and each channel task gets its own thread. /mode code, shell commands and large overwrites ask for button approval.',
  ];
}

export function discordEnvironment(env: Record<string, string>, draft: DiscordDraft): Record<string, string> {
  const next: Record<string, string> = { ...env, DISCORD_BOT_TOKEN: draft.token, DISCORD_ALLOWED_USER_IDS: draft.operators.join(','), DISCORD_ROOT: draft.root.replace(/\\/g, '/'), DISCORD_START_MODE: env.DISCORD_START_MODE ?? 'ask' };
  delete next.DISCORD_CHANNEL_ID;
  if (draft.channels.length) next.DISCORD_CHANNEL_IDS = draft.channels.join(','); else delete next.DISCORD_CHANNEL_IDS;
  return next;
}

/** Printed on the plain terminal once saved, so the invite link can be copied. */
export function afterSave(ui: SetupUI, directory: string, application: Application): void {
  ui.log('Discord settings saved.');
  ui.log(`Invite the bot to a server you share with the allowed users (needed for DMs too):\n  ${inviteUrl(application.id)}`);
  ui.log(`Next: teapilot discord start --config-dir "${directory}"`);
}

/**
 * The opt-in Discord sequence. Nothing is saved until the final confirmation. Like teapilot setup,
 * it uses the tabbed screen when the terminal has room for it, and asks one question after another otherwise.
 */
export async function configureDiscord(options: DiscordSetupOptions, ui: SetupUI, signal: AbortSignal): Promise<boolean> {
  const env = await profileEnvironment(options.directory);
  if (!env) { ui.log(`No teapilot configuration at ${options.directory}. Run teapilot setup first.`); return false; }
  const context = { ...options, api: options.api ?? discordApi, env };
  const screen = ui.screen?.();
  return screen ? (await import('./tabs.js')).tabbedDiscord(context, screen, ui, signal) : linearDiscord(context, ui, signal);
}

export type DiscordSetupContext = DiscordSetupOptions & { api: string; env: Record<string, string> };

/** One question after another: small terminals and scripted interfaces. */
async function linearDiscord({ api, env, directory, cwd }: DiscordSetupContext, ui: SetupUI, signal: AbortSignal): Promise<boolean> {
  ui.log([
    'Discord · Optional',
    'Chat with teapilot on this computer from Discord DMs, or by @mentioning the bot in the channels you choose.',
    'Only the Discord users you allowlist can use it, and teapilot runs only while teapilot discord start is open.',
    'Messages, answers and approval requests pass through Discord. Shell commands and code access still need your approval.',
  ].join('\n'));
  if (!await ui.confirm('Set up Discord access?', signal)) { ui.log('Discord unchanged.'); return false; }

  ui.log(createBot.join('\n'));
  if (!await ui.confirm('Send the token to discord.com to check it?', signal)) { ui.log('Discord unchanged. The token must be checked before it is saved.'); return false; }
  let token: string;
  let application: Application;
  for (;;) {
    token = (await ui.input('Bot token (hidden; Enter to cancel)', undefined, true, signal)).trim();
    if (!token) { ui.log('Discord unchanged.'); return false; }
    if (!validToken(token)) { ui.log('Invalid token. Copy it again without spaces or quotes.'); continue; }
    try { application = await during(ui, 'Checking the bot token...', () => fetchApplication(api, token, signal)); break; }
    catch (error) {
      signal.throwIfAborted();
      ui.log(`Token check: FAIL. ${error instanceof Error ? error.message : 'Check the network.'}`);
    }
  }
  ui.log(`Token check: PASS (${application.name}).`);
  while (!messageContentEnabled(application.flags)) {
    ui.log(intentWarning);
    if (!await ui.confirm('Check again?', signal)) break;
    try { application = await during(ui, 'Checking the bot...', () => fetchApplication(api, token, signal)); }
    catch (error) { signal.throwIfAborted(); ui.log(`Check: FAIL. ${error instanceof Error ? error.message : ''}`); }
    if (messageContentEnabled(application.flags)) ui.log('Message Content Intent: PASS.');
  }

  ui.log('Discord user IDs: enable Developer Mode (Settings → Advanced), then right-click a user → Copy User ID.');
  let operators: string[];
  for (;;) {
    operators = idList(await ui.input('Operator user IDs, with full access (comma-separated)', env.DISCORD_ALLOWED_USER_IDS, false, signal));
    if (operators.length && operators.every(isSnowflake)) break;
    ui.log('Invalid ID. Enter one or more Discord user IDs (17–20 digit numbers).');
  }
  ui.log('In each channel you list, @mentioning the bot starts a thread. Right-click a channel → Copy Channel ID.');
  const saved = savedChannels(env).join(', ');
  let channels: string[];
  for (;;) {
    const answer = (await ui.input(`Channel IDs for @mentions (comma-separated; ${saved ? 'none' : 'Enter'} for DMs only)`, saved || undefined, false, signal)).trim();
    channels = answer.toLowerCase() === 'none' ? [] : idList(answer);
    if (channels.every(isSnowflake)) break;
    ui.log('Invalid ID. Enter channel IDs (17–20 digit numbers), or none for DMs only.');
  }
  let root: string | undefined;
  while (!(root = await resolveRoot(cwd, (await ui.input('Repository root for Discord sessions', env.DISCORD_ROOT ?? cwd, false, signal)).trim()))) ui.log('Enter an existing directory.');
  if (!await singleRepository(root)) ui.log('Note: this is not a single Git repository. Code sessions work best rooted at one repository.');

  const draft: DiscordDraft = { token, application, operators, channels, root };
  ui.log('\nReady to save');
  for (const line of summaryLines(draft, env)) ui.log(line);
  if (!await ui.confirm('Save Discord settings?', signal)) { ui.log('Discord unchanged.'); return false; }
  await saveEnvironment(directory, discordEnvironment(env, draft), signal);
  afterSave(ui, directory, application);
  return true;
}

export async function removeDiscord(directory: string, ui: SetupUI, signal: AbortSignal): Promise<boolean> {
  const env = await profileEnvironment(directory);
  if (!env || !discordKeys.some(key => key in env)) { ui.log('Discord is not configured.'); return true; }
  if (!await ui.confirm('Remove the Discord bot token and settings from this profile?', signal)) { ui.log('Discord unchanged.'); return false; }
  for (const key of discordKeys) delete env[key];
  await saveEnvironment(directory, env, signal);
  ui.log('Discord settings removed. You can also delete the application in the Developer Portal.');
  return true;
}

export async function discordStatus(directory: string, ui: SetupUI, signal: AbortSignal, api = discordApi): Promise<boolean> {
  const env = { ...await profileEnvironment(directory), ...Object.fromEntries(discordKeys.flatMap(key => process.env[key] ? [[key, process.env[key]!]] : [])) };
  let settings;
  try { settings = readDiscordSettings(env); }
  catch (error) { if (error instanceof DiscordNotConfigured) { ui.log(error.message); return false; } throw error; }
  ui.log([
    `Discord: configured (${directory})`,
    `  Operators: ${settings.allowedUserIds.length}`,
    `  Where: ${where(settings.channelIds)}`,
    `  Repository root: ${settings.root}`,
    `  Start mode: ${settings.startMode}`,
  ].join('\n'));
  if (!await ui.confirm('Check the bot token with discord.com?', signal)) { ui.log('Token: not tested.'); return true; }
  try {
    const application = await during(ui, 'Checking the bot token...', () => fetchApplication(api, settings.token, signal));
    ui.log(`Token: PASS (${application.name}).${messageContentEnabled(application.flags) ? '' : ' Message Content Intent: not enabled.'}`);
    return messageContentEnabled(application.flags);
  } catch (error) {
    signal.throwIfAborted();
    ui.log(`Token: FAIL. ${error instanceof Error ? error.message : ''}`);
    return false;
  }
}
