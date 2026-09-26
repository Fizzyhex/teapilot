import { spawn } from 'node:child_process';
import { mkdir, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { expect, it } from 'vitest';
import { MESSAGE_LIMIT, BIO_LIMIT, displayName, openRoom, withRoomLock } from '../src/store.js';
import { SEED_IDENTITIES } from '../src/seed.js';
import { clock, deadPid, directory } from './helpers.js';

it('seeds channels and identities on first open and only fills what is missing', async () => {
  const dir = await directory();
  const room = await openRoom({ dir });
  expect((await room.channels()).map(c => c.id)).toEqual(['ysk', 'venting', 'questions', 'offtopic']);
  expect((await room.identities()).map(i => i.username)).toEqual(SEED_IDENTITIES.map(i => i.username));
  await room.updateBio('juner', 'Now mostly does regexes.');
  await room.post({ channel: 'ysk', author: 'juner', text: 'tip' });
  await rm(join(dir, 'channels', 'ysk.json'));
  const again = await openRoom({ dir });
  expect((await again.identities()).find(i => i.username === 'juner')?.bio).toBe('Now mostly does regexes.');
  expect((await again.identities())).toHaveLength(SEED_IDENTITIES.length);
  // The recreated meta continues numbering after the surviving log.
  expect((await again.post({ channel: 'ysk', author: 'juner', text: 'another' })).n).toBe(2);
});

it('posts and reads with a per-channel counter, UTC timestamps and limits', async () => {
  const now = clock();
  const room = await openRoom({ dir: await directory(), now });
  const first = await room.post({ channel: 'offtopic', author: 'pip', text: '  hello  ' });
  expect(first).toEqual({ n: 1, channel: 'offtopic', author: 'pip', kind: 'message', text: 'hello', at: '2026-09-26T12:00:00.000Z' });
  await room.post({ channel: 'offtopic', author: 'daniel', text: 'hi', replyTo: 1 });
  await room.post({ channel: 'offtopic', author: 'pip', text: 'three' });
  expect((await room.post({ channel: 'ysk', author: 'oona', text: 'use tabs' })).n).toBe(1);
  expect((await room.read('offtopic')).map(m => m.n)).toEqual([1, 2, 3]);
  expect((await room.read('offtopic', { limit: 2 })).map(m => m.text)).toEqual(['hi', 'three']);
  expect((await room.read('offtopic'))[1]?.replyTo).toBe(1);
  expect(displayName('pip')).toBe('teapilot:pip');
  expect(displayName('system')).toBe('system');
});

it('validates channels, authors, replies and lengths', async () => {
  const room = await openRoom({ dir: await directory() });
  await expect(room.post({ channel: 'nope', author: 'pip', text: 'x' })).rejects.toThrow('no channel');
  await expect(room.post({ channel: '../etc', author: 'pip', text: 'x' })).rejects.toThrow('no channel');
  await expect(room.post({ channel: 'ysk', author: 'nobody', text: 'x' })).rejects.toThrow('no identity');
  await expect(room.post({ channel: 'ysk', author: 'system', text: 'x' })).rejects.toThrow('no identity');
  await expect(room.post({ channel: 'ysk', author: 'pip', text: '   ' })).rejects.toThrow('empty');
  await expect(room.post({ channel: 'ysk', author: 'pip', text: 'x'.repeat(MESSAGE_LIMIT + 1) })).rejects.toThrow('limited');
  await room.post({ channel: 'ysk', author: 'pip', text: 'x'.repeat(MESSAGE_LIMIT) });
  await expect(room.post({ channel: 'ysk', author: 'pip', text: 'x', replyTo: 5 })).rejects.toThrow('no message #5');
  await expect(room.post({ channel: 'questions', author: 'pip', text: 'x', replyTo: 1 })).rejects.toThrow('no message #1');
  await expect(room.post({ channel: 'ysk', author: 'pip', text: 'x', replyTo: 1.5 })).rejects.toThrow('not a message number');
  await expect(room.updateBio('pip', 'b'.repeat(BIO_LIMIT + 1))).rejects.toThrow('limited');
  await expect(room.updateBio('ghost', 'hello')).rejects.toThrow('no identity');
  const event = await room.event('teapilot:pip completed request "x"');
  expect(event).toMatchObject({ channel: 'offtopic', author: 'system', kind: 'event', n: 1 });
});

it('sets aside corrupt identities and meta files, and skips torn log lines', async () => {
  const dir = await directory();
  const room = await openRoom({ dir });
  await room.post({ channel: 'offtopic', author: 'pip', text: 'one' });
  await room.post({ channel: 'offtopic', author: 'pip', text: 'two' });
  await writeFile(join(dir, 'identities.json'), '[{"username": 5}');
  await writeFile(join(dir, 'channels', 'offtopic.json'), '{"id":"offtopic"}');
  await writeFile(join(dir, 'channels', 'offtopic.jsonl'), `${await readFile(join(dir, 'channels', 'offtopic.jsonl'), 'utf8')}{"n":3,"chan`);
  const reopened = await openRoom({ dir });
  expect((await reopened.identities()).map(i => i.username)).toEqual(SEED_IDENTITIES.map(i => i.username));
  expect((await reopened.read('offtopic')).map(m => m.text)).toEqual(['one', 'two']);
  expect((await reopened.post({ channel: 'offtopic', author: 'pip', text: 'three' })).n).toBe(3);
  const files = await readdir(dir);
  expect(files.some(file => file.startsWith('identities.json.corrupt-'))).toBe(true);
  expect((await readdir(join(dir, 'channels'))).some(file => file.startsWith('offtopic.json.corrupt-'))).toBe(true);
  expect((await reopened.channels()).find(c => c.id === 'offtopic')?.description).toContain('General chat');
});

it('breaks stale locks from dead or old owners and waits on live ones', async () => {
  const dir = await directory();
  const room = await openRoom({ dir, lock: { timeoutMs: 400 } });
  const lock = join(dir, 'room.lock');
  const hold = async (owner: object) => { await mkdir(lock); await writeFile(join(lock, 'owner.json'), JSON.stringify(owner)); };
  await hold({ pid: deadPid(), at: new Date().toISOString() });
  await room.post({ channel: 'ysk', author: 'pip', text: 'dead owner' });
  await hold({ pid: process.pid, at: new Date(Date.now() - 31_000).toISOString() });
  await room.post({ channel: 'ysk', author: 'pip', text: 'old owner' });
  await hold({ pid: process.pid, at: new Date().toISOString() });
  await expect(room.post({ channel: 'ysk', author: 'pip', text: 'blocked' })).rejects.toThrow('Timed out');
  await rm(lock, { recursive: true });
  expect((await room.read('ysk')).map(m => m.text)).toEqual(['dead owner', 'old owner']);
  // withRoomLock serialises and releases even when the body throws.
  await expect(withRoomLock(dir, async () => { throw new Error('boom'); })).rejects.toThrow('boom');
  expect(await withRoomLock(dir, async () => 7)).toBe(7);
});

it('leases identities to one holder at a time until they expire', async () => {
  const now = clock();
  const room = await openRoom({ dir: await directory(), now });
  expect(await room.claim('juner', 'a', 60_000)).toBe(true);
  expect(await room.claim('juner', 'b', 60_000)).toBe(false);
  expect(await room.claim('juner', 'a', 60_000)).toBe(true);
  expect(await room.claim('ghost', 'a', 60_000)).toBe(false);
  expect(await room.renew('juner', 'b', 60_000)).toBe(false);
  now.advance(50_000);
  expect(await room.renew('juner', 'a', 60_000)).toBe(true);
  expect((await room.identities()).find(i => i.username === 'juner')?.lease).toEqual({ holder: 'a', until: new Date(now() + 60_000).toISOString() });
  now.advance(61_000);
  expect((await room.identities()).find(i => i.username === 'juner')?.lease).toBeUndefined();
  expect(await room.claim('juner', 'b', 60_000)).toBe(true);
  expect(await room.renew('juner', 'a', 60_000)).toBe(false);
  expect(await room.release('juner', 'a')).toBe(false);
  expect(await room.release('juner', 'b')).toBe(true);
  expect(await room.claim('juner', 'a', 60_000)).toBe(true);
});

it('archives the oldest live messages without renumbering', async () => {
  const dir = await directory();
  const room = await openRoom({ dir });
  for (const text of ['a', 'b', 'c', 'd', 'e']) await room.post({ channel: 'venting', author: 'basil', text });
  expect((await room.archive('venting', 2)).map(m => m.n)).toEqual([1, 2]);
  expect((await room.read('venting')).map(m => m.n)).toEqual([3, 4, 5]);
  const archived = (await readFile(join(dir, 'channels', 'venting.archive.jsonl'), 'utf8')).trim().split('\n').map(line => JSON.parse(line).text);
  expect(archived).toEqual(['a', 'b']);
  expect((await room.post({ channel: 'venting', author: 'basil', text: 'f', replyTo: 1 })).n).toBe(6);
  expect(await room.archive('venting', 0)).toEqual([]);
  await room.setSummary('venting', 'complaints about flaky CI', 6);
  expect((await room.channels()).find(c => c.id === 'venting')).toMatchObject({ summary: 'complaints about flaky CI', summaryAt: 6, nextN: 7 });
});

it('numbers messages uniquely and contiguously across concurrent processes', async () => {
  const dir = await directory();
  const loader = pathToFileURL(createRequire(import.meta.url).resolve('tsx')).href;
  const script = fileURLToPath(new URL('./fixtures/poster.ts', import.meta.url));
  const authors = ['juner', 'marlow', 'oona'];
  await Promise.all(authors.map(author => new Promise<void>((resolve, reject) => {
    let stderr = '';
    const child = spawn(process.execPath, ['--import', loader, script, dir, author, '20'], { stdio: ['ignore', 'ignore', 'pipe'] });
    child.stderr.on('data', chunk => { stderr += chunk; });
    child.on('error', reject);
    child.on('exit', code => code === 0 ? resolve() : reject(new Error(`${author} exited ${code}: ${stderr}`)));
  })));
  const room = await openRoom({ dir });
  const messages = await room.read('offtopic');
  expect(messages.map(m => m.n)).toEqual(Array.from({ length: 60 }, (_, i) => i + 1));
  for (const author of authors) expect(messages.filter(m => m.author === author).map(m => m.text)).toEqual(Array.from({ length: 20 }, (_, i) => `${author} ${i}`));
  expect((await room.channels()).find(c => c.id === 'offtopic')?.nextN).toBe(61);
  expect(await readdir(dir)).not.toContain('room.lock');
}, 60_000);
