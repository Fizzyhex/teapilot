import { afterEach, expect, it } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { BIO_LIMIT, MESSAGE_LIMIT, openRoom, type Message } from 'teachat';
import { MAX_POSTS, teachatTools } from '../src/teachat/tools.js';

const roots: string[] = [];
afterEach(async () => { for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true }); });

async function setup() {
  const dir = await mkdtemp(join(tmpdir(), 'teapilot-teachat-tools-')); roots.push(dir);
  const room = await openRoom({ dir });
  const posts: Message[] = [], bios: string[] = [];
  const [msg, reply, bio] = teachatTools(room, { identity: 'pip', channels: ['offtopic', 'ysk'], redact: text => text.replaceAll('hunter2', '[redacted]'),
    onPost: message => posts.push(message), onBio: value => bios.push(value) });
  const call = (tool: typeof msg, args: Record<string, unknown>) => tool!.execute('call', args as never);
  return { room, posts, bios, msg: (args: Record<string, unknown>) => call(msg, args), reply: (args: Record<string, unknown>) => call(reply, args), bio: (args: Record<string, unknown>) => call(bio, args) };
}

it('always posts as the session identity and redacts what it posts', async () => {
  const { room, posts, msg, reply } = await setup();
  expect((await msg({ channel: 'offtopic', text: 'my password is hunter2', author: 'daniel', kind: 'event' })).content[0]).toMatchObject({ text: expect.stringMatching(/^Posted #\d+ in #offtopic\.$/) });
  const first = posts[0]!;
  await reply({ channel: 'offtopic', message: first.n, text: 'replying', author: 'juner' });
  const log = (await room.read('offtopic')).filter(message => message.kind === 'message');
  expect(log.map(message => [message.author, message.text, message.replyTo])).toEqual([['pip', 'my password is [redacted]', undefined], ['pip', 'replying', first.n]]);
  expect(posts.map(message => message.n)).toEqual(log.map(message => message.n));
});

it('enforces length caps, missing replies and the post limit', async () => {
  const { room, posts, bios, msg, reply, bio } = await setup();
  await expect(msg({ channel: 'ysk', text: 'x'.repeat(MESSAGE_LIMIT + 1) })).rejects.toThrow(`limited to ${MESSAGE_LIMIT}`);
  await expect(bio({ bio: 'x'.repeat(BIO_LIMIT + 1) })).rejects.toThrow(`limited to ${BIO_LIMIT}`);
  await expect(reply({ channel: 'ysk', message: 99, text: 'hello?' })).rejects.toThrow('There is no message #99');
  // Rejected posts do not count against the limit.
  for (let i = 0; i < MAX_POSTS; i++) await msg({ channel: 'ysk', text: `tip ${i}` });
  await expect(msg({ channel: 'ysk', text: 'one more' })).rejects.toThrow('said enough');
  await expect(reply({ channel: 'ysk', message: posts[0]!.n, text: 'and another' })).rejects.toThrow('said enough');
  expect((await room.read('ysk')).map(message => message.text)).toEqual(['tip 0', 'tip 1', 'tip 2']);
  expect(bios).toEqual([]);
});

it('updates the session identity bio, redacted', async () => {
  const { room, bios, bio } = await setup();
  await bio({ bio: 'quick answers, hunter2 enjoyer', username: 'daniel' });
  const identities = await room.identities();
  expect(identities.find(identity => identity.username === 'pip')!.bio).toBe('quick answers, [redacted] enjoyer');
  expect(identities.find(identity => identity.username === 'daniel')!.bio).not.toContain('enjoyer');
  expect(bios).toEqual(['quick answers, [redacted] enjoyer']);
});
