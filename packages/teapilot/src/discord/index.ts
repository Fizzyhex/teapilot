import { realpath } from 'node:fs/promises';
import { loadConfig, type Config } from '../config.js';
import { SessionGrants } from '../execution/grants.js';
import { runHost, type HostRequest } from '../host.js';
import { headlessTeachat, openHeadlessTeachat } from '../teachat/session.js';
import type { SetupUI } from '../setup/terminal.js';
import { route, routeReply } from './access.js';
import { AccessStore } from './access-store.js';
import { HistoryStore } from './history-store.js';
import { SeatStore, type Seat } from './seat-store.js';
import { Conversation, TurnQueue, type DiscordTransport } from './bridge.js';
import { pictures } from './files.js';
import { receiveFiles } from '../workspace/attach.js';
import { SrtSandbox } from '../workspace/sandbox.js';
import { WorkspaceStore } from '../workspace/store.js';
import { consultant } from './play/consult.js';
import { PlayRuntime, type Clock, type PlaySurface } from './play/runtime.js';
import { PlayStore } from './play/store.js';
import type { connect, GatewayCommand, GatewayMessage, GatewayReply } from './gateway.js';
import { interactionLifetimeMs, setupCommands, type PromptSetup } from './commands.js';
import { quoteMessage } from './render.js';
import { configureDiscord, discordStatus, removeDiscord } from './setup.js';
import { readDiscordSettings, type DiscordSettings } from './settings.js';

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
  // discord.js loads only here, so every other command starts without it.
  const gateway = await import('./gateway.js');
  await serveDiscord({ config, settings, log: text => ui.log(`${new Date().toLocaleTimeString()} ${text}`), signal, connect: gateway.connect });
  return true;
}

/** Everything `teapilot discord start` runs once settings are read; the Discord simulator supplies its own `connect`. */
export interface DiscordServer {
  config: Config;
  settings: DiscordSettings;
  /** The operator log; lines arrive redacted. */
  log: (text: string) => void;
  signal: AbortSignal;
  connect: typeof connect;
  /** Where the access list and app records live; the profile's state directory by default. */
  stateDir?: string;
  clock?: Clock;
  teachat?: boolean;
}

/** Connects and serves Discord until `signal` aborts. */
export async function serveDiscord({ config, settings, signal, connect, clock, stateDir = config.stateDir, teachat: withTeachat = true, ...options }: DiscordServer): Promise<void> {
  let root: string;
  try { root = await realpath(settings.root); }
  catch { throw new Error(`Discord repository root ${settings.root} is unavailable. Run teapilot discord setup.`); }
  const secrets = [settings.token, config.router.apiKey, ...Object.values(config.secrets)].filter((value): value is string => Boolean(value));
  const redact = (text: string) => secrets.reduce((result, secret) => result.split(secret).join('[REDACTED]'), text);
  const log = (text: string) => options.log(redact(text));
  // Operators come from setup; whitelisted users and temporary grants live in the state directory.
  const access = AccessStore.at(stateDir, settings.allowedUserIds, config.policy.permissions);
  const allowed = (id: string) => access.roleOf(id) !== undefined;
  const queue = new TurnQueue();
  const conversations = new Map<string, Conversation>();
  const histories = HistoryStore.at(stateDir);
  const teachat = withTeachat ? await openHeadlessTeachat(config, log) : undefined;
  const run = (request: HostRequest, dependencies: Parameters<typeof runHost>[2]) => teachat ? teachat.work(() => runHost(config, request, dependencies)) : runHost(config, request, dependencies);
  // The surface is bound once the gateway connects; apps only post after a message arrives or on recovery, both later.
  let surface: PlaySurface | undefined;
  const connected = () => { if (!surface) throw new Error('Discord is not connected yet.'); return surface; };
  const files = WorkspaceStore.at(stateDir);
  const sandbox = new SrtSandbox(stateDir, config.workspace, config.source?.directory);
  void sandbox.status().then(status => log(status.available
    ? `Workspace commands run sandboxed with ${status.tools.map(tool => tool.name).join(', ') || 'no media tools found'}.`
    : `Workspace commands are off: ${status.reason}`));
  const play = new PlayRuntime({
    store: PlayStore.at(stateDir), log, clock, pictures: pictures(files),
    surface: { post: (...args) => connected().post(...args), edit: (...args) => connected().edit(...args), request: (...args) => connected().request(...args) },
    consult: consultant({ config, root, access, queue, run, signal }),
  });

  /**
   * Where teapilot cannot post, each /reply, /prompt or /collab is its own one-shot conversation, since it answers
   * through that interaction. They continue a saved history: each person's own in a channel, so nobody sees or
   * steers another's, or with /collab the one everyone there shares. `seats` records which one each person is in.
   */
  const historyKeyOf = (channelId: string, userId: string, seat: Seat) => seat === 'collab' ? `collab:${channelId}` : `reply:${channelId}:${userId}`;
  const seats = SeatStore.at(stateDir);
  /** The latest one-shot work per history; the next waits for it so neither overwrites the other's turns. */
  const tails = new Map<string, Promise<void>>();
  /** One-shot conversations still running, by history, so /stop can reach them. */
  const runningOneShots = new Map<string, Conversation>();
  const enqueue = (historyKey: string, task: () => Promise<void>): Promise<void> => {
    const turn = (tails.get(historyKey) ?? Promise.resolve()).then(task);
    const tail = turn.catch(() => undefined);
    tails.set(historyKey, tail);
    void tail.then(() => { if (tails.get(historyKey) === tail) tails.delete(historyKey); });
    return turn;
  };
  /**
   * Takes someone out of `seat` at once. Their own conversation's history goes once its running turn ends; a collab's
   * stays for the others, and goes only when the last person has left.
   */
  const leave = (channelId: string, userId: string, seat: Seat): Promise<void> => {
    seats.sit(channelId, userId, undefined);
    const historyKey = historyKeyOf(channelId, userId, seat);
    // Decided now: whoever joins after the last person left starts with a clean collab.
    if (seat === 'collab' && seats.collaborators(channelId)) return Promise.resolve();
    return enqueue(historyKey, async () => {
      histories.save(historyKey, []);
      seats.remember(historyKey, undefined);
    });
  };
  const seatName = (seat: Seat) => seat === 'solo' ? 'your own conversation' : 'the collab';
  const switchNote = (from: Seat) => from === 'solo'
    ? 'You already have your own conversation with teapilot in this channel. Run /clear to end it before joining the collab, or switch here: your conversation and its history are cleared.'
    : 'You are in this channel\'s collab. Run /clear to leave it before starting your own conversation, or switch here: the collab carries on for everyone else.';

  /**
   * `channelId` is where discord.play apps run; a one-shot posts them through its interaction. `setup` only shapes a new
   * conversation; access still starts from the configured mode, so a chosen Code mode asks for it when needed.
   * `historyKey` is where turns are kept, the conversation's own key unless a one-shot shares a history.
   */
  const open = async (key: string, transport: DiscordTransport, { channelId, oneShot = false, setup = {}, historyKey = key }: { channelId?: string; oneShot?: boolean; setup?: PromptSetup; historyKey?: string } = {}): Promise<Conversation> => {
    const existing = conversations.get(key);
    if (existing?.active) return existing;
    const authorization = await SessionGrants.create(root, config, settings.startMode);
    const conversation = new Conversation({
      key, transport, queue, redact, log, access, files, sandbox,
      // A one-shot answers through a Discord interaction, which stops working after 15 minutes.
      once: oneShot,
      request: { prompt: '', cwd: root, mode: setup.mode ?? settings.startMode, tier: setup.tier, authorization, signal: oneShot ? AbortSignal.any([signal, AbortSignal.timeout(interactionLifetimeMs)]) : signal,
        // A conversation picks up where it was before a restart, or where the last one-shot in its history left off.
        history: histories.load(historyKey) },
      onHistory: history => { try { histories.save(historyKey, history); } catch (error) { log(`${historyKey}: history not saved: ${error instanceof Error ? error.message : String(error)}`); } },
      maxPromptChars: config.policy.limits.maxPromptChars,
      run,
      extension: teachat && headlessTeachat(teachat, key),
      // A one-shot posts apps through its interaction, and later one-shots in the same history manage them.
      play: { runtime: play, conversation: historyKey, ...(!oneShot ? { channelId } : transport.postApp ? { channelId, post: payload => transport.postApp!(payload) } : {}) },
    });
    conversations.set(key, conversation);
    return conversation;
  };

  /** Keeps a message's attachments in the conversation's workspace and says what arrived, for the prompt. */
  const receive = async (conversation: string, message: Pick<GatewayMessage, 'attachments' | 'authorName'>, room: number): Promise<string> => {
    const incoming = message.attachments.map(attachment => ({ name: attachment.name, size: attachment.size, type: attachment.contentType, data: () => attachment.download() }));
    const notes = await receiveFiles(files, conversation, incoming, message.authorName, room);
    if (notes) log(`${conversation}: kept ${message.attachments.length} attachment(s) from @${message.authorName}`);
    return notes;
  };

  const handle = async (message: GatewayMessage): Promise<void> => {
    const target = route(message, settings, allowed);
    if (!target) return;
    access.rememberName(message.authorId, message.authorName);
    if (!message.content && !message.attachments.length) { await message.transport().send('teapilot reads text messages and attachments only.'); return; }
    // A running conversation already holds its earlier turns, so only a new one needs the reply chain.
    const chain = target.kind === 'new-thread' || !conversations.get(target.key)?.active ? await message.replyChain() : undefined;
    let prompt = chain && (chain.messages.length || chain.truncated) ? quoteMessage({ author: message.authorName, text: message.content }, chain) : message.content;
    let key = target.key;
    let channelId = message.channelId;
    let transport: DiscordTransport;
    if (target.kind === 'new-thread') {
      const thread = await message.startThread(message.content);
      key = `thread:${thread.id}`; transport = thread.transport; channelId = thread.id;
    } else transport = message.transport();
    // Files belong to the conversation they arrive in, a new thread included; its apps show them.
    if (message.attachments.length) {
      const notes = await receive(key, message, config.policy.limits.maxPromptChars - prompt.length - 1500);
      prompt = [prompt, notes].filter(Boolean).join('\n\n');
    }
    log(`${key} @${message.authorName}: ${message.content.split('\n')[0]!.slice(0, 80)}`);
    (await open(key, transport, { channelId })).push(prompt, { sender: message.authorId, senderName: message.authorName });
  };
  const handleCommand = async (command: GatewayCommand): Promise<void> => {
    const target = route(command, settings, allowed);
    const conversation = target && conversations.get(target.key);
    if (target && conversation?.active) {
      log(`${target.key}: ${command.text}`);
      conversation.push(command.text, { sender: command.authorId });
      await command.respond();
      return;
    }
    if (command.authorIsBot || !allowed(command.authorId)) { await command.respond('You are not allowed to use teapilot here.'); return; }
    // Nothing runs here, so /clear and /stop act on the conversation /reply, /prompt or /collab keeps for this person.
    const seat = seats.seat(command.channelId, command.authorId);
    if (command.text === '/exit' && seat) {
      void leave(command.channelId, command.authorId, seat).catch(failed('Clearing'));
      log(`${historyKeyOf(command.channelId, command.authorId, seat)}: ${command.authorId} cleared ${seat}`);
      await command.respond(seat === 'solo' ? 'Ended your conversation here and cleared its history.'
        : seats.collaborators(command.channelId) ? 'Left the collab. Its history stays for everyone still in it.' : 'Left the collab. You were the last one in it, so its history was cleared.');
      return;
    }
    if (command.text === '/exit' && target?.key) {
      // A conversation that is not running, such as one from before a restart, still has saved history to clear.
      histories.save(target.key, []);
      await command.respond('Cleared this conversation\'s history.');
      return;
    }
    if (command.text === '/stop' && seat) {
      const turn = runningOneShots.get(historyKeyOf(command.channelId, command.authorId, seat));
      if (!turn?.active) { await command.respond('Nothing is running.'); return; }
      turn.push('/stop', { sender: command.authorId });
      await command.respond();
      return;
    }
    await command.respond(target ? 'No active conversation here. Send a message to start one.' : 'You are not in a conversation with teapilot here.');
  };
  const handleReply = async (reply: GatewayReply): Promise<void> => {
    const target = routeReply(reply, settings, allowed);
    if (!target) { await reply.respond('You are not allowed to use teapilot here.'); return; }
    if (!reply.content) { await reply.respond('teapilot reads text messages only.'); return; }
    /** The prompt with notes on the files that came with it, which are kept in the conversation's workspace. */
    const prompt = async (workspace: string) => reply.attachments.length
      ? [reply.content, await receive(workspace, reply, config.policy.limits.maxPromptChars - reply.content.length - 1500)].filter(Boolean).join('\n\n')
      : reply.content;
    const from = { answerOnly: reply.answerOnly, sender: reply.authorId, senderName: reply.authorName, yolo: reply.yolo };
    if (reply.oneShot) {
      const seat: Seat = reply.collab ? 'collab' : 'solo';
      const current = seats.seat(reply.channelId, reply.authorId);
      let transport: DiscordTransport;
      if (current && current !== seat) {
        // Nobody is in both: offer to leave the current conversation, then send the prompt where it was meant to go.
        const click = await reply.choose(switchNote(current), [current === 'solo' ? 'Clear it and join the collab' : 'Leave the collab', 'Stay']);
        if (!click) return;
        if (click.choice !== 0) { await click.settle(`You stayed in ${seatName(current)}. Your prompt was not sent.`); return; }
        void leave(reply.channelId, reply.authorId, current).catch(failed('Switching'));
        await click.settle(`You left ${seatName(current)}. Your prompt goes to ${seatName(seat)}.`).catch(error => log(`Discord: ${error instanceof Error ? error.message : String(error)}`));
        transport = click.transport();
      } else {
        await reply.respond();
        transport = reply.transport();
      }
      seats.sit(reply.channelId, reply.authorId, seat);
      const historyKey = historyKeyOf(reply.channelId, reply.authorId, seat);
      const setup = seats.remember(historyKey, reply.setup);
      const key = `reply:${reply.id}`;
      log(`${historyKey} @${reply.authorName} (reply): ${reply.title.split('\n')[0]!.slice(0, 80)}`);
      // A one-shot's apps and files live under its history, so later one-shots there still have them.
      const content = await prompt(historyKey);
      await enqueue(historyKey, async () => {
        // A one-shot stops after one input, so the chosen mode and tier go in when it opens rather than as commands.
        const conversation = await open(key, transport, { channelId: reply.channelId, oneShot: true, setup, historyKey });
        runningOneShots.set(historyKey, conversation);
        conversation.push(content, from);
        try { await conversation.done; }
        finally { conversations.delete(key); if (runningOneShots.get(historyKey) === conversation) runningOneShots.delete(historyKey); }
      });
      return;
    }
    let key = target.key;
    let channelId = reply.channelId;
    let transport: DiscordTransport;
    if (target.kind === 'new-thread') {
      try {
        const thread = await reply.startThread(reply.title);
        key = `thread:${thread.id}`; transport = thread.transport; channelId = thread.id;
      } catch (error) {
        await reply.respond(`teapilot could not start a thread here: ${error instanceof Error ? error.message : String(error)}`);
        return;
      }
    } else transport = reply.transport();
    await reply.respond();
    log(`${key} @${reply.authorName} (reply): ${reply.title.split('\n')[0]!.slice(0, 80)}`);
    // A new conversation starts with the chosen mode and tier; one already running switches to them first.
    const running = conversations.get(key)?.active;
    const content = await prompt(key);
    const conversation = await open(key, transport, { channelId, setup: reply.setup });
    // Switching to Code mode asks for access, which yolo approves as well.
    if (running) for (const command of setupCommands(reply.setup)) conversation.push(command, { sender: reply.authorId, senderName: reply.authorName, yolo: reply.yolo });
    conversation.push(content, from);
  };
  const failed = (what: string) => (error: unknown) => log(`${what} failed: ${error instanceof Error ? error.message : String(error)}`);
  const gateway = await connect(settings, {
    message: message => void handle(message).catch(failed('Message handling')),
    command: command => void handleCommand(command).catch(failed('Command handling')),
    reply: reply => void handleReply(reply).catch(failed('Reply handling')),
    component: interaction => void (surface ? play.interact(interaction) : interaction.reply('teapilot is still starting; try again in a moment.')).catch(failed('App interaction')),
  }, log);
  surface = gateway.play;
  const recovered = await play.recover();
  if (recovered) log(`Resumed ${recovered} discord.play app(s).`);
  if (!config.policy.permissions.includes('discord.play')) log('discord.play is off: add "discord.play" to "permissions" in this profile\'s policy.json to let teapilot build interactive Discord apps.');

  access.lookup = gateway.username;
  log(`Connected as ${gateway.botName}. Listening to ${settings.allowedUserIds.length} operator(s) and ${access.list().users.length} user(s) in DMs${settings.channelIds.length ? ` and ${settings.channelIds.length === 1 ? 'channel' : 'channels'} ${settings.channelIds.join(', ')}` : ''}.`);
  log(`Repository root: ${root}. Sessions start in ${settings.startMode} mode. Press Ctrl+C to stop.`);
  if (!signal.aborted) await new Promise(resolve => signal.addEventListener('abort', resolve, { once: true }));
  log('Stopping: pending approvals are denied.');
  play.close();
  await gateway.close();
  await sandbox.close();
  await Promise.allSettled([...conversations.values()].map(conversation => conversation.done));
  await teachat?.close();
}
