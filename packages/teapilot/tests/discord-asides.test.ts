import { readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { afterEach, expect, it } from 'vitest';
import { AccessStore } from '../src/discord/access-store.js';
import { AsideStore, type SideAnswer } from '../src/discord/aside-store.js';
import { TurnQueue } from '../src/discord/bridge.js';
import { summariser } from '../src/discord/summarise.js';
import type { HostRequest, HostResult } from '../src/host.js';
import { fixture } from './helpers.js';

const cleanups: Array<() => unknown> = [];
afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup(); });

const answer: SideAnswer = {
  userId: 'op', question: '/btw what is oolong?',
  parts: [{ text: 'Oolong is a partly oxidised tea ([source](https://example.com/oolong)).\n-# this is an aside - not part of the main convo.', files: [{ name: 'leaf.png', data: Buffer.from([1, 2, 3]) }] }],
};

it('keeps compact side answers on disk, files and all, and forgets the oldest past its limit', async () => {
  const f = await fixture(); cleanups.push(f.cleanup);
  const store = new AsideStore(join(f.cwd, 'asides'), 2);
  const first = store.keep(answer);
  expect(store.find(first)).toEqual(answer);
  expect(new AsideStore(store.directory).find(first)?.parts[0]!.files[0]!.data).toEqual(Buffer.from([1, 2, 3]));
  expect(store.find('../secret')).toBeUndefined();
  expect(store.find('missing')).toBeUndefined();

  await new Promise(resolve => setTimeout(resolve, 20));
  store.keep(answer);
  await new Promise(resolve => setTimeout(resolve, 20));
  store.keep(answer);
  expect(await readdir(store.directory)).toHaveLength(2);
  expect(store.find(first)).toBeUndefined();
});

it('summarises a side answer as its asker, with inference only, and without the aside note', async () => {
  const f = await fixture(); cleanups.push(f.cleanup);
  const access = AccessStore.at(join(f.cwd, 'discord'), ['op'], f.config.policy.permissions);
  const requests: HostRequest[] = [];
  const run = async (request: HostRequest): Promise<HostResult> => {
    requests.push(request);
    return { requestId: 'r', success: true, status: 'completed', text: '```\nOolong is [partly oxidised](https://example.com/oolong).\n```', spentUsd: 0, receipts: [], attempts: 1 };
  };
  const summarise = summariser({ config: f.config, root: f.cwd, access, queue: new TurnQueue(), run });

  expect(await summarise(answer)).toBe('Oolong is [partly oxidised](https://example.com/oolong).');
  const [request] = requests;
  expect(request!.prompt).toContain('what is oolong?');
  expect(request!.prompt).not.toContain('/btw');
  expect(request!.prompt).toContain('https://example.com/oolong');
  expect(request!.prompt).not.toContain('this is an aside');
  expect(request!.authorization?.allows('inference')).toBe(true);
  expect(request!.authorization?.allows('web.search')).toBe(false);

  await expect(summarise({ ...answer, userId: 'stranger' })).rejects.toThrow(/no longer have teapilot access/);
});
