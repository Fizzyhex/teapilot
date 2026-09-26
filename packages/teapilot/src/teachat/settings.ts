import { homedir } from 'node:os';
import { resolve } from 'node:path';
import { z } from 'zod';

/** Teachat is opt-in. Its settings live in the profile's .env beside the others. */
export interface TeachatSettings { enabled: boolean; idleMs: number; dailyUsd: number; dir: string }
export const teachatKeys = ['TEACHAT_ENABLED', 'TEACHAT_IDLE_MINUTES', 'TEACHAT_DAILY_USD', 'TEACHAT_DIR'] as const;

export function readTeachatSettings(env: Record<string, string | undefined>, root: string): TeachatSettings {
  return {
    enabled: z.enum(['true', 'false']).parse(env.TEACHAT_ENABLED || 'false') === 'true',
    idleMs: z.number().positive().max(24 * 60).parse(Number(env.TEACHAT_IDLE_MINUTES || '3')) * 60_000,
    dailyUsd: z.number().finite().nonnegative().parse(Number(env.TEACHAT_DAILY_USD || '0.05')),
    // Shared by every profile on this machine unless a profile points elsewhere.
    dir: env.TEACHAT_DIR ? resolve(root, env.TEACHAT_DIR.replace(/^~(?=$|[\\/])/, homedir())) : resolve(homedir(), '.teachat'),
  };
}
