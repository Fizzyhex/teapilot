import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { parse } from 'dotenv';
import { displayName, renderLog } from 'teachat';
import type { SessionExtension } from '../chat.js';
import type { ComposerIdle } from '../composer.js';
import type { Config } from '../config.js';
import { TeachatService, type GossipView, type TeachatOptions } from './service.js';

const help = '/teachat [read <channel>|who|on|off]';

async function saveEnabled(config: Config, enabled: boolean, signal?: AbortSignal): Promise<string> {
  const directory = config.source?.directory;
  if (!directory) throw new Error('This configuration has no profile directory to save to.');
  const { saveEnvironment } = await import('../setup/index.js');
  const env = parse(await readFile(join(directory, '.env'), 'utf8').catch(() => ''));
  await saveEnvironment(directory, { ...env, TEACHAT_ENABLED: String(enabled) }, signal ?? new AbortController().signal);
  return directory;
}

/**
 * Teachat in an interactive terminal session. Gossip runs in grey while the composer sits empty and untouched
 * (and straight away after /teachat); the first keypress stops it and goes to the composer. /teachat on|off
 * works even while teachat is off.
 */
export function terminalTeachat(config: Config, service: TeachatService | undefined, options: {
  view: () => GossipView & { end(): void };
  log: (text: string) => void;
  teachat?: TeachatOptions;
}): SessionExtension & { composerIdle(): ComposerIdle | undefined; close(signal?: AbortSignal): Promise<void> } {
  let now = false;
  const visible = async (signal: AbortSignal, hint?: string) => {
    if (!service) return;
    const view = options.view();
    if (hint) view.line(hint, 'status');
    try { await service.run(view, signal); }
    catch (error) { view.line(`gossip failed: ${error instanceof Error ? error.message : String(error)}`, 'status'); }
    finally { view.end(); }
  };
  return {
    help,
    composerIdle: () => service && (now || service.pending()) ? {
      ms: now ? 0 : config.teachat!.idleMs,
      pending: () => Boolean(service?.pending()),
      run: async signal => { now = false; await visible(signal); },
    } : undefined,
    busy: async () => { await service?.yield(); },
    request: () => ({ teachatIdentities: service?.identities() }),
    turnEnd: async (turn, result) => { await service?.observe({ ...turn, teachatIdentity: result.teachatIdentity }).catch(() => {}); },
    reset: async () => { await service?.reset(); },
    command: async (command, args) => {
      if (command !== '/teachat') return false;
      const [action, channel, extra] = args.split(/\s+/).filter(Boolean);
      if (action === 'on' || action === 'off') {
        if (channel) { options.log(help); return true; }
        const directory = await saveEnabled(config, action === 'on');
        config.teachat = { ...config.teachat!, enabled: action === 'on' };
        if (action === 'off') { await service?.close(); service = undefined; }
        else service ??= await TeachatService.open(config, options.teachat);
        options.log(`Teachat ${action === 'on' ? 'on' : 'off'} (saved in ${directory}).`);
      } else if (!service) options.log('Teachat is off. Turn it on with /teachat on.');
      else if (!action) {
        if (service.pending()) now = true;
        else options.log('Nothing new to gossip about yet. Finish a turn first.');
      } else if (action === 'read' && channel && !extra) {
        const messages = await service.room.read(channel.replace(/^#/, ''), { limit: 20 });
        options.log(renderLog(messages, Date.now()) || `#${channel.replace(/^#/, '')} is empty.`);
      } else if (action === 'who' && !channel) {
        const self = service.identity();
        options.log((await service.room.identities()).map(identity => `${displayName(identity.username)}${identity.username === self ? ' (you)' : identity.lease ? ' (busy)' : ''}: ${identity.bio}`).join('\n'));
      } else options.log(help);
      return true;
    },
    close: async signal => {
      // Leaving is idle time too: one last round, which Ctrl+C skips.
      if (signal && !signal.aborted && service?.pending()) await visible(signal, 'one last round of gossip before leaving (Ctrl+C skips)');
      await service?.close();
    },
  };
}

/** Teachat for Discord and the bridge: nothing is drawn, and gossip starts once the process has been idle for the idle period. */
export function headlessTeachat(service: TeachatService, key: string): SessionExtension {
  return {
    request: () => ({ teachatIdentities: service.identities(key) }),
    turnEnd: async (turn, result) => { await service.observe({ ...turn, teachatIdentity: result.teachatIdentity }, key).catch(() => {}); },
    reset: async () => { await service.reset(key); },
  };
}

/** Opens teachat for a headless surface, logging its gossip to the operator. Undefined when off or unavailable. */
export async function openHeadlessTeachat(config: Config, log: (text: string) => void): Promise<TeachatService | undefined> {
  try {
    const service = await TeachatService.open(config);
    service?.idle({ line: text => log(`teachat: ${text}`) });
    return service;
  } catch (error) { log(`Teachat is unavailable: ${error instanceof Error ? error.message : String(error)}`); return undefined; }
}
