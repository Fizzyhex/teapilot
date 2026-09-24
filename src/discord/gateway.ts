import { randomUUID } from 'node:crypto';
import type { SendableChannels, Message } from 'discord.js';
import type { IncomingMessage } from './access.js';
import type { DiscordTransport } from './bridge.js';
import { MESSAGE_LIMIT } from './render.js';
import type { DiscordSettings } from './settings.js';

export interface GatewayMessage extends IncomingMessage {
  /** Message text with the bot mention removed. */
  content: string;
  authorName: string;
  transport(): DiscordTransport;
  startThread(name: string): Promise<{ id: string; transport: DiscordTransport }>;
}
export interface Gateway { botName: string; close(): Promise<void> }

const noop = () => undefined;
const quiet = { allowedMentions: { parse: [] as [] } };

/**
 * The only module that loads discord.js. It connects outbound over the Gateway:
 * no public URL, webhook or local server. Approval clicks are accepted from allowlisted users only.
 */
export async function connect(settings: DiscordSettings, onMessage: (message: GatewayMessage) => void, log: (text: string) => void): Promise<Gateway> {
  const { ActionRowBuilder, ButtonBuilder, ButtonStyle, Client, Events, GatewayIntentBits, MessageFlags, Partials, ThreadAutoArchiveDuration } = await import('discord.js');
  const client = new Client({
    intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMessages, GatewayIntentBits.DirectMessages, GatewayIntentBits.MessageContent],
    partials: [Partials.Channel],
    allowedMentions: { parse: [] },
  });
  const pending = new Map<string, { text: string; resolve(approved: boolean): void }>();
  const settle = (text: string, verdict: string) => `${text.slice(0, MESSAGE_LIMIT - verdict.length - 2)}\n\n${verdict}`;

  const transport = (channel: SendableChannels): DiscordTransport => {
    const sent = new Map<string, Message>();
    return {
      async send(text) { const message = await channel.send({ content: text, ...quiet }); sent.set(message.id, message); return message.id; },
      async edit(id, text) { const message = sent.get(id) ?? await channel.messages.fetch(id); await message.edit({ content: text, ...quiet }); },
      typing() { void channel.sendTyping().catch(noop); },
      async askApproval(text, signal) {
        if (signal.aborted) return false;
        const nonce = randomUUID();
        const row = new ActionRowBuilder<InstanceType<typeof ButtonBuilder>>().addComponents(
          new ButtonBuilder().setCustomId(`teapilot:${nonce}:approve`).setLabel('Approve').setStyle(ButtonStyle.Success),
          new ButtonBuilder().setCustomId(`teapilot:${nonce}:deny`).setLabel('Deny').setStyle(ButtonStyle.Danger));
        const message = await channel.send({ content: text, components: [row], ...quiet });
        return await new Promise<boolean>(resolve => {
          const expire = () => {
            if (!pending.delete(nonce)) return;
            void message.edit({ content: settle(text, '**Denied** (expired or cancelled)'), components: [], ...quiet }).catch(noop);
            resolve(false);
          };
          pending.set(nonce, { text, resolve: approved => { signal.removeEventListener('abort', expire); resolve(approved); } });
          signal.addEventListener('abort', expire, { once: true });
        });
      },
    };
  };

  client.on(Events.InteractionCreate, async interaction => {
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
    onMessage({
      authorId: message.author.id,
      authorIsBot: message.author.bot,
      authorName: message.author.username,
      guildId: message.guildId ?? undefined,
      channelId: message.channelId,
      parentId: thread?.parentId ?? undefined,
      ownThread: thread?.ownerId === self.id,
      mentionsBot: message.mentions.users.has(self.id),
      content: message.content.replace(new RegExp(`<@!?${self.id}>`, 'g'), '').trim(),
      transport: () => transport(channel),
      async startThread(name) {
        const created = await message.startThread({ name: name.slice(0, 90) || 'teapilot', autoArchiveDuration: ThreadAutoArchiveDuration.OneDay });
        return { id: created.id, transport: transport(created) };
      },
    });
  });
  client.on(Events.Error, error => log(`Discord: ${error.message}`));

  const ready = new Promise<void>(resolve => client.once(Events.ClientReady, () => resolve()));
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
