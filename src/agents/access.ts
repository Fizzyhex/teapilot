import type { AgentTool } from '@earendil-works/pi-agent-core';
import { Type } from '@earendil-works/pi-ai';
import { permissions, type Permission } from '../execution/grants.js';
import type { Approve } from '../execution/policy.js';

/** Who is speaking and the operations they may ask for; the host builds this, never the model. */
export interface AccessAdmin {
  role: 'operator' | 'user';
  senderId: string;
  list(): { operators: string[]; users: Array<{ id: string; grants: Array<{ permission: Permission; expiresAt: string }> }> };
  addUser(id: string, by: string): 'added' | 'exists' | 'operator';
  removeUser(id: string): boolean;
  grant(id: string, permission: Permission, durationMs: number, by: string): string;
  revoke(id: string, permission?: Permission): number;
  parseDuration(text: string): number;
}

const text = (value: string) => ({ content: [{ type: 'text' as const, text: value }], details: {} });
const grantable = permissions.filter(permission => !['inference', 'web.search'].includes(permission));
const permissionSchema = Type.Union(grantable.map(permission => Type.Literal(permission)));
const idSchema = Type.String({ description: 'Discord user ID (17–20 digits), e.g. from a <@id> mention.' });

/**
 * Natural-language access management. Operators get management tools; everyone else may only ask.
 * Every change needs an approval click, and only operators can click, so text in a quoted message or
 * tool result cannot change access on its own. Roles are checked here, not by the model.
 */
export function accessTools(access: AccessAdmin, approve: Approve): AgentTool[] {
  const confirm = (summary: string, details: string, signal?: AbortSignal) => approve({ kind: 'access', summary, details, signal });
  const guard = async (run: () => Promise<string> | string) => { try { return text(await run()); } catch (error) { return text(error instanceof Error ? error.message : String(error)); } };

  if (access.role !== 'operator') return [{
    name: 'request_access', label: 'Request access',
    description: 'Ask the operators for temporary extra access on behalf of the current sender. An operator must approve it; nothing is granted until then.',
    parameters: Type.Object({ permission: permissionSchema, duration: Type.String({ description: 'How long, e.g. 30m, 2h, 1d.' }), reason: Type.String({ maxLength: 500 }) }),
    execute: async (_id, args, signal) => guard(async () => {
      const { permission, duration, reason } = args as { permission: Permission; duration: string; reason: string };
      if (!grantable.includes(permission)) return 'That permission cannot be requested.';
      const ms = access.parseDuration(duration);
      if (!await confirm(`Give <@${access.senderId}> ${permission} for ${duration.trim()}?`, `Requested by <@${access.senderId}>.\nReason: ${String(reason).slice(0, 500)}`, signal)) return 'An operator did not approve this request.';
      return `Granted ${permission} until ${access.grant(access.senderId, permission, ms, access.senderId)}.`;
    }),
  }];

  return [
    {
      name: 'access_list', label: 'List access',
      description: 'List operators, whitelisted users and their active temporary grants.',
      parameters: Type.Object({}),
      execute: async () => guard(() => {
        const { operators, users } = access.list();
        return `Operators: ${operators.map(id => `<@${id}>`).join(', ') || 'none'}\nUsers (inference and web search): ${users.length ? users.map(user => `<@${user.id}>${user.grants.length ? ` [${user.grants.map(grant => `${grant.permission} until ${grant.expiresAt}`).join('; ')}]` : ''}`).join(', ') : 'none'}`;
      }),
    },
    {
      name: 'access_add_user', label: 'Whitelist user',
      description: 'Whitelist a Discord user so they can use teapilot with inference and web search. Use when an operator asks to let someone in.',
      parameters: Type.Object({ userId: idSchema }),
      execute: async (_id, args, signal) => guard(async () => {
        const { userId } = args as { userId: string };
        if (!await confirm(`Whitelist <@${userId}>?`, 'They will be able to use teapilot with inference and web search.', signal)) return 'An operator did not approve this.';
        const result = access.addUser(userId, access.senderId);
        return result === 'added' ? `<@${userId}> is whitelisted.` : result === 'exists' ? `<@${userId}> was already whitelisted.` : `<@${userId}> is an operator.`;
      }),
    },
    {
      name: 'access_remove_user', label: 'Remove user',
      description: 'Remove a whitelisted user and all of their temporary grants. Operators cannot be removed this way.',
      parameters: Type.Object({ userId: idSchema }),
      execute: async (_id, args, signal) => guard(async () => {
        const { userId } = args as { userId: string };
        if (!await confirm(`Remove <@${userId}>?`, 'Their whitelist entry and temporary grants will be deleted.', signal)) return 'An operator did not approve this.';
        return access.removeUser(userId) ? `<@${userId}> was removed.` : `<@${userId}> was not a whitelisted user.`;
      }),
    },
    {
      name: 'access_grant', label: 'Grant temporary access',
      description: 'Give a whitelisted user an extra permission that expires. Always requires a duration; there are no permanent grants.',
      parameters: Type.Object({ userId: idSchema, permission: permissionSchema, duration: Type.String({ description: 'e.g. 30m, 2h, 1d (max 30d).' }) }),
      execute: async (_id, args, signal) => guard(async () => {
        const { userId, permission, duration } = args as { userId: string; permission: Permission; duration: string };
        if (!grantable.includes(permission)) return 'Only repository permissions can be granted; users already have inference and web search.';
        const ms = access.parseDuration(duration);
        if (!await confirm(`Give <@${userId}> ${permission} for ${duration.trim()}?`, 'Access lapses automatically at the expiry time.', signal)) return 'An operator did not approve this.';
        return `Granted ${permission} to <@${userId}> until ${access.grant(userId, permission, ms, access.senderId)}.`;
      }),
    },
    {
      name: 'access_revoke', label: 'Revoke access',
      description: 'End a user’s temporary grant early: one permission, or all when none is named.',
      parameters: Type.Object({ userId: idSchema, permission: Type.Optional(permissionSchema) }),
      execute: async (_id, args, signal) => guard(async () => {
        const { userId, permission } = args as { userId: string; permission?: Permission };
        if (!await confirm(`Revoke ${permission ?? 'all temporary access'} from <@${userId}>?`, 'Takes effect immediately, including mid-conversation.', signal)) return 'An operator did not approve this.';
        return `Revoked ${access.revoke(userId, permission)} grant(s) from <@${userId}>.`;
      }),
    },
  ];
}
