import { readdir, realpath, stat } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import type { Config, Workload } from '../config.js';
import type { EventSink } from '../integration/events.js';
import type { Approve } from './policy.js';

export const modes = ['chat', 'ask', 'code'] as const;
export type Mode = typeof modes[number];
export const isMode = (value: unknown): value is Mode => modes.includes(value as Mode);
/** Modes are the user-facing session shape; workloads are the routed capability family. */
export const workloadFor = (mode: Mode): Workload => mode === 'code' ? 'coder' : 'ask';
export const modeFor = (workload?: Workload): Mode => workload === 'coder' ? 'code' : 'ask';
export type Permission = Config['policy']['permissions'][number];
export const permissions: Permission[] = ['inference', 'repository.read', 'repository.write', 'repository.shell', 'web.search', 'discord.play'];
export const repositoryPermissions: Permission[] = ['repository.read', 'repository.write', 'repository.shell'];

export function withPrerequisites(requested: readonly Permission[]): Permission[] {
  const result = new Set(requested);
  if (result.has('repository.write') || result.has('repository.shell')) result.add('repository.read');
  return permissions.filter(permission => result.has(permission));
}

const hasGit = (path: string) => stat(join(path, '.git')).then(() => true, () => false);
/**
 * True only inside one Git work tree that is not itself a folder of repositories (two or more
 * immediate children with `.git`). Unclear cases (unreadable, very wide) count as false.
 */
export async function singleRepository(root: string): Promise<boolean> {
  let inside = false;
  for (let path = root, depth = 0; !inside && depth < 128; depth++) {
    inside = await hasGit(path);
    if (dirname(path) === path) break;
    path = dirname(path);
  }
  if (!inside) return false;
  const children = await readdir(root, { withFileTypes: true })
    .then(entries => entries.filter(entry => entry.isDirectory() && entry.name !== '.git'), () => undefined);
  if (!children || children.length > 1000) return false;
  return (await Promise.all(children.map(entry => hasGit(join(root, entry.name))))).filter(Boolean).length < 2;
}

/** Who is acting on a shared session right now. Re-evaluated on every check, so a lapsed grant takes effect mid-turn. */
export interface Caller {
  /** Everything this person may hold, within the policy ceiling; anything else is refused without a prompt. */
  permissions: readonly Permission[];
  /** Permissions in `permissions` that need no approval click. */
  preapproved?: readonly Permission[];
}

/** Host-owned, in-memory authority. Never deserialize this object from model/client input. */
export class SessionGrants {
  private granted = new Set<Permission>();
  private caller?: () => Caller;
  private constructor(private current: string, private readonly ceiling: readonly Permission[]) {}
  get root(): string { return this.current; }
  /** Code mode grants write and shell up front only in a single repository; elsewhere they are requested on first need. */
  static async create(cwd: string, config: Config, mode: Mode, web = false): Promise<SessionGrants> {
    const state = new SessionGrants(await realpath(cwd), [...config.policy.permissions]);
    const repository = mode !== 'code' ? [] : await singleRepository(state.root) ? repositoryPermissions : ['repository.read'];
    for (const permission of ['inference', ...repository, ...(web ? ['web.search'] : [])] as Permission[]) {
      if (state.ceiling.includes(permission)) state.granted.add(permission);
    }
    if (!state.granted.has('repository.read')) for (const permission of repositoryPermissions) state.granted.delete(permission);
    return state;
  }
  /** Narrow this session to whoever is speaking. Sessions without a caller are limited only by the policy ceiling. */
  setCaller(caller?: () => Caller): void { this.caller = caller; }
  list(): Permission[] { return permissions.filter(permission => this.allows(permission)); }
  available(): Permission[] {
    const caller = this.caller?.();
    return caller ? this.ceiling.filter(permission => caller.permissions.includes(permission)) : [...this.ceiling];
  }
  allows(permission: Permission): boolean { return this.granted.has(permission) && this.available().includes(permission); }
  async request(requested: Permission[], reason: string, approve: Approve, signal?: AbortSignal,
    emit?: (type: string, fields: Record<string, unknown>) => Promise<void>): Promise<boolean> {
    signal?.throwIfAborted();
    const needed = withPrerequisites(requested);
    const available = this.available();
    if (needed.some(permission => !available.includes(permission))) return false;
    const missing = needed.filter(permission => !this.allows(permission));
    if (!missing.length) return true;
    const preapproved = this.caller?.().preapproved ?? [];
    if (missing.every(permission => preapproved.includes(permission))) {
      for (const permission of missing) this.granted.add(permission);
      await emit?.('grant_granted', { permissions: missing, cwd: this.root });
      return true;
    }
    await emit?.('grant_requested', { permissions: missing, cwd: this.root });
    const approved = await approve({ kind: 'capability', permissions: missing, cwd: this.root, duration: 'session',
      summary: `Allow ${missing.join(', ')} for this session?`,
      details: `Repository: ${this.root}\nReason: ${reason}\nAccess lasts until revoked or this session exits. Existing action approvals still apply.`, signal });
    signal?.throwIfAborted();
    if (approved) for (const permission of missing) this.granted.add(permission);
    await emit?.(approved ? 'grant_granted' : 'grant_denied', { permissions: missing, cwd: this.root });
    return approved;
  }
  /**
   * Moves the session to another directory. Write and shell never follow; read follows only in Code
   * mode and only if still held, so a revocation carries too. Anything more is requested for the new root.
   */
  async reroot(cwd: string, mode: Mode, onEvent?: EventSink): Promise<void> {
    const root = await realpath(cwd);
    if (!(await stat(root)).isDirectory()) throw new Error(`Not a directory: ${root}`);
    if (root === this.current) return;
    const keep: Permission[] = mode === 'code' && this.granted.has('repository.read') ? ['repository.read'] : [];
    const revoked = repositoryPermissions.filter(value => !keep.includes(value) && this.granted.delete(value));
    const from = this.current;
    this.current = root;
    onEvent?.({ type: 'root_changed', from, cwd: root, revoked, permissions: this.list() });
  }
  revoke(permission: Permission, onEvent?: EventSink): void {
    const removed = (permission === 'repository.read' ? repositoryPermissions : [permission]).filter(value => this.granted.delete(value));
    if (removed.length) onEvent?.({ type: 'grant_revoked', permissions: removed, cwd: this.root });
  }
}
