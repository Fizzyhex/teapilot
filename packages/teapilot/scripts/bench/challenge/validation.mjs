import { require as requireTs } from 'tsx/cjs/api';
import { fileURLToPath } from 'node:url';

/** The simulator's real payload checks, shared by live scoring and saved-capture reports. */
export function validators() {
  return requireTs(fileURLToPath(new URL('../../discord-sim/validate.ts', import.meta.url)), import.meta.url);
}
