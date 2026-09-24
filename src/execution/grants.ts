import { realpath } from 'node:fs/promises';
import type { Config } from '../config.js';
import type { EventSink } from '../integration/events.js';
import type { Approve } from './policy.js';

export type Mode = 'chat' | 'ask' | 'code';
export type Permission = Config['policy']['permissions'][number];
export const permissions: Permission[] = ['inference', 'repository.read', 'repository.write', 'repository.shell', 'web.search'];
export const repositoryPermissions: Permission[] = ['repository.read', 'repository.write', 'repository.shell'];

export function withPrerequisites(requested: readonly Permission[]): Permission[] {
  const result = new Set(requested);
  if (result.has('repository.write') || result.has('repository.shell')) result.add('repository.read');
  return permissions.filter(permission => result.has(permission));
}

/** Host-owned, in-memory authority. Never deserialize this object from model/client input. */
export class SessionGrants {
  private granted = new Set<Permission>();
  private constructor(readonly root: string, private readonly ceiling: readonly Permission[]) {}
  static async create(cwd: string, config: Config, mode: Mode, web = false): Promise<SessionGrants> {
    const state = new SessionGrants(await realpath(cwd), [...config.policy.permissions]);
    for (const permission of ['inference', ...(mode === 'code' ? repositoryPermissions : []), ...(web ? ['web.search'] : [])] as Permission[]) {
      if (state.ceiling.includes(permission)) state.granted.add(permission);
    }
    if (!state.granted.has('repository.read')) for (const permission of repositoryPermissions) state.granted.delete(permission);
    return state;
  }
  list(): Permission[] { return permissions.filter(permission => this.granted.has(permission)); }
  available(): Permission[] { return [...this.ceiling]; }
  allows(permission: Permission): boolean { return this.granted.has(permission) && this.ceiling.includes(permission); }
  async request(requested: Permission[], reason: string, approve: Approve, signal?: AbortSignal,
    emit?: (type: string, fields: Record<string, unknown>) => Promise<void>): Promise<boolean> {
    signal?.throwIfAborted();
    const needed = withPrerequisites(requested);
    if (needed.some(permission => !this.ceiling.includes(permission))) return false;
    const missing = needed.filter(permission => !this.allows(permission));
    if (!missing.length) return true;
    await emit?.('grant_requested', { permissions: missing, cwd: this.root });
    const approved = await approve({ kind: 'capability', permissions: missing, cwd: this.root, duration: 'session',
      summary: `Allow ${missing.join(', ')} for this session?`,
      details: `Repository: ${this.root}\nReason: ${reason}\nAccess lasts until revoked or this session exits. Existing action approvals still apply.`, signal });
    signal?.throwIfAborted();
    if (approved) for (const permission of missing) this.granted.add(permission);
    await emit?.(approved ? 'grant_granted' : 'grant_denied', { permissions: missing, cwd: this.root });
    return approved;
  }
  revoke(permission: Permission, onEvent?: EventSink): void {
    const removed = (permission === 'repository.read' ? repositoryPermissions : [permission]).filter(value => this.granted.delete(value));
    if (removed.length) onEvent?.({ type: 'grant_revoked', permissions: removed, cwd: this.root });
  }
}
