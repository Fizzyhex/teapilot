import type { AgentTool } from '@earendil-works/pi-agent-core';
import { Type } from '@earendil-works/pi-ai';
import { permissions, type Permission } from '../execution/grants.js';
import type { Approve } from '../execution/policy.js';

/** Who is speaking and the operations they may ask for; the host builds this, never the model. */
export interface AccessAdmin {
  role: 'operator' | 'user';
  senderId: string;
  /** Looks up a Discord username; undefined when unknown or unavailable. */
  username?(id: string): Promise<string | undefined>;
  list(): { operators: string[]; users: Array<{ id: string; name?: string; expiresAt?: string; grants: Array<{ permission: Permission; expiresAt?: string }> }> };
  addUser(id: string, by: string, options?: { name?: string; durationMs?: number }): 'added' | 'updated' | 'operator';
  removeUser(id: string): boolean;
  grant(id: string, permission: Permission, durationMs: number | undefined, by: string): string | undefined;
  revoke(id: string, permission?: Permission): number;
  parseDuration(text: string): number;
}

const text = (value: string) => ({ content: [{ type: 'text' as const, text: value }], details: {} });
const grantable = permissions.filter(permission => !['inference', 'web.search'].includes(permission));
const permissionSchema = Type.Union(grantable.map(permission => Type.Literal(permission)));
const idSchema = Type.String({ description: 'Discord user ID (17–20 digits) copied character for character from a <@id> mention in the message. Always a string; never round or retype it.' });

/**
 * Natural-language access management. Operators get management tools; everyone else may only ask.
 * Every change needs an approval click, and only operators can click, so text in a quoted message or
 * tool result cannot change access on its own. Roles are checked here, not by the model.
 */
export function accessTools(access: AccessAdmin, approve: Approve, prompt = ''): AgentTool[] {
  const known = [...new Set(prompt.match(/\d{17,20}/g) ?? [])];
  /** Models emit long IDs as rounded numbers (…653500 for …653514); snap to the ID actually written in the message. */
  const resolveId = (value: unknown): string => {
    const id = String(value).trim().replace(/^<@!?(\d+)>$/, '$1');
    if (known.length === 0 || known.includes(id)) return id;
    if (!/^\d+$/.test(id)) throw new Error(`"${String(value)}" is not a Discord user ID. IDs in the message: ${known.join(', ')}.`);
    const distance = (other: string) => { const gap = BigInt(other) - BigInt(id); return gap < 0n ? -gap : gap; };
    const ranked = known.map(other => ({ other, gap: distance(other) })).sort((a, b) => (a.gap < b.gap ? -1 : a.gap > b.gap ? 1 : 0));
    const [best, next] = ranked;
    if (best!.gap > 1_000_000n || (next && next.gap === best!.gap)) throw new Error(`User ID ${id} does not match any ID in the message (${known.join(', ')}). Retry with the exact ID.`);
    return best!.other;
  };
  const confirm = (summary: string, details: string, signal?: AbortSignal) => approve({ kind: 'access', summary, details, signal });
  const guard = async (run: () => Promise<string> | string) => { try { return text(await run()); } catch (error) { return text(error instanceof Error ? error.message : String(error)); } };

  if (access.role !== 'operator') return [{
    name: 'request_access', label: 'Request access',
    description: 'Ask the operators for extra access on behalf of the current sender, for a limited time or (if no duration is given) until revoked. An operator must approve it; nothing is granted until then.',
    parameters: Type.Object({ permission: permissionSchema, duration: Type.Optional(Type.String({ description: 'e.g. 30m, 2h, 1d. Omit for access until revoked.' })), reason: Type.String({ maxLength: 500 }) }),
    execute: async (_id, args, signal) => guard(async () => {
      const { permission, duration, reason } = args as { permission: Permission; duration?: string; reason: string };
      if (!grantable.includes(permission)) return 'That permission cannot be requested.';
      const ms = duration === undefined ? undefined : access.parseDuration(duration);
      if (!await confirm(`Give <@${access.senderId}> ${permission} ${duration ? `for ${duration.trim()}` : 'until revoked'}?`, `Requested by <@${access.senderId}>.\nReason: ${String(reason).slice(0, 500)}`, signal)) return 'An operator did not approve this request.';
      const until = access.grant(access.senderId, permission, ms, access.senderId);
      return `Granted ${permission} ${until ? `until ${until}` : 'until revoked'}.`;
    }),
  }];

  return [
    {
      name: 'access_list', label: 'List access',
      description: 'List operators, whitelisted users and their active grants.',
      parameters: Type.Object({}),
      execute: async () => guard(async () => {
        const { operators, users } = access.list();
        const who = async (id: string, stored?: string) => {
          const name = await access.username?.(id).catch(() => undefined) ?? stored;
          return `${id}${name ? ` (@${name})` : ''}`;
        };
        const operatorLines = await Promise.all(operators.map(id => who(id)));
        const userLines = await Promise.all(users.map(async user => `${await who(user.id, user.name)}${user.expiresAt ? ` until ${user.expiresAt}` : ''}${user.grants.length ? ` [${user.grants.map(grant => `${grant.permission}${grant.expiresAt ? ` until ${grant.expiresAt}` : ' until revoked'}`).join('; ')}]` : ''}`));
        return `Operators: ${operatorLines.join(', ') || 'none'}\nUsers (inference and web search): ${userLines.join(', ') || 'none'}`;
      }),
    },
    {
      name: 'access_add_user', label: 'Whitelist user',
      description: 'Whitelist a Discord user so they can use teapilot with inference and web search. Use when an operator asks to let someone in. Give a duration when they should only have temporary access; without one the access is permanent. Calling it again for a whitelisted user changes their expiry.',
      parameters: Type.Object({ userId: idSchema, duration: Type.Optional(Type.String({ description: 'e.g. 2h, 1d (max 30d). Omit for permanent access.' })) }),
      execute: async (_id, args, signal) => guard(async () => {
        const { duration } = args as { duration?: string }; const userId = resolveId((args as { userId: unknown }).userId);
        const durationMs = duration === undefined ? undefined : access.parseDuration(duration);
        const name = await access.username?.(userId).catch(() => undefined);
        const label = `<@${userId}>${name ? ` (@${name})` : ''}`;
        if (!await confirm(`Whitelist ${label}${duration ? ` for ${duration.trim()}` : ''}?`, `They will be able to use teapilot with inference and web search${duration ? ', until the time runs out' : ''}.`, signal)) return 'An operator did not approve this.';
        const result = access.addUser(userId, access.senderId, { name, durationMs });
        return result === 'operator' ? `${label} is an operator.` : `${label} is ${result === 'added' ? 'whitelisted' : 'updated'}${duration ? ` for ${duration.trim()}` : ' permanently'}.`;
      }),
    },
    {
      name: 'access_remove_user', label: 'Remove user',
      description: 'Remove a whitelisted user and all of their grants. Operators cannot be removed this way.',
      parameters: Type.Object({ userId: idSchema }),
      execute: async (_id, args, signal) => guard(async () => {
        const userId = resolveId((args as { userId: unknown }).userId);
        if (!await confirm(`Remove <@${userId}>?`, 'Their whitelist entry and grants will be deleted.', signal)) return 'An operator did not approve this.';
        return access.removeUser(userId) ? `<@${userId}> was removed.` : `<@${userId}> was not a whitelisted user.`;
      }),
    },
    {
      name: 'access_grant', label: 'Grant access',
      description: 'Give a whitelisted user an extra permission, for a limited time or, if no duration is given, until revoked.',
      parameters: Type.Object({ userId: idSchema, permission: permissionSchema, duration: Type.Optional(Type.String({ description: 'e.g. 30m, 2h, 1d (max 30d). Omit for access until revoked.' })) }),
      execute: async (_id, args, signal) => guard(async () => {
        const { permission, duration } = args as { permission: Permission; duration?: string }; const userId = resolveId((args as { userId: unknown }).userId);
        if (!grantable.includes(permission)) return 'Only repository permissions can be granted; users already have inference and web search.';
        const ms = duration === undefined ? undefined : access.parseDuration(duration);
        if (!await confirm(`Give <@${userId}> ${permission} ${duration ? `for ${duration.trim()}` : 'until revoked'}?`, duration ? 'Access lapses automatically at the expiry time.' : 'Access lasts until an operator revokes it.', signal)) return 'An operator did not approve this.';
        const until = access.grant(userId, permission, ms, access.senderId);
        return `Granted ${permission} to <@${userId}> ${until ? `until ${until}` : 'until revoked'}.`;
      }),
    },
    {
      name: 'access_revoke', label: 'Revoke access',
      description: 'End a user’s extra permission grant early: one permission, or all when none is named.',
      parameters: Type.Object({ userId: idSchema, permission: Type.Optional(permissionSchema) }),
      execute: async (_id, args, signal) => guard(async () => {
        const { permission } = args as { permission?: Permission }; const userId = resolveId((args as { userId: unknown }).userId);
        if (!await confirm(`Revoke ${permission ?? 'all extra access'} from <@${userId}>?`, 'Takes effect immediately, including mid-conversation.', signal)) return 'An operator did not approve this.';
        return `Revoked ${access.revoke(userId, permission)} grant(s) from <@${userId}>.`;
      }),
    },
  ];
}
