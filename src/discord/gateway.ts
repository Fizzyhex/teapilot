import { randomUUID } from 'node:crypto';
import type { ActionRowBuilder, ButtonBuilder, ChatInputCommandInteraction, Message, MessageContextMenuCommandInteraction, SendableChannels } from 'discord.js';
import type { IncomingMessage } from './access.js';
import type { DiscordTransport } from './bridge.js';
import { commandDefinitions, commandText, interactionLifetimeMs, replyCommand, replyMenu, withoutUserInstall } from './commands.js';
import { MESSAGE_LIMIT, quoteMessage, type QuotedMessage } from './render.js';
import type { DiscordSettings } from './settings.js';

/** How far the Reply menu follows a message's replies back, and how long it may spend fetching them. */
const replyChainDepth = 10;
const replyChainBudgetMs = 1500;
const replyChainMessageChars = 2000;

export interface GatewayMessage extends IncomingMessage {
  /** Message text with the bot mention removed. */
  content: string;
  authorName: string;
  transport(): DiscordTransport;
  startThread(name: string): Promise<{ id: string; transport: DiscordTransport }>;
  /** The messages this one replies to, oldest first; fetched on demand, so only routed messages pay for it. */
  replyChain(): Promise<QuotedMessage[]>;
}
/** A slash command from an allowlisted-or-not user; `text` is the equivalent session command. */
export interface GatewayCommand extends IncomingMessage {
  text: string;
  /** Answer only the invoker: with text it shows a private note, without it the invocation is dismissed quietly. */
  respond(text?: string): Promise<void>;
}
/** /reply or the Reply context menu: `content` is what teapilot receives, `title` names a new thread. */
export interface GatewayReply extends Omit<GatewayMessage, 'replyChain'> {
  title: string;
  /** Interaction id, unique per invocation. */
  id: string;
  /**
   * The bot cannot post in this channel, so it answers through the interaction itself: one
   * conversation per invocation, no threads, and it ends when Discord expires the interaction.
   * With this set, `respond()` with no text keeps the reply visible instead of dismissing it.
   */
  oneShot: boolean;
  /** From the Reply menu: only teapilot's answer (and approval buttons) go to Discord; the rest is logged in the terminal. */
  answerOnly: boolean;
  respond(text?: string): Promise<void>;
}
export interface GatewayHandlers {
  message(message: GatewayMessage): void;
  command(command: GatewayCommand): void;
  reply(reply: GatewayReply): void;
}
export interface Gateway { botName: string; close(): Promise<void> }

const noop = () => undefined;
const quiet = { allowedMentions: { parse: [] as [] } };

/**
 * The only module that loads discord.js. It connects outbound over the Gateway:
 * no public URL, webhook or local server. Approval clicks are accepted from allowlisted users only.
 */
export async function connect(settings: DiscordSettings, handlers: GatewayHandlers, log: (text: string) => void): Promise<Gateway> {
  const { ActionRowBuilder, ButtonBuilder, ButtonStyle, Client, Events, GatewayIntentBits, MessageFlags, MessageReferenceType, Partials, PermissionFlagsBits, ThreadAutoArchiveDuration } = await import('discord.js');
  const client = new Client({
    intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMessages, GatewayIntentBits.DirectMessages, GatewayIntentBits.MessageContent],
    partials: [Partials.Channel],
    allowedMentions: { parse: [] },
  });
  const pending = new Map<string, { text: string; resolve(approved: boolean): void }>();
  const settle = (text: string, verdict: string) => `${text.slice(0, MESSAGE_LIMIT - verdict.length - 2)}\n\n${verdict}`;

  type Payload = { content: string; components: Array<ActionRowBuilder<ButtonBuilder>>; allowedMentions: { parse: [] } };
  /** Approve/deny buttons under `text`; `post` and `revise` decide whether a channel or an interaction carries them. */
  const askApproval = (text: string, signal: AbortSignal, post: (payload: Payload) => Promise<{ id: string }>, revise: (id: string, payload: Payload) => Promise<unknown>): Promise<boolean> => {
    if (signal.aborted) return Promise.resolve(false);
    const nonce = randomUUID();
    const row = new ActionRowBuilder<ButtonBuilder>().addComponents(
      new ButtonBuilder().setCustomId(`teapilot:${nonce}:approve`).setLabel('Approve').setStyle(ButtonStyle.Success),
      new ButtonBuilder().setCustomId(`teapilot:${nonce}:deny`).setLabel('Deny').setStyle(ButtonStyle.Danger));
    return post({ content: text, components: [row], ...quiet }).then(message => new Promise<boolean>(resolve => {
      const expire = () => {
        if (!pending.delete(nonce)) return;
        void revise(message.id, { content: settle(text, '**Denied** (expired or cancelled)'), components: [], ...quiet }).catch(noop);
        resolve(false);
      };
      pending.set(nonce, { text, resolve: approved => { signal.removeEventListener('abort', expire); resolve(approved); } });
      signal.addEventListener('abort', expire, { once: true });
    }));
  };

  const transport = (channel: SendableChannels): DiscordTransport => {
    const sent = new Map<string, Message>();
    return {
      async send(text) { const message = await channel.send({ content: text, ...quiet }); sent.set(message.id, message); return message.id; },
      async edit(id, text) { const message = sent.get(id) ?? await channel.messages.fetch(id); await message.edit({ content: text, ...quiet }); },
      typing() { void channel.sendTyping().catch(noop); },
      askApproval: (text, signal) => askApproval(text, signal, payload => channel.send(payload), async (id, payload) => (sent.get(id) ?? await channel.messages.fetch(id)).edit(payload)),
    };
  };

  /**
   * Where the bot cannot post, answer through the interaction webhook, which needs no channel permission.
   * Discord keeps that webhook valid for 15 minutes, and there is no typing indicator or thread.
   */
  const interactionTransport = (interaction: ChatInputCommandInteraction | MessageContextMenuCommandInteraction): DiscordTransport => {
    const expires = Date.now() + interactionLifetimeMs;
    let first = true;
    const live = () => { if (Date.now() > expires) throw new Error('This Discord interaction expired after 15 minutes. Run /reply again.'); };
    const post = async (payload: Payload) => {
      live();
      // The deferred "thinking" message becomes the first message; later ones are follow-ups.
      if (first) { first = false; return await interaction.editReply(payload); }
      return await interaction.followUp(payload);
    };
    const revise = async (id: string, payload: Partial<Payload>) => { live(); await interaction.webhook.editMessage(id, payload); };
    return {
      async send(text) { return (await post({ content: text, components: [], ...quiet })).id; },
      edit: (id, text) => revise(id, { content: text, ...quiet }),
      typing: noop,
      askApproval: (text, signal) => askApproval(text, signal, post, revise),
    };
  };

  const sendable = async (interaction: ChatInputCommandInteraction | MessageContextMenuCommandInteraction) => {
    const channel = interaction.channel ?? await client.channels.fetch(interaction.channelId).catch(() => null);
    return channel?.isSendable() ? channel : undefined;
  };
  const strip = (text: string, id: string) => text.replace(new RegExp(`<@!?${id}>`, 'g'), '').trim();

  /**
   * The messages `message` replies to, oldest first, for mentions and the Reply menu. Discord drops an
   * interaction unless it is answered within 3 seconds, so the walk stops at a depth and time budget,
   * and at anything it cannot fetch.
   */
  const replyChain = async (message: Message, selfId: string): Promise<QuotedMessage[]> => {
    const chain: QuotedMessage[] = [];
    const deadline = Date.now() + replyChainBudgetMs;
    let current = message;
    while (chain.length < replyChainDepth && current.reference?.type === MessageReferenceType.Default && current.reference.messageId) {
      const left = deadline - Date.now();
      if (left <= 0) break;
      let timer: ReturnType<typeof setTimeout> | undefined;
      const parent = await Promise.race([
        current.fetchReference(),
        new Promise<undefined>(resolve => { timer = setTimeout(() => resolve(undefined), left); }),
      ]).catch(() => undefined).finally(() => clearTimeout(timer));
      if (!parent) break;
      chain.unshift({ author: parent.author.username, text: strip(parent.content, selfId).slice(0, replyChainMessageChars) });
      current = parent;
    }
    return chain;
  };

  /** /reply and the Reply context menu: both start or continue a conversation wherever the bot may post. */
  const reply = async (interaction: ChatInputCommandInteraction | MessageContextMenuCommandInteraction, self: NonNullable<typeof client.user>) => {
    let answered = false;
    const channel = await sendable(interaction);
    const thread = channel?.isThread() ? channel : undefined;
    // Servers where teapilot is only user-installed, or where it lacks Send Messages, still allow interaction replies.
    const oneShot = !channel || (interaction.inGuild() && !interaction.appPermissions?.has([PermissionFlagsBits.ViewChannel, thread ? PermissionFlagsBits.SendMessagesInThreads : PermissionFlagsBits.SendMessages]));
    const respond = async (note?: string) => {
      if (answered) { if (note) await interaction.followUp({ content: note, flags: MessageFlags.Ephemeral }); return; }
      answered = true;
      if (note) await interaction.reply({ content: note, flags: MessageFlags.Ephemeral });
      else if (oneShot) await interaction.deferReply();
      else { await interaction.deferReply({ flags: MessageFlags.Ephemeral }); await interaction.deleteReply(); }
    };
    const spawn = async (start: () => Promise<{ id: string } & Parameters<typeof transport>[0]>) => {
      if (!channel || oneShot) throw new Error('teapilot cannot post in this channel.');
      if (thread) throw new Error('Threads cannot be started inside other threads.');
      const created = await start();
      return { id: created.id, transport: transport(created) };
    };
    const target = interaction.isMessageContextMenuCommand() ? interaction.targetMessage : undefined;
    const text = interaction.isChatInputCommand() ? interaction.options.getString('message', true).trim() : strip(target?.content ?? '', self.id);
    const chain = target && text ? await replyChain(target, self.id) : [];
    handlers.reply({
      authorId: interaction.user.id,
      authorIsBot: interaction.user.bot,
      authorName: interaction.user.username,
      guildId: interaction.guildId ?? undefined,
      channelId: interaction.channelId,
      parentId: thread?.parentId ?? undefined,
      ownThread: thread?.ownerId === self.id,
      mentionsBot: false,
      content: target && text ? quoteMessage({ author: target.author.username, text }, chain) : text,
      title: text,
      id: interaction.id,
      oneShot,
      answerOnly: !!target,
      transport: () => channel && !oneShot ? transport(channel) : interactionTransport(interaction),
      startThread: name => spawn(async () => {
        const options = { name: name.slice(0, 90) || 'teapilot', autoArchiveDuration: ThreadAutoArchiveDuration.OneDay };
        if (target) return await target.startThread(options);
        // A slash command has no message to anchor a thread, so echo the prompt and open the thread on it.
        const response = await interaction.reply({ content: `<@${interaction.user.id}>: ${text}`.slice(0, MESSAGE_LIMIT), ...quiet, withResponse: true });
        answered = true;
        const message = response.resource?.message;
        if (!message) throw new Error('Discord did not return the message to start a thread on.');
        return await message.startThread(options);
      }),
      respond: note => respond(note).catch(error => log(`Discord: ${error instanceof Error ? error.message : String(error)}`)),
    });
  };

  client.on(Events.InteractionCreate, async interaction => {
    if (interaction.isMessageContextMenuCommand() && interaction.commandName === replyMenu || interaction.isChatInputCommand() && interaction.commandName === replyCommand) {
      const self = client.user;
      if (self && (interaction.isMessageContextMenuCommand() || interaction.isChatInputCommand())) await reply(interaction, self).catch(error => log(`Discord: ${error instanceof Error ? error.message : String(error)}`));
      return;
    }
    if (interaction.isChatInputCommand()) {
      const self = client.user;
      const channel = interaction.channel;
      const text = commandText(interaction.commandName, interaction.options.getSubcommand(false), interaction.options.getString('value'));
      const respond = async (note?: string) => {
        if (note) await interaction.reply({ content: note, flags: MessageFlags.Ephemeral });
        else { await interaction.deferReply({ flags: MessageFlags.Ephemeral }); await interaction.deleteReply(); }
      };
      if (!self || !text) { await respond('Unknown teapilot command.').catch(noop); return; }
      const thread = channel?.isThread() ? channel : undefined;
      handlers.command({
        authorId: interaction.user.id,
        authorIsBot: interaction.user.bot,
        guildId: interaction.guildId ?? undefined,
        channelId: interaction.channelId,
        parentId: thread?.parentId ?? undefined,
        ownThread: thread?.ownerId === self.id,
        mentionsBot: false,
        text,
        respond: note => respond(note).catch(error => log(`Discord: ${error instanceof Error ? error.message : String(error)}`)),
      });
      return;
    }
    if (!interaction.isButton()) return;
    const [prefix, nonce, verdict] = interaction.customId.split(':');
    if (prefix !== 'teapilot' || !nonce) return;
    if (!settings.allowedUserIds.includes(interaction.user.id)) {
      await interaction.reply({ content: 'You are not allowed to approve teapilot actions.', flags: MessageFlags.Ephemeral }).catch(noop);
      return;
    }
    const entry = pending.get(nonce);
    if (!entry) { await interaction.reply({ content: 'This approval is no longer pending.', flags: MessageFlags.Ephemeral }).catch(noop); return; }
    pending.delete(nonce);
    const approved = verdict === 'approve';
    await interaction.update({ content: settle(entry.text, `**${approved ? 'Approved' : 'Denied'}** by <@${interaction.user.id}>`), components: [], ...quiet }).catch(noop);
    entry.resolve(approved);
  });

  client.on(Events.MessageCreate, message => {
    const self = client.user;
    if (!self || message.author.id === self.id || !message.channel.isSendable()) return;
    const channel = message.channel;
    const thread = channel.isThread() ? channel : undefined;
    handlers.message({
      authorId: message.author.id,
      authorIsBot: message.author.bot,
      authorName: message.author.username,
      guildId: message.guildId ?? undefined,
      channelId: message.channelId,
      parentId: thread?.parentId ?? undefined,
      ownThread: thread?.ownerId === self.id,
      mentionsBot: message.mentions.users.has(self.id),
      content: strip(message.content, self.id),
      replyChain: () => replyChain(message, self.id),
      transport: () => transport(channel),
      async startThread(name) {
        const created = await message.startThread({ name: name.slice(0, 90) || 'teapilot', autoArchiveDuration: ThreadAutoArchiveDuration.OneDay });
        return { id: created.id, transport: transport(created) };
      },
    });
  });
  client.on(Events.Error, error => log(`Discord: ${error.message}`));

  // Registering on ready overwrites teapilot's global set, so removed commands disappear on the next start.
  const ready = new Promise<void>(resolve => client.once(Events.ClientReady, () => {
    void (async () => {
      const done = () => log(`Registered ${commandDefinitions.length} app commands.`);
      try { await client.application?.commands.set(commandDefinitions); done(); }
      catch (error) {
        // Discord rejects user-install commands until User Install is enabled in the Developer Portal.
        log(`App command registration failed: ${error instanceof Error ? error.message : String(error)}. Retrying without user-install support.`);
        await client.application?.commands.set(withoutUserInstall(commandDefinitions)).then(done)
          .catch(retry => log(`App command registration failed: ${retry instanceof Error ? retry.message : String(retry)}`));
      }
    })();
    resolve();
  }));
  try { await client.login(settings.token); }
  catch (error) {
    await client.destroy();
    const message = error instanceof Error ? error.message : String(error);
    if (/disallowed intents/i.test(message)) throw new Error('Discord refused the Message Content intent. Enable it in the Developer Portal under Bot → Privileged Gateway Intents, then retry.');
    if (/invalid token|TokenInvalid/i.test(message)) throw new Error('Discord rejected the bot token. Reset it in the Developer Portal and rerun teapilot discord setup.');
    throw error;
  }
  await ready;
  return {
    botName: client.user?.tag ?? 'bot',
    async close() {
      for (const entry of pending.values()) entry.resolve(false);
      pending.clear();
      await client.destroy();
    },
  };
}
