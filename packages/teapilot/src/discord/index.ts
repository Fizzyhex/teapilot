import { realpath } from 'node:fs/promises';
import { loadConfig } from '../config.js';
import { SessionGrants } from '../execution/grants.js';
import { runHost } from '../host.js';
import { headlessTeachat, openHeadlessTeachat } from '../teachat/session.js';
import type { SetupUI } from '../setup/terminal.js';
import { route, routeReply } from './access.js';
import { AccessStore } from './access-store.js';
import { Conversation, TurnQueue, type DiscordTransport } from './bridge.js';
import type { GatewayCommand, GatewayMessage, GatewayReply } from './gateway.js';
import { interactionLifetimeMs } from './commands.js';
import { quoteMessage } from './render.js';
import { configureDiscord, discordStatus, removeDiscord } from './setup.js';
import { readDiscordSettings } from './settings.js';

export const discordActions = ['setup', 'start', 'status', 'remove'] as const;
export interface DiscordCommand { directory: string; cwd: string; ui: SetupUI; signal: AbortSignal }

/** teapilot discord setup|start|status|remove — opt-in, separate from teapilot setup. */
export async function discord(action: string, options: DiscordCommand): Promise<boolean> {
  if (action === 'setup') return configureDiscord(options, options.ui, options.signal);
  if (action === 'status') return discordStatus(options.directory, options.ui, options.signal);
  if (action === 'remove') return removeDiscord(options.directory, options.ui, options.signal);
  if (action === 'start') return startDiscord(options);
  throw new Error(`Use teapilot discord ${discordActions.join('|')}.`);
}

async function startDiscord({ directory, ui, signal }: DiscordCommand): Promise<boolean> {
  const env = { ...process.env };
  const config = await loadConfig(directory, env);
  const settings = readDiscordSettings(env);
  let root: string;
  try { root = await realpath(settings.root); }
  catch { throw new Error(`Discord repository root ${settings.root} is unavailable. Run teapilot discord setup.`); }
  const secrets = [settings.token, config.router.apiKey, ...Object.values(config.secrets)].filter((value): value is string => Boolean(value));
  const redact = (text: string) => secrets.reduce((result, secret) => result.split(secret).join('[REDACTED]'), text);
  const log = (text: string) => ui.log(`${new Date().toLocaleTimeString()} ${redact(text)}`);
  // Operators come from setup; whitelisted users and temporary grants live in the state directory.
  const access = AccessStore.at(config.stateDir, settings.allowedUserIds, config.policy.permissions);
  const allowed = (id: string) => access.roleOf(id) !== undefined;
  const queue = new TurnQueue();
  const conversations = new Map<string, Conversation>();
  const teachat = await openHeadlessTeachat(config, log);

  const open = async (key: string, transport: DiscordTransport, oneShot = false): Promise<Conversation> => {
    const existing = conversations.get(key);
    if (existing?.active) return existing;
    const authorization = await SessionGrants.create(root, config, settings.startMode);
    const conversation = new Conversation({
      key, transport, queue, redact, log, access,
      // A one-shot answers through a Discord interaction, which stops working after 15 minutes.
      once: oneShot,
      request: { prompt: '', cwd: root, mode: settings.startMode, authorization, signal: oneShot ? AbortSignal.any([signal, AbortSignal.timeout(interactionLifetimeMs)]) : signal },
      maxPromptChars: config.policy.limits.maxPromptChars,
      run: (request, dependencies) => teachat ? teachat.work(() => runHost(config, request, dependencies)) : runHost(config, request, dependencies),
      extension: teachat && headlessTeachat(teachat, key),
    });
    conversations.set(key, conversation);
    return conversation;
  };

  const handle = async (message: GatewayMessage): Promise<void> => {
    const target = route(message, settings, allowed);
    if (!target) return;
    access.rememberName(message.authorId, message.authorName);
    if (!message.content) { await message.transport().send('teapilot reads text messages only.'); return; }
    // A running conversation already holds its earlier turns, so only a new one needs the reply chain.
    const chain = target.kind === 'new-thread' || !conversations.get(target.key)?.active ? await message.replyChain() : undefined;
    const prompt = chain && (chain.messages.length || chain.truncated) ? quoteMessage({ author: message.authorName, text: message.content }, chain) : message.content;
    let key = target.key;
    let transport: DiscordTransport;
    if (target.kind === 'new-thread') {
      const thread = await message.startThread(message.content);
      key = `thread:${thread.id}`; transport = thread.transport;
    } else transport = message.transport();
    log(`${key} @${message.authorName}: ${message.content.split('\n')[0]!.slice(0, 80)}`);
    (await open(key, transport)).push(prompt, { sender: message.authorId });
  };
  const handleCommand = async (command: GatewayCommand): Promise<void> => {
    const target = route(command, settings, allowed);
    if (!target) { await command.respond('You are not allowed to use teapilot here.'); return; }
    const conversation = conversations.get(target.key);
    if (!conversation?.active) { await command.respond('No active conversation here. Send a message to start one.'); return; }
    log(`${target.key}: ${command.text}`);
    conversation.push(command.text, { sender: command.authorId });
    await command.respond();
  };
  const handleReply = async (reply: GatewayReply): Promise<void> => {
    const target = routeReply(reply, settings, allowed);
    if (!target) { await reply.respond('You are not allowed to use teapilot here.'); return; }
    if (!reply.content) { await reply.respond('teapilot reads text messages only.'); return; }
    let key = target.key;
    let transport: DiscordTransport;
    if (reply.oneShot) {
      key = `reply:${reply.id}`; transport = reply.transport();
    } else if (target.kind === 'new-thread') {
      try {
        const thread = await reply.startThread(reply.title);
        key = `thread:${thread.id}`; transport = thread.transport;
      } catch (error) {
        await reply.respond(`teapilot could not start a thread here: ${error instanceof Error ? error.message : String(error)}`);
        return;
      }
    } else transport = reply.transport();
    await reply.respond();
    log(`${key} @${reply.authorName} (reply): ${reply.title.split('\n')[0]!.slice(0, 80)}`);
    (await open(key, transport, reply.oneShot)).push(reply.content, { answerOnly: reply.answerOnly, sender: reply.authorId });
  };
  const failed = (what: string) => (error: unknown) => log(`${what} failed: ${error instanceof Error ? error.message : String(error)}`);
  // discord.js loads only here, so every other command starts without it.
  const { connect } = await import('./gateway.js');
  const gateway = await connect(settings, {
    message: message => void handle(message).catch(failed('Message handling')),
    command: command => void handleCommand(command).catch(failed('Command handling')),
    reply: reply => void handleReply(reply).catch(failed('Reply handling')),
  }, log);

  access.lookup = gateway.username;
  log(`Connected as ${gateway.botName}. Listening to ${settings.allowedUserIds.length} operator(s) and ${access.list().users.length} user(s) in DMs${settings.channelId ? ` and channel ${settings.channelId}` : ''}.`);
  log(`Repository root: ${root}. Sessions start in ${settings.startMode} mode. Press Ctrl+C to stop.`);
  if (!signal.aborted) await new Promise(resolve => signal.addEventListener('abort', resolve, { once: true }));
  log('Stopping: pending approvals are denied.');
  await gateway.close();
  await Promise.allSettled([...conversations.values()].map(conversation => conversation.done));
  await teachat?.close();
  return true;
}
