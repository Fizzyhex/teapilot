import { readFile, writeFile } from 'node:fs/promises';
import { afterEach, expect, it, vi } from 'vitest';
import { accessTools } from '../src/agents/access.js';
import { route } from '../src/discord/access.js';
import { AccessStore, parseDuration } from '../src/discord/access-store.js';
import { Conversation, TurnQueue, type ConversationOptions, type DiscordTransport } from '../src/discord/bridge.js';
import { SessionGrants, permissions } from '../src/execution/grants.js';
import type { Approve } from '../src/execution/policy.js';
import type { HostResult } from '../src/host.js';
import { fixture } from './helpers.js';

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup(); });

const op = '111111111111111111';
const bob = '222222222222222222';
const eve = '333333333333333333';
let clock = Date.parse('2026-01-01T00:00:00Z');
const hour = 3_600_000;

async function store() {
  const f = await fixture();
  cleanups.push(f.cleanup);
  clock = Date.parse('2026-01-01T00:00:00Z');
  return { f, access: new AccessStore(`${f.cwd}/access.json`, [op], permissions, () => clock) };
}
const reopen = (access: AccessStore) => new AccessStore(access.file, [op], permissions, () => clock);

it('gives operators every permission and users inference plus web search', async () => {
  const { access } = await store();
  access.addUser(bob, op);
  expect(access.roleOf(op)).toBe('operator');
  expect(access.permissionsOf(op)).toEqual(permissions);
  expect(access.roleOf(bob)).toBe('user');
  expect(access.permissionsOf(bob)).toEqual(['inference', 'web.search']);
  expect(access.roleOf(eve)).toBeUndefined();
  expect(access.permissionsOf(eve)).toEqual([]);
});

it('caps everything at the policy ceiling', async () => {
  const { f } = await store();
  const capped = new AccessStore(`${f.cwd}/capped.json`, [op], ['inference', 'repository.read'], () => clock);
  capped.addUser(bob, op);
  expect(capped.permissionsOf(op)).toEqual(['inference', 'repository.read']);
  expect(() => capped.grant(bob, 'repository.shell', hour, op)).toThrow(/disabled/);
});

it('grants temporary access that lapses at its persisted timestamp, across restarts', async () => {
  const { access } = await store();
  access.addUser(bob, op);
  const expires = access.grant(bob, 'repository.write', 2 * hour, op);
  expect(expires).toBe('2026-01-01T02:00:00.000Z');
  expect(access.permissionsOf(bob)).toEqual(['inference', 'repository.read', 'repository.write', 'web.search']);
  clock += hour;
  expect(reopen(access).permissionsOf(bob)).toContain('repository.write');
  clock += hour + 1;
  expect(reopen(access).permissionsOf(bob)).toEqual(['inference', 'web.search']);
  expect(reopen(access).list().users[0]!.grants).toEqual([]);
});

it('revokes one grant or all, and removes users', async () => {
  const { access } = await store();
  access.addUser(bob, op);
  access.grant(bob, 'repository.write', hour, op);
  access.grant(bob, 'repository.shell', hour, op);
  expect(access.revoke(bob, 'repository.write')).toBe(1);
  expect(access.permissionsOf(bob)).toContain('repository.shell');
  expect(access.revoke(bob)).toBe(1);
  expect(access.removeUser(bob)).toBe(true);
  expect(access.roleOf(bob)).toBeUndefined();
});

it('refuses unbounded, oversized or invalid grants and never touches operators', async () => {
  const { access } = await store();
  access.addUser(bob, op);
  expect(() => parseDuration('forever')).toThrow();
  expect(() => parseDuration('31d')).toThrow();
  expect(() => access.grant(bob, 'repository.write', Infinity, op)).toThrow();
  expect(() => access.grant(eve, 'repository.write', hour, op)).toThrow(/not whitelisted/);
  expect(() => access.grant(op, 'repository.write', hour, op)).toThrow(/Operators/);
  expect(access.addUser(op, op)).toBe('operator');
  expect(access.removeUser(op)).toBe(false);
  expect(() => access.addUser('not-an-id', op)).toThrow();
});

it('fails closed on a damaged file: operators keep access, nobody is promoted', async () => {
  const { access } = await store();
  access.addUser(bob, op);
  await writeFile(access.file, '{ nope');
  const damaged = reopen(access);
  expect(damaged.roleOf(bob)).toBeUndefined();
  expect(damaged.roleOf(op)).toBe('operator');
  expect(await readFile(`${access.file}.corrupt`, 'utf8')).toBe('{ nope');
});

it('routes whitelisted users and still ignores strangers and bots', async () => {
  const { access } = await store();
  access.addUser(bob, op);
  const settings = { allowedUserIds: [op], channelId: undefined };
  const message = (authorId: string, authorIsBot = false) => ({ authorId, authorIsBot, channelId: '9', ownThread: false, mentionsBot: false });
  const allowed = (id: string) => access.roleOf(id) !== undefined;
  expect(route(message(op), settings, allowed)?.kind).toBe('dm');
  expect(route(message(bob), settings, allowed)?.kind).toBe('dm');
  expect(route(message(eve), settings, allowed)).toBeUndefined();
  expect(route(message(bob, true), settings, allowed)).toBeUndefined();
  expect(route(message(bob), settings)).toBeUndefined();
});

it('narrows a shared session to whoever is speaking and refuses repository access without asking', async () => {
  const { f, access } = await store();
  access.addUser(bob, op);
  const grants = await SessionGrants.create(f.cwd, f.config, 'code', true);
  const approve = vi.fn<Approve>(async () => true);
  grants.setCaller(access.callerFor(bob));
  expect(grants.allows('repository.write')).toBe(false);
  expect(grants.allows('inference')).toBe(true);
  expect(await grants.request(['repository.shell'], 'test', approve)).toBe(false);
  expect(approve).not.toHaveBeenCalled();
  grants.setCaller(access.callerFor(op));
  expect(grants.allows('inference')).toBe(true);
});

it('lets a user activate web search without a click but asks for temporarily granted repository access', async () => {
  const { f, access } = await store();
  access.addUser(bob, op);
  const grants = await SessionGrants.create(f.cwd, f.config, 'ask');
  const approve = vi.fn<Approve>(async () => true);
  grants.setCaller(access.callerFor(bob));
  expect(await grants.request(['web.search'], 'test', approve)).toBe(true);
  expect(approve).not.toHaveBeenCalled();
  access.grant(bob, 'repository.read', hour, op);
  expect(await grants.request(['repository.read'], 'test', approve)).toBe(true);
  expect(approve).toHaveBeenCalledOnce();
  clock += 2 * hour;
  expect(grants.allows('repository.read')).toBe(false);
});

it('offers management tools to operators only, each behind an approval', async () => {
  const { access } = await store();
  const approve = vi.fn<Approve>(async () => true);
  const names = (id: string) => accessTools(access.adminFor(id)!, approve).map(tool => tool.name);
  access.addUser(bob, op);
  expect(names(op)).toEqual(['access_list', 'access_add_user', 'access_remove_user', 'access_grant', 'access_revoke']);
  expect(names(bob)).toEqual(['request_access']);
  expect(access.adminFor(eve)).toBeUndefined();

  const tool = (name: string) => accessTools(access.adminFor(op)!, approve).find(value => value.name === name)!;
  await tool('access_add_user').execute('1', { userId: eve }, undefined as never, undefined as never);
  expect(access.roleOf(eve)).toBe('user');
  await tool('access_grant').execute('2', { userId: eve, permission: 'repository.read', duration: '1h' }, undefined as never, undefined as never);
  expect(access.permissionsOf(eve)).toContain('repository.read');
  expect(approve).toHaveBeenCalledTimes(2);

  approve.mockResolvedValue(false);
  await tool('access_remove_user').execute('3', { userId: eve }, undefined as never, undefined as never);
  expect(access.roleOf(eve)).toBe('user');
});

it('snaps a rounded user ID to the mention written in the prompt', async () => {
  const { access } = await store();
  const approve = vi.fn<Approve>(async () => true);
  const add = accessTools(access.adminFor(op)!, approve, 'grant <@271788139381653514> access for 12h').find(value => value.name === 'access_add_user')!;
  await add.execute('1', { userId: '271788139381653500', duration: '12h' }, undefined as never, undefined as never);
  expect(approve.mock.calls[0]![0].summary).toContain('<@271788139381653514>');
  expect(access.roleOf('271788139381653514')).toBe('user');
  const far = await add.execute('2', { userId: '999999999999999999' }, undefined as never, undefined as never);
  expect(JSON.stringify(far)).toContain('does not match');
  expect(approve).toHaveBeenCalledTimes(1);
});

it('lets a user request access, which lands only if an operator approves', async () => {
  const { access } = await store();
  access.addUser(bob, op);
  const approve = vi.fn<Approve>(async () => false);
  const request = accessTools(access.adminFor(bob)!, approve)[0]!;
  const call = () => request.execute('1', { permission: 'repository.write', duration: '2h', reason: 'fix a bug' }, undefined as never, undefined as never);
  await call();
  expect(access.permissionsOf(bob)).not.toContain('repository.write');
  approve.mockResolvedValue(true);
  await call();
  expect(access.permissionsOf(bob)).toContain('repository.write');
});

it('resolves permissions per message in a shared conversation', async () => {
  const { f, access } = await store();
  access.addUser(bob, op);
  const grants = await SessionGrants.create(f.cwd, f.config, 'code');
  const seen: Array<{ role?: string; write: boolean }> = [];
  const result: HostResult = { requestId: '', success: true, status: 'completed', text: 'ok', spentUsd: 0, receipts: [], attempts: 1 };
  const transport: DiscordTransport = { send: vi.fn(async () => '1'), edit: vi.fn(async () => undefined), typing: vi.fn(), askApproval: vi.fn(async () => true) };
  const controller = new AbortController();
  const run = vi.fn<ConversationOptions['run']>(async request => { seen.push({ role: request.access?.role, write: request.authorization!.allows('repository.write') }); return result; });
  const chat = new Conversation({ key: 'thread:1', transport, queue: new TurnQueue(), maxPromptChars: 20_000, log: vi.fn(), redact: text => text, access,
    request: { prompt: '', cwd: f.cwd, mode: 'code', authorization: grants, signal: controller.signal }, run });
  cleanups.push(async () => { controller.abort(); await chat.done; });
  chat.push('as operator', { sender: op });
  await vi.waitFor(() => expect(seen).toHaveLength(1));
  chat.push('as user', { sender: bob });
  await vi.waitFor(() => expect(seen).toHaveLength(2));
  chat.push('no sender');
  await vi.waitFor(() => expect(seen).toHaveLength(3));
  expect(seen[0]!.role).toBe('operator');
  expect(seen[1]).toEqual({ role: 'user', write: false });
  expect(seen[2]).toEqual({ role: undefined, write: false });
});

it('whitelists a user temporarily and drops them, with their grants, when time runs out', async () => {
  const { access } = await store();
  expect(access.addUser(bob, op, { durationMs: 2 * hour })).toBe('added');
  access.grant(bob, 'repository.read', hour, op);
  expect(access.list().users[0]!.expiresAt).toBe('2026-01-01T02:00:00.000Z');
  clock += hour;
  expect(reopen(access).roleOf(bob)).toBe('user');
  clock += hour;
  const later = reopen(access);
  expect(later.roleOf(bob)).toBeUndefined();
  expect(later.permissionsOf(bob)).toEqual([]);
  expect(later.list().users).toEqual([]);
  expect(access.addUser(bob, op)).toBe('added');
  expect(access.addUser(bob, op, { durationMs: hour })).toBe('updated');
  expect(() => access.addUser(bob, op, { durationMs: 5 })).toThrow();
});

it('lists usernames, from Discord when available and from the last seen name otherwise', async () => {
  const { access } = await store();
  access.addUser(bob, op, { name: 'bobby' });
  access.rememberName(bob, 'bob_renamed');
  access.rememberName(eve, 'stranger');
  expect(access.list().users[0]!.name).toBe('bob_renamed');
  expect(reopen(access).list().users[0]!.name).toBe('bob_renamed');
  const tool = (admin = access.adminFor(op)!) => accessTools(admin, async () => true).find(value => value.name === 'access_list')!;
  const text = async () => JSON.stringify((await tool().execute('1', {}, undefined as never, undefined as never)).content);
  expect(await text()).toContain(`${bob} (@bob_renamed)`);
  access.lookup = async id => id === op ? 'boss' : id === bob ? 'bob_live' : undefined;
  const listed = await text();
  expect(listed).toContain(`${op} (@boss)`);
  expect(listed).toContain(`${bob} (@bob_live)`);
});

it('keeps a grant without a duration until it is revoked', async () => {
  const { access } = await store();
  access.addUser(bob, op);
  expect(access.grant(bob, 'repository.write', undefined, op)).toBeUndefined();
  clock += 365 * 24 * hour;
  expect(reopen(access).permissionsOf(bob)).toContain('repository.write');
  expect(reopen(access).list().users[0]!.grants).toEqual([{ permission: 'repository.write', expiresAt: undefined }]);
  expect(access.revoke(bob, 'repository.write')).toBe(1);
  expect(access.permissionsOf(bob)).not.toContain('repository.write');
});
