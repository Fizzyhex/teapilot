import { randomUUID } from 'node:crypto';
import { mkdir, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { z } from 'zod';
import { SEED_CHANNELS, SEED_IDENTITIES } from './seed.js';
import { appendLines, delay, errorCode, moveAside, pidAlive, readJson, readJsonl, renameRetry, writeAtomic, writeJson } from './util.js';

export const MESSAGE_LIMIT = 1000, BIO_LIMIT = 500, CHANNEL_LIMIT = 8000, COMPACT_TARGET = 6000;
export const SYSTEM_AUTHOR = 'system';

const timestamp = z.string().refine(value => !Number.isNaN(Date.parse(value)), 'Expected an ISO timestamp.');
/** Channel ids and usernames double as file names, so they stay short and path-safe. */
export const namePattern = /^[a-z0-9][a-z0-9_-]{0,31}$/;
const name = z.string().regex(namePattern);
const messageSchema = z.object({
  n: z.number().int().positive(), channel: name, author: name, kind: z.enum(['message', 'event']),
  text: z.string(), at: timestamp, replyTo: z.number().int().positive().optional(),
});
const metaSchema = z.object({
  id: name, description: z.string(), summary: z.string(),
  /** The newest message `n` the summary covers. */
  summaryAt: z.number().int().nonnegative().nullable(), nextN: z.number().int().positive(),
});
const identitySchema = z.object({
  username: name.refine(value => value !== SYSTEM_AUTHOR), bio: z.string(), updatedAt: timestamp,
  lease: z.object({ holder: z.string().min(1), until: timestamp }).optional(),
});
const identitiesSchema = z.array(identitySchema).refine(list => new Set(list.map(i => i.username)).size === list.length, 'Duplicate username.');
const ownerSchema = z.object({ pid: z.number().int().positive(), at: timestamp });

export type Message = z.infer<typeof messageSchema>;
export type ChannelMeta = z.infer<typeof metaSchema>;
export type Identity = z.infer<typeof identitySchema>;

/** Rejections an agent tool can show the model as-is. */
export class RoomError extends Error { override name = 'RoomError'; }

/** Transport-neutral, so a networked hub can implement the same surface later. */
export interface Room {
  channels(): Promise<ChannelMeta[]>;
  /** The live log, oldest first; the last `limit` messages when given. */
  read(channel: string, options?: { limit?: number }): Promise<Message[]>;
  post(input: { channel: string; author: string; text: string; replyTo?: number }): Promise<Message>;
  /** A system event in #offtopic. */
  event(text: string): Promise<Message>;
  /** Expired leases are left out. */
  identities(): Promise<Identity[]>;
  /** False when another holder's lease is still running. */
  claim(username: string, holder: string, ttlMs: number): Promise<boolean>;
  /** False unless `holder` still holds the lease. */
  renew(username: string, holder: string, ttlMs: number): Promise<boolean>;
  release(username: string, holder: string): Promise<boolean>;
  updateBio(username: string, bio: string): Promise<Identity>;
  setSummary(channel: string, summary: string, summaryAt: number | null): Promise<void>;
  /** Moves the oldest `count` live messages to the archive and returns them. */
  archive(channel: string, count: number): Promise<Message[]>;
}

export const defaultRoomDir = (): string => process.env.TEACHAT_DIR || join(homedir(), '.teachat');
export const displayName = (username: string): string => username === SYSTEM_AUTHOR ? SYSTEM_AUTHOR : `teapilot:${username}`;
export const leaseActive = (identity: Identity, now: number): boolean => !!identity.lease && Date.parse(identity.lease.until) > now;

export interface LockOptions { staleMs?: number; timeoutMs?: number }

/**
 * A cross-process mutex: `mkdir` either creates the folder or fails. Unlike teapilot's `lockState`, it expires,
 * because many processes share the room: a lock older than `staleMs`, or whose pid has died, is removed.
 */
export async function withRoomLock<T>(dir: string, fn: () => Promise<T>, { staleMs = 30_000, timeoutMs = 10_000 }: LockOptions = {}): Promise<T> {
  const path = join(dir, 'room.lock');
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    try { await mkdir(path, { mode: 0o700 }); break; } catch (error) {
      const code = errorCode(error);
      // Windows answers EPERM while a just-removed lock is still pending deletion.
      if (code !== 'EEXIST' && code !== 'EPERM' && code !== 'EACCES') throw error;
      if (code === 'EEXIST' && await removeIfStale(path, staleMs)) continue;
      if (Date.now() > deadline) throw new Error(`Timed out waiting for ${path}. If no teapilot process is using the room, remove that folder.`);
      await delay(25 + Math.random() * 75);
    }
  }
  try {
    await writeFile(join(path, 'owner.json'), JSON.stringify({ pid: process.pid, at: new Date().toISOString() }), { mode: 0o600 });
    return await fn();
  } finally { await rm(path, { recursive: true, force: true, maxRetries: 20, retryDelay: 25 }); }
}

async function readOwner(path: string): Promise<z.infer<typeof ownerSchema> | undefined> {
  try { return ownerSchema.parse(JSON.parse(await readFile(join(path, 'owner.json'), 'utf8'))); } catch { return undefined; }
}

async function removeIfStale(path: string, staleMs: number): Promise<boolean> {
  const owner = await readOwner(path);
  let since: number;
  // No owner yet: the holder is between mkdir and its write, or crashed there. The folder's age decides.
  if (owner) since = Date.parse(owner.at);
  else try { since = (await stat(path)).mtimeMs; } catch (error) { return errorCode(error) === 'ENOENT'; }
  if (Date.now() - since <= staleMs && (!owner || pidAlive(owner.pid))) return false;
  const tomb = `${path}.stale-${randomUUID()}`;
  try { await renameRetry(path, tomb); } catch { return false; }
  // Another waiter may have replaced the stale lock between our check and the rename; hand a live one back.
  const moved = await readOwner(tomb);
  if (moved && Date.now() - Date.parse(moved.at) <= staleMs && pidAlive(moved.pid)) {
    try { await renameRetry(tomb, path); return false; } catch { /* the name is taken again; the holder's release tolerates this */ }
  }
  await rm(tomb, { recursive: true, force: true, maxRetries: 20, retryDelay: 25 });
  return true;
}

class FileRoom implements Room {
  private tail: Promise<unknown> = Promise.resolve();
  constructor(readonly dir: string, private readonly now: () => number, private readonly lock: LockOptions) {}

  private metaFile = (id: string) => join(this.dir, 'channels', `${id}.json`);
  private liveFile = (id: string) => join(this.dir, 'channels', `${id}.jsonl`);
  private archiveFile = (id: string) => join(this.dir, 'channels', `${id}.archive.jsonl`);
  private identitiesFile = () => join(this.dir, 'identities.json');
  private iso = () => new Date(this.now()).toISOString();

  /** Every access holds the lock; calls from one process queue here instead of polling the folder. */
  private locked<T>(fn: () => Promise<T>): Promise<T> {
    const run = this.tail.then(() => withRoomLock(this.dir, fn, this.lock));
    this.tail = run.catch(() => {});
    return run;
  }

  async seed(): Promise<void> {
    await mkdir(join(this.dir, 'channels'), { recursive: true, mode: 0o700 });
    await this.locked(async () => {
      for (const channel of SEED_CHANNELS) {
        const loaded = await readJson(this.metaFile(channel.id), metaSchema);
        if (loaded.ok || !loaded.missing) continue;
        await writeJson(this.metaFile(channel.id), { id: channel.id, description: channel.description, summary: '', summaryAt: null, nextN: await this.highestN(channel.id) + 1 });
      }
      const identities = await this.loadIdentities();
      const missing = SEED_IDENTITIES.filter(seed => !identities.some(identity => identity.username === seed.username));
      if (missing.length) await writeJson(this.identitiesFile(), [...identities, ...missing.map(seed => ({ ...seed, updatedAt: this.iso() }))]);
    });
  }

  private async highestN(id: string): Promise<number> {
    let highest = 0;
    for (const file of [this.liveFile(id), this.archiveFile(id)]) for (const message of await readJsonl(file, messageSchema)) highest = Math.max(highest, message.n);
    return highest;
  }

  /** A damaged meta file is set aside and rebuilt; nextN comes from the logs so numbers never repeat. */
  private async meta(id: string): Promise<ChannelMeta> {
    if (!namePattern.test(id)) throw new RoomError(`There is no channel #${id}.`);
    const loaded = await readJson(this.metaFile(id), metaSchema);
    if (loaded.ok && loaded.value.id === id) return loaded.value;
    if (!loaded.ok && loaded.missing) throw new RoomError(`There is no channel #${id}.`);
    await moveAside(this.metaFile(id), this.now());
    const meta: ChannelMeta = { id, description: SEED_CHANNELS.find(seed => seed.id === id)?.description ?? '', summary: '', summaryAt: null, nextN: await this.highestN(id) + 1 };
    await writeJson(this.metaFile(id), meta);
    return meta;
  }

  private async loadIdentities(): Promise<Identity[]> {
    const loaded = await readJson(this.identitiesFile(), identitiesSchema);
    if (loaded.ok) return loaded.value;
    if (!loaded.missing) await moveAside(this.identitiesFile(), this.now());
    const seeded = SEED_IDENTITIES.map(seed => ({ ...seed, updatedAt: this.iso() }));
    await writeJson(this.identitiesFile(), seeded);
    return seeded;
  }

  /** nextN is saved before the append, so a crash between them leaves a gap rather than a repeated number. */
  private async append(meta: ChannelMeta, entry: Pick<Message, 'author' | 'kind' | 'text' | 'replyTo'>): Promise<Message> {
    const message: Message = { n: meta.nextN, channel: meta.id, author: entry.author, kind: entry.kind, text: entry.text, at: this.iso(), ...(entry.replyTo !== undefined && { replyTo: entry.replyTo }) };
    await writeJson(this.metaFile(meta.id), { ...meta, nextN: meta.nextN + 1 });
    await appendLines(this.liveFile(meta.id), [JSON.stringify(message)]);
    return message;
  }

  channels(): Promise<ChannelMeta[]> {
    return this.locked(async () => {
      const ids = (await readdir(join(this.dir, 'channels'))).filter(file => file.endsWith('.json')).map(file => file.slice(0, -5)).filter(id => namePattern.test(id));
      const order = (id: string) => { const index = SEED_CHANNELS.findIndex(seed => seed.id === id); return index < 0 ? SEED_CHANNELS.length : index; };
      ids.sort((a, b) => order(a) - order(b) || a.localeCompare(b));
      const metas: ChannelMeta[] = [];
      for (const id of ids) metas.push(await this.meta(id));
      return metas;
    });
  }

  read(channel: string, { limit }: { limit?: number } = {}): Promise<Message[]> {
    return this.locked(async () => {
      await this.meta(channel);
      const live = await readJsonl(this.liveFile(channel), messageSchema);
      return limit === undefined ? live : limit > 0 ? live.slice(-limit) : [];
    });
  }

  post({ channel, author, text, replyTo }: { channel: string; author: string; text: string; replyTo?: number }): Promise<Message> {
    const body = text.trim();
    if (!body) return Promise.reject(new RoomError('The message is empty.'));
    if (body.length > MESSAGE_LIMIT) return Promise.reject(new RoomError(`Messages are limited to ${MESSAGE_LIMIT} characters; this one has ${body.length}.`));
    if (replyTo !== undefined && !(Number.isInteger(replyTo) && replyTo > 0)) return Promise.reject(new RoomError(`#${replyTo} is not a message number.`));
    return this.locked(async () => {
      const meta = await this.meta(channel);
      if (!(await this.loadIdentities()).some(identity => identity.username === author)) throw new RoomError(`There is no identity ${author}.`);
      if (replyTo !== undefined) {
        const found = (await readJsonl(this.liveFile(channel), messageSchema)).some(m => m.n === replyTo) || (await readJsonl(this.archiveFile(channel), messageSchema)).some(m => m.n === replyTo);
        if (!found) throw new RoomError(`There is no message #${replyTo} in #${channel}.`);
      }
      return this.append(meta, { author, kind: 'message', text: body, replyTo });
    });
  }

  event(text: string): Promise<Message> {
    const body = text.trim().replace(/\s+/g, ' ');
    if (!body) return Promise.reject(new RoomError('The event is empty.'));
    return this.locked(async () => this.append(await this.meta('offtopic'), { author: SYSTEM_AUTHOR, kind: 'event', text: body.length > MESSAGE_LIMIT ? `${body.slice(0, MESSAGE_LIMIT - 1)}…` : body }));
  }

  identities(): Promise<Identity[]> {
    return this.locked(async () => {
      const now = this.now();
      return (await this.loadIdentities()).map(({ lease, ...identity }) => lease && Date.parse(lease.until) > now ? { ...identity, lease } : identity);
    });
  }

  private lease(username: string, holder: string, ttlMs: number, renewing: boolean): Promise<boolean> {
    if (!holder) return Promise.reject(new RoomError('A lease needs a holder.'));
    if (!(Number.isFinite(ttlMs) && ttlMs > 0)) return Promise.reject(new RoomError('A lease needs a positive duration.'));
    return this.locked(async () => {
      const identities = await this.loadIdentities();
      const identity = identities.find(i => i.username === username);
      if (!identity) return false;
      const now = this.now();
      if (renewing ? identity.lease?.holder !== holder : identity.lease && identity.lease.holder !== holder && Date.parse(identity.lease.until) > now) return false;
      identity.lease = { holder, until: new Date(now + ttlMs).toISOString() };
      await writeJson(this.identitiesFile(), identities);
      return true;
    });
  }

  claim(username: string, holder: string, ttlMs: number): Promise<boolean> { return this.lease(username, holder, ttlMs, false); }
  renew(username: string, holder: string, ttlMs: number): Promise<boolean> { return this.lease(username, holder, ttlMs, true); }

  release(username: string, holder: string): Promise<boolean> {
    return this.locked(async () => {
      const identities = await this.loadIdentities();
      const identity = identities.find(i => i.username === username);
      if (!identity?.lease || identity.lease.holder !== holder) return false;
      delete identity.lease;
      await writeJson(this.identitiesFile(), identities);
      return true;
    });
  }

  updateBio(username: string, bio: string): Promise<Identity> {
    const body = bio.trim();
    if (!body) return Promise.reject(new RoomError('The bio is empty.'));
    if (body.length > BIO_LIMIT) return Promise.reject(new RoomError(`Bios are limited to ${BIO_LIMIT} characters; this one has ${body.length}.`));
    return this.locked(async () => {
      const identities = await this.loadIdentities();
      const identity = identities.find(i => i.username === username);
      if (!identity) throw new RoomError(`There is no identity ${username}.`);
      identity.bio = body;
      identity.updatedAt = this.iso();
      await writeJson(this.identitiesFile(), identities);
      const { lease, ...rest } = identity;
      return lease && Date.parse(lease.until) > this.now() ? { ...rest, lease } : rest;
    });
  }

  setSummary(channel: string, summary: string, summaryAt: number | null): Promise<void> {
    if (summaryAt !== null && !(Number.isInteger(summaryAt) && summaryAt >= 0)) return Promise.reject(new RoomError('summaryAt must be a message number.'));
    return this.locked(async () => { await writeJson(this.metaFile(channel), { ...await this.meta(channel), summary: summary.trim(), summaryAt }); });
  }

  /** Appends to the archive first, then rewrites the live log, so a crash can only duplicate, never lose. */
  archive(channel: string, count: number): Promise<Message[]> {
    return this.locked(async () => {
      await this.meta(channel);
      if (!(count > 0)) return [];
      const live = await readJsonl(this.liveFile(channel), messageSchema);
      const moved = live.slice(0, Math.floor(count));
      if (!moved.length) return [];
      await appendLines(this.archiveFile(channel), moved.map(message => JSON.stringify(message)));
      await writeAtomic(this.liveFile(channel), live.slice(moved.length).map(message => `${JSON.stringify(message)}\n`).join(''));
      return moved;
    });
  }
}

/** Opens (and on first use seeds) the room in `dir`. Folders are 0o700 and files 0o600. */
export async function openRoom({ dir, now = Date.now, lock = {} }: { dir: string; now?: () => number; lock?: LockOptions }): Promise<Room> {
  await mkdir(dir, { recursive: true, mode: 0o700 });
  const room = new FileRoom(dir, now, lock);
  await room.seed();
  return room;
}
