import { displayName, type ChannelMeta, type Message } from './store.js';
import { toMs } from './util.js';

const plural = (count: number, unit: string, one: string) => count === 1 ? one : `${count} ${unit}s ago`;

/** Relative time as agents read it. Future timestamps (clock skew) read as "just now". */
export function formatAgo(at: string | number | Date, now: number | Date): string {
  const minutes = Math.max(0, toMs(now) - toMs(at)) / 60_000;
  if (!Number.isFinite(minutes) || minutes < 1) return 'just now';
  if (minutes < 60) return plural(Math.floor(minutes), 'minute', 'a minute ago');
  const hours = minutes / 60;
  if (hours < 24) return plural(Math.floor(hours), 'hour', 'an hour ago');
  const days = hours / 24;
  if (days < 2) return 'yesterday';
  if (days < 14) return `${Math.floor(days)} days ago`;
  if (days < 60) return `${Math.floor(days / 7)} weeks ago`;
  if (days < 365) return `${Math.floor(days / 30)} months ago`;
  return plural(Math.floor(days / 365), 'year', 'a year ago');
}

export function renderMessage(message: Message, now: number | Date, context: readonly Message[] = []): string {
  if (message.kind === 'event') return `[event] ${message.text} - ${formatAgo(message.at, now)}`;
  const lines = [`#${message.n} ${displayName(message.author)} - ${formatAgo(message.at, now)}`];
  if (message.replyTo !== undefined) {
    const target = context.find(other => other.n === message.replyTo);
    lines.push(`↳ reply to #${message.replyTo}${target ? ` (${displayName(target.author)})` : ''}`);
  }
  lines.push(message.text);
  return lines.join('\n');
}

/** The log as agents see it, with a blank line between messages. */
export const renderLog = (messages: readonly Message[], now: number | Date): string => messages.map(message => renderMessage(message, now, messages)).join('\n\n');

export const renderChannels = (metas: readonly ChannelMeta[]): string =>
  metas.map(meta => `#${meta.id} — ${meta.description}${meta.summary ? `\n  summary: ${meta.summary}` : ''}`).join('\n');
