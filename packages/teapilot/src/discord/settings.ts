import { z } from 'zod';

/** Every Discord setting lives in the profile's private .env under this prefix. */
/** DISCORD_CHANNEL_ID is the single-channel setting from before DISCORD_CHANNEL_IDS; it is still read, and removed on the next save. */
export const discordKeys = ['DISCORD_BOT_TOKEN', 'DISCORD_ALLOWED_USER_IDS', 'DISCORD_CHANNEL_IDS', 'DISCORD_CHANNEL_ID', 'DISCORD_ROOT', 'DISCORD_START_MODE'] as const;
export const snowflake = z.string().regex(/^\d{17,20}$/, 'Discord IDs are 17–20 digit numbers.');
export const isSnowflake = (value: string): boolean => snowflake.safeParse(value).success;
/** A comma- or space-separated list of IDs, without blanks or repeats. */
export const idList = (value: string | undefined): string[] => [...new Set((value ?? '').split(/[\s,]+/).filter(Boolean))];

const settingsSchema = z.object({
  token: z.string().min(1),
  allowedUserIds: z.array(snowflake).min(1),
  /** Channels where an @mention starts a thread; DMs always work. */
  channelIds: z.array(snowflake),
  root: z.string().min(1),
  startMode: z.enum(['ask', 'chat']),
});
export type DiscordSettings = z.infer<typeof settingsSchema>;

export class DiscordNotConfigured extends Error {}

/** Parse Discord settings; access fails closed without a token, root and a non-empty allowlist. */
export function readDiscordSettings(env: Record<string, string | undefined>): DiscordSettings {
  if (!env.DISCORD_BOT_TOKEN || !env.DISCORD_ALLOWED_USER_IDS || !env.DISCORD_ROOT) throw new DiscordNotConfigured('Discord is not configured. Run teapilot discord setup.');
  const parsed = settingsSchema.safeParse({
    token: env.DISCORD_BOT_TOKEN,
    allowedUserIds: idList(env.DISCORD_ALLOWED_USER_IDS),
    channelIds: idList(env.DISCORD_CHANNEL_IDS ?? env.DISCORD_CHANNEL_ID),
    root: env.DISCORD_ROOT,
    startMode: env.DISCORD_START_MODE || 'ask',
  });
  if (!parsed.success) throw new DiscordNotConfigured(`Invalid Discord settings (${parsed.error.issues.map(issue => issue.path.join('.')).join(', ')}). Run teapilot discord setup.`);
  return parsed.data;
}
