import { realpath } from 'node:fs/promises';
import { loadConfig } from '../config.js';
import { SessionGrants } from '../execution/grants.js';
import { runHost } from '../host.js';
import type { SetupUI } from '../setup/terminal.js';
import { route, routeReply } from './access.js';
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
  const queue = new TurnQueue();
  const conversations = new Map<string, Conversation>();

  const open = async (key: string, transport: DiscordTransport, oneShot = false): Promise<Conversation> => {
    const existing = conversations.get(key);
    if (existing?.active) return existing;
    const authorization = await SessionGrants.create(root, config, settings.startMode);
    const conversation = new Conversation({
      key, transport, queue, redact, log,
      // A one-shot answers through a Discord interaction, which stops working after 15 minutes.
      once: oneShot,
      request: { prompt: '', cwd: root, mode: settings.startMode, authorization, signal: oneShot ? AbortSignal.any([signal, AbortSignal.timeout(interactionLifetimeMs)]) : signal },
      maxPromptChars: config.policy.limits.maxPromptChars,
      run: (request, dependencies) => runHost(config, request, dependencies),
    });
    conversations.set(key, conversation);
    return conversation;
  };

  const handle = async (message: GatewayMessage): Promise<void> => {
    const target = route(message, settings);
    if (!target) return;
    if (!message.content) { await message.transport().send('teapilot reads text messages only.'); return; }
    const chain = await message.replyChain();
    const prompt = chain.length ? quoteMessage({ author: message.authorName, text: message.content }, chain) : message.content;
    let key = target.key;
    let transport: DiscordTransport;
    if (target.kind === 'new-thread') {
      const thread = await message.startThread(message.content);
      key = `thread:${thread.id}`; transport = thread.transport;
    } else transport = message.transport();
    log(`${key} @${message.authorName}: ${message.content.split('\n')[0]!.slice(0, 80)}`);
    (await open(key, transport)).push(prompt);
  };
  const handleCommand = async (command: GatewayCommand): Promise<void> => {
    const target = route(command, settings);
    if (!target) { await command.respond('You are not allowed to use teapilot here.'); return; }
    const conversation = conversations.get(target.key);
    if (!conversation?.active) { await command.respond('No active conversation here. Send a message to start one.'); return; }
    log(`${target.key}: ${command.text}`);
    conversation.push(command.text);
    await command.respond();
  };
  const handleReply = async (reply: GatewayReply): Promise<void> => {
    const target = routeReply(reply, settings);
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
    (await open(key, transport, reply.oneShot)).push(reply.content, { answerOnly: reply.answerOnly });
  };
  const failed = (what: string) => (error: unknown) => log(`${what} failed: ${error instanceof Error ? error.message : String(error)}`);
  // discord.js loads only here, so every other command starts without it.
  const { connect } = await import('./gateway.js');
  const gateway = await connect(settings, {
    message: message => void handle(message).catch(failed('Message handling')),
    command: command => void handleCommand(command).catch(failed('Command handling')),
    reply: reply => void handleReply(reply).catch(failed('Reply handling')),
  }, log);

  log(`Connected as ${gateway.botName}. Listening to ${settings.allowedUserIds.length} allowed user(s) in DMs${settings.channelId ? ` and channel ${settings.channelId}` : ''}.`);
  log(`Repository root: ${root}. Sessions start in ${settings.startMode} mode. Press Ctrl+C to stop.`);
  if (!signal.aborted) await new Promise(resolve => signal.addEventListener('abort', resolve, { once: true }));
  log('Stopping: pending approvals are denied.');
  await gateway.close();
  await Promise.allSettled([...conversations.values()].map(conversation => conversation.done));
  return true;
}
