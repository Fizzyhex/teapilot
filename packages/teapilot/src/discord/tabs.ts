import { during } from '../activity.js';
import { singleRepository } from '../execution/grants.js';
import { saveEnvironment } from '../setup/index.js';
import { runTabs, type ScreenTab, type SetupScreen } from '../setup/screen.js';
import type { SetupUI } from '../setup/terminal.js';
import { idList, isSnowflake } from './settings.js';
import { afterSave, createBot, discordEnvironment, fetchApplication, intentWarning, messageContentEnabled, resolveRoot, savedChannels, summaryLines, validToken, type Application, type DiscordDraft, type DiscordSetupContext } from './setup.js';

export const discordTabs: ScreenTab[] = [
  { id: 'bot', label: 'Bot' },
  { id: 'operators', label: 'Operators' },
  { id: 'channels', label: 'Channels' },
  { id: 'root', label: 'Repository' },
  { id: 'save', label: 'Save?' },
];
type TabId = 'bot' | 'operators' | 'channels' | 'root' | 'save';
const order: TabId[] = ['bot', 'operators', 'channels', 'root', 'save'];
type Saved = { saved?: { lines: string[]; application: Application } };
/** A tab returns the tab to open next (the following one when undefined), or ends setup. */
type TabResult = TabId | undefined | Saved;

interface Session {
  context: DiscordSetupContext;
  screen: SetupScreen;
  /** Setup's own signal: saving outlives a tab change. */
  signal: AbortSignal;
  /** The token last checked with discord.com, and what it answered. */
  token?: string;
  application?: Application;
  /** Shown once, the next time Bot opens: why the last token was not accepted. */
  tokenNote?: string;
  operators: string[];
  channels: string[];
  root: string;
}

/**
 * Discord setup as tabs, styled and driven like teapilot setup. Every tab edits the
 * session; nothing is written until Save.
 */
export async function tabbedDiscord(context: DiscordSetupContext, screen: SetupScreen, ui: SetupUI, root: AbortSignal): Promise<boolean> {
  const quit = new AbortController();
  const signal = AbortSignal.any([root, quit.signal]);
  const { env } = context;
  const session: Session = {
    context, screen, signal,
    token: env.DISCORD_BOT_TOKEN,
    operators: idList(env.DISCORD_ALLOWED_USER_IDS).filter(isSnowflake),
    channels: savedChannels(env).filter(isSnowflake),
    root: env.DISCORD_ROOT ?? context.cwd,
  };
  screen.tabs = discordTabs;
  screen.onQuit = () => quit.abort(new Error('Discord setup was closed.'));
  let end: Saved = {};
  try { end = await runTabs<TabId, Saved>(screen, signal, order, (tab, tabSignal) => tabs[tab](session, tabSignal)); }
  catch (error) { if (!quit.signal.aborted) throw error; }
  finally { screen.close(); }
  if (!end.saved) { ui.log('Discord unchanged.'); return false; }
  ui.log('\nSaved settings');
  for (const line of end.saved.lines) ui.log(line);
  afterSave(ui, context.directory, end.saved.application);
  return true;
}

const tabs: Record<TabId, (session: Session, signal: AbortSignal) => Promise<TabResult>> = {
  bot,
  operators: s => editIds(s, 'operators', {
    title: 'Operators', next: 'Continue to Channels', add: 'Add operators', restore: 'Restore saved operators',
    prompt: 'User IDs to add (comma-separated)', invalid: 'Invalid ID. Discord user IDs are 17–20 digit numbers.',
    intro: [
      'Operators have full access: every permission, and the Approve buttons. Other people can be let in later by asking teapilot in Discord.',
      'To copy an ID, enable Developer Mode (Settings → Advanced), then right-click a user → Copy User ID.',
    ],
    empty: 'No operators yet. Add at least one to continue.',
  }),
  channels: s => editIds(s, 'channels', {
    title: 'Channels', next: 'Continue to Repository', add: 'Add channels', restore: 'Restore saved channels',
    prompt: 'Channel IDs to add (comma-separated)', invalid: 'Invalid ID. Discord channel IDs are 17–20 digit numbers.',
    intro: [
      'DMs always work. In each channel listed here, @mentioning the bot starts a thread for the task.',
      'To copy an ID, right-click a channel → Copy Channel ID. The bot needs View Channel, Send Messages and thread permissions there.',
    ],
    empty: 'No channels: DMs only.',
  }),
  root: repository,
  save,
};

async function bot(s: Session, signal: AbortSignal): Promise<TabResult> {
  const { screen } = s;
  screen.log('Chat with teapilot from Discord DMs, or by @mentioning the bot in the channels you choose. Only people you allowlist can use it, and only while teapilot discord start runs.');
  const note = s.tokenNote;
  s.tokenNote = undefined;
  if (s.application) {
    screen.log(`Token check: PASS (${s.application.name}).`);
    const intent = messageContentEnabled(s.application.flags);
    screen.log(intent ? 'Message Content Intent: PASS.' : intentWarning);
    if (note) screen.log(note);
    const choice = await screen.choose('Bot', ['Continue to Operators', 'Check again with discord.com', 'Use a different bot token'], intent ? 0 : 1);
    if (choice === 0) return 'operators';
    if (choice === 1) return await check(s, s.token!, signal);
    return await enterToken(s, signal);
  }
  const saved = s.token !== undefined;
  if (saved) screen.log('This profile has a saved bot token. Check it, or replace it with a new one (Bot → Reset Token).');
  else for (const line of createBot) screen.log(line);
  if (note) screen.log(note);
  const choices = [...saved ? ['Check the saved token with discord.com'] : [], 'Enter a bot token and check it with discord.com', 'Leave without saving'];
  const choice = await screen.choose('Bot', choices, 0);
  if (choice === choices.length - 1) return await leave(s, 'bot');
  if (saved && choice === 0) return await check(s, s.token!, signal);
  return await enterToken(s, signal);
}

async function enterToken(s: Session, signal: AbortSignal): Promise<TabResult> {
  const token = (await s.screen.input('Bot token (hidden; Enter to go back)', undefined, true)).trim();
  if (!token) return 'bot';
  if (!validToken(token)) { s.tokenNote = 'Invalid token. Copy it again without spaces or quotes.'; return 'bot'; }
  return await check(s, token, signal);
}

/** Check a token with discord.com; continue to Operators once it is ready to use. */
async function check(s: Session, token: string, signal: AbortSignal): Promise<TabResult> {
  let application: Application;
  try { application = await during(s.screen, 'Checking the bot token...', () => fetchApplication(s.context.api, token, signal)); }
  catch (error) {
    signal.throwIfAborted();
    s.tokenNote = `Token check: FAIL. ${error instanceof Error ? error.message : 'Check the network.'}`;
    s.screen.mark('bot', 'attention');
    return 'bot';
  }
  s.token = token; s.application = application;
  const intent = messageContentEnabled(application.flags);
  s.screen.mark('bot', !intent ? 'attention' : token !== s.context.env.DISCORD_BOT_TOKEN ? 'changed' : undefined);
  return intent ? 'operators' : 'bot';
}

const same = (a: string[], b: string[]) => [...a].sort().join() === [...b].sort().join();

interface ListText { title: string; intro: string[]; next: string; add: string; restore: string; prompt: string; invalid: string; empty: string }

/** A list of Discord IDs, edited one choice at a time like Usage limits. */
async function editIds(s: Session, list: 'operators' | 'channels', text: ListText): Promise<TabResult> {
  const { screen } = s;
  const saved = list === 'operators' ? idList(s.context.env.DISCORD_ALLOWED_USER_IDS) : savedChannels(s.context.env);
  const required = list === 'operators';
  let note: string | undefined;
  for (;;) {
    screen.clear();
    for (const line of text.intro) screen.log(line);
    const current = s[list];
    if (!current.length) screen.log(text.empty);
    if (note) screen.log(note);
    note = undefined;
    const choices = [text.next, ...current.map(id => `Remove ${id}`), text.add, ...same(current, saved) ? [] : [text.restore]];
    const choice = await screen.choose(text.title, choices, current.length || !required ? 0 : current.length + 1);
    if (choice === 0) {
      if (!required || current.length) return undefined;
      continue;
    }
    if (choice <= current.length) {
      s[list] = current.filter((_, index) => index !== choice - 1);
      note = `Removed ${current[choice - 1]}.`;
    } else if (choice === current.length + 1) {
      const added = idList(await screen.input(text.prompt));
      if (!added.every(isSnowflake)) note = text.invalid;
      else if (added.length) { s[list] = [...new Set([...current, ...added])]; note = `Added ${added.join(', ')}.`; }
    } else s[list] = [...saved];
    screen.mark(list, required && !s[list].length ? 'attention' : same(s[list], saved) ? undefined : 'changed');
  }
}

async function repository(s: Session): Promise<TabResult> {
  const { screen } = s;
  screen.log('This will be the default directory for sessions in coding mode - activated with `/mode code`.');
  let note: string | undefined;
  for (;;) {
    // A choice first, like the other tabs, so ←/→ still switch tabs; the text box opens only on request.
    screen.log(`Current: ${s.root}`);
    if (note) screen.log(note);
    if (await screen.choose('Repository', ['Next tab', 'Change directory'], 0) === 0) return 'save';
    const root = await resolveRoot(s.context.cwd, await screen.input('Repository root for Discord sessions', s.root));
    screen.clear();
    screen.log('This will be the default directory for sessions in coding mode - activated with `/mode code`.');
    if (!root) { note = 'Could not find that directory. Enter an existing one.'; continue; }
    s.root = root;
    screen.mark('root', root.replace(/\\/g, '/') === s.context.env.DISCORD_ROOT ? undefined : 'changed');
    note = await singleRepository(root) ? undefined : `Note: ${root} is not a single Git repository! Code sessions work best rooted at one repository.`;
  }
}

async function save(s: Session): Promise<TabResult> {
  const { screen, context } = s;
  const root = await resolveRoot(context.cwd, s.root);
  const problems: [string, TabId][] = [
    ...s.application ? [] : [[s.token ? 'The bot token has not been checked with discord.com yet.' : 'No bot token yet.', 'bot'] as [string, TabId]],
    ...s.operators.length ? [] : [['No operators yet. Add at least one.', 'operators'] as [string, TabId]],
    ...root ? [] : [[`Could not find ${s.root}. Choose an existing directory.`, 'root'] as [string, TabId]],
  ];
  if (problems.length) {
    for (const [problem] of problems) screen.log(problem);
    const target = problems[0]![1];
    const choice = await screen.choose('Save?', [`Open ${discordTabs.find(tab => tab.id === target)!.label}`, 'Leave without saving'], 0);
    return choice === 0 ? target : await leave(s, 'save');
  }
  const draft: DiscordDraft = { token: s.token!, application: s.application!, operators: s.operators, channels: s.channels, root: root! };
  const lines = summaryLines(draft, context.env);
  for (const line of lines) screen.log(line);
  if (!messageContentEnabled(draft.application.flags)) screen.log(intentWarning);
  const changed = discordTabs.filter(tab => tab.id !== 'save' && screen.markOf(tab.id) === 'changed').map(tab => tab.label);
  screen.log(changed.length ? `Changed: ${changed.join(', ')}.` : 'Nothing has changed yet. Use ←/→ to revisit any tab.');
  const choice = await screen.choose(context.env.DISCORD_BOT_TOKEN ? 'Save these Discord settings? They replace the current ones.' : 'Save these Discord settings?', ['Save settings', 'Leave without saving'], 0);
  if (choice === 1) return await leave(s, 'save');
  // Saving is never interrupted by a tab change.
  await screen.lock('Saving Discord settings...', () => saveEnvironment(context.directory, discordEnvironment(context.env, draft), s.signal));
  return { saved: { lines, application: draft.application } };
}

async function leave(s: Session, back: TabId): Promise<TabResult> {
  return await s.screen.confirm('Leave without saving?') ? {} : back;
}
