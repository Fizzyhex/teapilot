import { readFile, realpath, stat } from 'node:fs/promises';
import { resolve } from 'node:path';
import { parse } from 'dotenv';
import { during } from '../activity.js';
import { exists } from '../config.js';
import { singleRepository } from '../execution/grants.js';
import { saveEnvironment } from '../setup/index.js';
import type { SetupUI } from '../setup/terminal.js';
import { discordKeys, DiscordNotConfigured, isSnowflake, readDiscordSettings } from './settings.js';

export const discordApi = 'https://discord.com/api/v10';
const intents = { messageContent: 1 << 18, messageContentLimited: 1 << 19 };
/** The minimum the bot needs: read and answer in the configured channel and its threads. */
const permissions = { viewChannel: 1n << 10n, sendMessages: 1n << 11n, readMessageHistory: 1n << 16n, createPublicThreads: 1n << 35n, sendMessagesInThreads: 1n << 38n };
export const invitePermissions = Object.values(permissions).reduce((total, bit) => total | bit, 0n);
export const inviteUrl = (applicationId: string) => `https://discord.com/oauth2/authorize?client_id=${applicationId}&scope=bot&permissions=${invitePermissions}`;

export interface DiscordSetupOptions { directory: string; cwd: string; api?: string }
interface Application { id: string; name: string; flags: number }

export async function fetchApplication(api: string, token: string, signal: AbortSignal): Promise<Application> {
  const response = await fetch(`${api}/oauth2/applications/@me`, { headers: { Authorization: `Bot ${token}` }, signal });
  if (response.status === 401) throw new Error('Discord rejected the token. Copy it again from Bot → Reset Token.');
  if (!response.ok) throw new Error(`Discord answered HTTP ${response.status}.`);
  const body = await response.json() as Partial<Application>;
  if (typeof body.id !== 'string') throw new Error('Discord returned an unexpected response.');
  return { id: body.id, name: String(body.name ?? 'application'), flags: Number(body.flags ?? 0) };
}
const messageContentEnabled = (flags: number) => Boolean(flags & (intents.messageContent | intents.messageContentLimited));

async function profileEnvironment(directory: string): Promise<Record<string, string> | undefined> {
  const path = resolve(directory, '.env');
  return await exists(path) ? parse(await readFile(path)) : undefined;
}

/** The opt-in Discord sequence. Nothing is saved until the final confirmation. */
export async function configureDiscord(options: DiscordSetupOptions, ui: SetupUI, signal: AbortSignal): Promise<boolean> {
  const api = options.api ?? discordApi;
  const env = await profileEnvironment(options.directory);
  if (!env) { ui.log(`No teapilot configuration at ${options.directory}. Run teapilot setup first.`); return false; }
  ui.log([
    'Discord · Optional',
    'Chat with teapilot on this computer from Discord DMs, or by @mentioning the bot in one channel.',
    'Only the Discord users you allowlist can use it, and teapilot runs only while teapilot discord start is open.',
    'Messages, answers and approval requests pass through Discord. Shell commands and code access still need your approval.',
  ].join('\n'));
  if (!await ui.confirm('Set up Discord access?', signal)) { ui.log('Discord unchanged.'); return false; }

  ui.log([
    'Create a bot at https://discord.com/developers/applications:',
    '  1. New Application, then open Bot.',
    '  2. Reset Token and copy it.',
    '  3. Under Privileged Gateway Intents, enable Message Content Intent and save.',
  ].join('\n'));
  if (!await ui.confirm('Send the token to discord.com to check it?', signal)) { ui.log('Discord unchanged. The token must be checked before it is saved.'); return false; }
  let token: string;
  let application: Application;
  for (;;) {
    token = (await ui.input('Bot token (hidden; Enter to cancel)', undefined, true, signal)).trim();
    if (!token) { ui.log('Discord unchanged.'); return false; }
    if (/[\s"\\]/.test(token)) { ui.log('Invalid token. Copy it again without spaces or quotes.'); continue; }
    try { application = await during(ui, 'Checking the bot token...', () => fetchApplication(api, token, signal)); break; }
    catch (error) {
      signal.throwIfAborted();
      ui.log(`Token check: FAIL. ${error instanceof Error ? error.message : 'Check the network.'}`);
    }
  }
  ui.log(`Token check: PASS (${application.name}).`);
  while (!messageContentEnabled(application.flags)) {
    ui.log('Message Content Intent: not enabled. Without it, messages reach teapilot empty. Enable it under Bot → Privileged Gateway Intents.');
    if (!await ui.confirm('Check again?', signal)) break;
    try { application = await during(ui, 'Checking the bot...', () => fetchApplication(api, token, signal)); }
    catch (error) { signal.throwIfAborted(); ui.log(`Check: FAIL. ${error instanceof Error ? error.message : ''}`); }
    if (messageContentEnabled(application.flags)) ui.log('Message Content Intent: PASS.');
  }

  ui.log('Discord user IDs: enable Developer Mode (Settings → Advanced), then right-click a user → Copy User ID.');
  let allowed: string[];
  for (;;) {
    allowed = (await ui.input('Operator user IDs, with full access (comma-separated)', env.DISCORD_ALLOWED_USER_IDS, false, signal)).split(/[\s,]+/).filter(Boolean);
    if (allowed.length && allowed.every(isSnowflake)) break;
    ui.log('Enter one or more Discord user IDs (17–20 digit numbers).');
  }
  let channel: string;
  for (;;) {
    channel = (await ui.input('Channel ID for @mentions (Enter for DMs only)', undefined, false, signal)).trim();
    if (!channel || isSnowflake(channel)) break;
    ui.log('Enter a channel ID (right-click the channel → Copy Channel ID), or press Enter for DMs only.');
  }
  let root: string;
  for (;;) {
    const answer = (await ui.input('Repository root for Discord sessions', env.DISCORD_ROOT ?? options.cwd, false, signal)).trim();
    try {
      root = await realpath(resolve(options.cwd, answer || options.cwd));
      if (!(await stat(root)).isDirectory()) throw new Error();
      break;
    } catch { ui.log('Enter an existing directory.'); }
  }
  if (!await singleRepository(root)) ui.log('Note: this is not a single Git repository. Code sessions work best rooted at one repository.');

  ui.log([
    'Ready to save',
    `  Bot: ${application.name}`,
    `  Operators: ${allowed.join(', ')}`,
    `  Where: DMs${channel ? ` and @mentions in channel ${channel} (each task gets a thread)` : ' only'}`,
    `  Repository root: ${root}`,
    '  Sessions start in ask mode; /mode code, shell commands and large overwrites ask for button approval.',
  ].join('\n'));
  if (!await ui.confirm('Save Discord settings?', signal)) { ui.log('Discord unchanged.'); return false; }
  const next: Record<string, string> = { ...env, DISCORD_BOT_TOKEN: token, DISCORD_ALLOWED_USER_IDS: allowed.join(','), DISCORD_ROOT: root.replace(/\\/g, '/'), DISCORD_START_MODE: env.DISCORD_START_MODE ?? 'ask' };
  if (channel) next.DISCORD_CHANNEL_ID = channel; else delete next.DISCORD_CHANNEL_ID;
  await saveEnvironment(options.directory, next, signal);
  ui.log('Discord settings saved.');
  ui.log(`Invite the bot to a server you share with the allowed users (needed for DMs too):\n  ${inviteUrl(application.id)}`);
  ui.log(`Next: teapilot discord start --config-dir "${options.directory}"`);
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
    `  Where: DMs${settings.channelId ? ` and channel ${settings.channelId}` : ' only'}`,
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
