import type { DiscordSettings } from './settings.js';

/** The transport-neutral facts needed to decide whether a message is addressed to teapilot. */
export interface IncomingMessage {
  authorId: string;
  authorIsBot: boolean;
  /** Undefined for direct messages. */
  guildId?: string;
  channelId: string;
  /** Parent channel when the message was sent in a thread. */
  parentId?: string;
  /** The thread was created by this bot. */
  ownThread: boolean;
  mentionsBot: boolean;
}
export type Route = { key: string; kind: 'dm' | 'thread' | 'new-thread' };

/**
 * Fail closed: only allowlisted people, only in DMs, a thread teapilot opened in the
 * configured channel, or an @mention in that channel. Everything else is ignored silently.
 */
export function route(message: IncomingMessage, settings: Pick<DiscordSettings, 'allowedUserIds' | 'channelId'>): Route | undefined {
  if (message.authorIsBot || !settings.allowedUserIds.includes(message.authorId)) return undefined;
  if (!message.guildId) return { key: `dm:${message.channelId}`, kind: 'dm' };
  if (!settings.channelId) return undefined;
  if (message.ownThread && message.parentId === settings.channelId) return { key: `thread:${message.channelId}`, kind: 'thread' };
  if (message.channelId === settings.channelId && message.mentionsBot) return { key: '', kind: 'new-thread' };
  return undefined;
}
