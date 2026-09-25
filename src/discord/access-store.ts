import { chmodSync, copyFileSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { dirname, join } from 'node:path';
import { z } from 'zod';
import type { AccessAdmin } from '../agents/access.js';
import { permissions, withPrerequisites, type Caller, type Permission } from '../execution/grants.js';
import { snowflake } from './settings.js';

export type Role = 'operator' | 'user';
/** What a plain user holds without any grant. */
export const userPermissions: readonly Permission[] = ['inference', 'web.search'];
export const maxGrantMs = 30 * 24 * 60 * 60_000;

const timestamp = z.string().refine(value => !Number.isNaN(Date.parse(value)), 'Expected an ISO timestamp.');
const permission = z.custom<Permission>(value => permissions.includes(value as Permission));
const fileSchema = z.object({
  users: z.record(snowflake, z.object({
    addedBy: snowflake, addedAt: timestamp,
    /** Discord username when last seen; display only. */
    name: z.string().optional(),
    /** Absent for a permanent user. */
    expiresAt: timestamp.optional(),
    /** Absent for a grant that lasts until revoked. */
    grants: z.array(z.object({ permission, expiresAt: timestamp.optional(), grantedBy: snowflake, grantedAt: timestamp })),
  })),
});
type Data = z.infer<typeof fileSchema>;

export interface AccessSummary {
  operators: string[];
  users: Array<{ id: string; name?: string; addedBy: string; addedAt: string; expiresAt?: string; grants: Array<{ permission: Permission; expiresAt?: string }> }>;
}

/** "30m", "2h", "1d" → milliseconds; anything unbounded, vague or over the cap is rejected. */
export function parseDuration(text: string): number {
  const match = /^\s*(\d{1,4})\s*(m|h|d)\s*$/i.exec(text);
  if (!match) throw new Error('Give a duration like 30m, 2h or 1d.');
  const ms = Number(match[1]) * { m: 60_000, h: 3_600_000, d: 86_400_000 }[match[2]!.toLowerCase() as 'm' | 'h' | 'd'];
  if (ms < 60_000 || ms > maxGrantMs) throw new Error('Temporary access must last between 1 minute and 30 days.');
  return ms;
}

/**
 * Discord roles. Operators are the setup-time user IDs (never stored here, so a damaged file cannot lock
 * them out or promote anyone); this file holds whitelisted users and their grants, as absolute
 * timestamps so expiry survives restarts. The bot is the only writer, so it loads once and writes through.
 */
export class AccessStore {
  private data?: Data;
  /** Resolves a Discord username (set once the gateway is connected); names are display-only. */
  lookup?: (id: string) => Promise<string | undefined>;
  constructor(readonly file: string, readonly operators: readonly string[], private readonly ceiling: readonly Permission[], private readonly now: () => number = Date.now) {}

  static at(stateDir: string, operators: readonly string[], ceiling: readonly Permission[]): AccessStore {
    return new AccessStore(join(stateDir, 'discord-access.json'), operators, ceiling);
  }

  private load(): Data {
    if (this.data) return this.data;
    try { this.data = fileSchema.parse(JSON.parse(readFileSync(this.file, 'utf8'))); }
    catch (error) {
      // Fail closed: an unreadable file means no whitelisted users. Keep it for inspection before it is rewritten.
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') { try { copyFileSync(this.file, `${this.file}.corrupt`); } catch { /* best effort */ } }
      this.data = { users: {} };
    }
    return this.data;
  }

  private save(data: Data): void {
    mkdirSync(dirname(this.file), { recursive: true });
    const temporary = `${this.file}.${randomUUID()}.tmp`;
    writeFileSync(temporary, JSON.stringify(data, null, 2), { mode: 0o600 });
    try { chmodSync(temporary, 0o600); } catch { /* not meaningful on every platform */ }
    renameSync(temporary, this.file);
    this.data = data;
  }

  /** Drops expired grants, persisting only when something lapsed. */
  private live(): Data {
    const data = this.load();
    const now = this.now();
    let changed = false;
    for (const [id, user] of Object.entries(data.users)) {
      if (user.expiresAt && Date.parse(user.expiresAt) <= now) { delete data.users[id]; changed = true; continue; }
      const kept = user.grants.filter(grant => !grant.expiresAt || Date.parse(grant.expiresAt) > now);
      if (kept.length !== user.grants.length) { user.grants = kept; changed = true; }
    }
    if (changed) this.save(data);
    return data;
  }

  roleOf(id: string): Role | undefined {
    if (this.operators.includes(id)) return 'operator';
    const user = this.load().users[id];
    return user && (!user.expiresAt || Date.parse(user.expiresAt) > this.now()) ? 'user' : undefined;
  }

  /** Role permissions plus unexpired grants, within the policy ceiling. */
  permissionsOf(id: string): Permission[] {
    const role = this.roleOf(id);
    if (!role) return [];
    const held = new Set<Permission>(role === 'operator' ? permissions : userPermissions);
    const now = this.now();
    for (const grant of this.load().users[id]?.grants ?? []) if (!grant.expiresAt || Date.parse(grant.expiresAt) > now) held.add(grant.permission);
    return withPrerequisites([...held]).filter(value => this.ceiling.includes(value));
  }

  /** The live view a session checks on every permission test. */
  callerFor(id: string): () => Caller {
    return () => {
      const held = this.permissionsOf(id);
      return { permissions: held, preapproved: this.roleOf(id) === 'user' ? held.filter(value => value === 'web.search') : [] };
    };
  }

  /** The management surface handed to the agent for one sender; the role is fixed here, by the host. */
  adminFor(id: string): AccessAdmin | undefined {
    const role = this.roleOf(id);
    return role && { role, senderId: id, username: target => this.lookup?.(target) ?? Promise.resolve(undefined), list: () => this.list(), addUser: (target, by) => this.addUser(target, by), removeUser: target => this.removeUser(target),
      grant: (target, value, ms, by) => this.grant(target, value, ms, by), revoke: (target, value) => this.revoke(target, value), parseDuration };
  }

  list(): AccessSummary {
    return {
      operators: [...this.operators],
      users: Object.entries(this.live().users).map(([id, user]) => ({ id, name: user.name, expiresAt: user.expiresAt, addedBy: user.addedBy, addedAt: user.addedAt, grants: user.grants.map(({ permission, expiresAt }) => ({ permission, expiresAt })) })),
    };
  }

  /** Whitelists a user, permanently unless `durationMs` is given. Adding again updates the expiry and name. */
  addUser(id: string, by: string, options: { name?: string; durationMs?: number } = {}): 'added' | 'updated' | 'operator' {
    if (!snowflake.safeParse(id).success) throw new Error('Discord IDs are 17–20 digit numbers.');
    if (this.operators.includes(id)) return 'operator';
    const { name, durationMs } = options;
    if (durationMs !== undefined && (!Number.isFinite(durationMs) || durationMs < 60_000 || durationMs > maxGrantMs)) throw new Error('Temporary access must last between 1 minute and 30 days.');
    const data = this.live();
    const existing = data.users[id];
    const expiresAt = durationMs === undefined ? undefined : new Date(this.now() + durationMs).toISOString();
    data.users[id] = { addedBy: existing?.addedBy ?? by, addedAt: existing?.addedAt ?? new Date(this.now()).toISOString(), name: name ?? existing?.name, expiresAt, grants: existing?.grants ?? [] };
    this.save(data);
    return existing ? 'updated' : 'added';
  }

  /** Keeps a whitelisted user's displayed username current; writes only on change. */
  rememberName(id: string, name: string): void {
    const user = this.load().users[id];
    if (!user || user.name === name) return;
    user.name = name;
    this.save(this.data!);
  }

  removeUser(id: string): boolean {
    const data = this.live();
    if (!data.users[id]) return false;
    delete data.users[id];
    this.save(data);
    return true;
  }

  /** Lasts until revoked unless `durationMs` is given. Returns the absolute expiry, if any. A repeat replaces the earlier grant of that permission. */
  grant(id: string, value: Permission, durationMs: number | undefined, by: string): string | undefined {
    if (this.operators.includes(id)) throw new Error('Operators already hold every permission.');
    const data = this.live();
    const user = data.users[id];
    if (!user) throw new Error('That person is not whitelisted. Add them first.');
    if (!this.ceiling.includes(value)) throw new Error(`${value} is disabled by this installation's policy.`);
    if (userPermissions.includes(value)) throw new Error(`Users already hold ${value}.`);
    if (durationMs !== undefined && (!Number.isFinite(durationMs) || durationMs < 60_000 || durationMs > maxGrantMs)) throw new Error('Temporary access must last between 1 minute and 30 days.');
    const now = this.now();
    const expiresAt = durationMs === undefined ? undefined : new Date(now + durationMs).toISOString();
    user.grants = [...user.grants.filter(grant => grant.permission !== value), { permission: value, expiresAt, grantedBy: by, grantedAt: new Date(now).toISOString() }];
    this.save(data);
    return expiresAt;
  }

  /** Removes one permission's grant, or every grant when none is named. Returns how many were removed. */
  revoke(id: string, value?: Permission): number {
    const data = this.live();
    const user = data.users[id];
    if (!user) return 0;
    const kept = user.grants.filter(grant => value !== undefined && grant.permission !== value);
    const removed = user.grants.length - kept.length;
    if (removed) { user.grants = kept; this.save(data); }
    return removed;
  }
}
