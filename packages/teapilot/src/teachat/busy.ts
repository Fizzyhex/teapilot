import { markBusy } from 'teachat';
import { exists, type Config } from '../config.js';

/**
 * Marks user work so gossip anywhere on this machine pauses. Only once a room exists, so machines that never
 * used teachat get no ~/.teachat. Best effort: marking never delays or fails the work itself.
 */
export async function markWork(config: Config): Promise<() => Promise<void>> {
  const dir = config.teachat?.dir;
  try { if (dir && await exists(dir)) { const release = await markBusy(dir); return () => release().catch(() => {}); } }
  catch { /* unmarked work only means gossip elsewhere keeps running */ }
  return async () => {};
}
