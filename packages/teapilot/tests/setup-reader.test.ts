import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { afterEach, expect, it } from 'vitest';
import { configureReader, type ReaderSetupIO } from '../src/setup/reader.js';
import type { SetupUI } from '../src/setup/terminal.js';
import { nativeName } from '../src/web/agent-browser.js';
import { fixture } from './helpers.js';

const cleanup: Array<() => Promise<void>> = [];
afterEach(async () => { for (const fn of cleanup.splice(0).reverse()) await fn(); });

function ui(pick: (choices: string[]) => number, confirm = true) {
  const logs: string[] = [], menus: string[][] = [];
  const screen = {
    log: (message: string) => { logs.push(message); },
    choose: async (_message: string, choices: string[]) => { menus.push(choices); return pick(choices); },
    confirm: async () => confirm,
    input: async () => '',
    activity: () => {}, clearActivity: () => {},
  } as unknown as SetupUI;
  return { screen, logs, menus };
}
const io = (overrides: Partial<ReaderSetupIO> = {}): ReaderSetupIO => ({
  fetch: async () => new Response('not the release'),
  extract: async () => { throw new Error('should not extract'); },
  check: async () => true,
  ...overrides,
});

it('refuses a download that does not match the pinned checksum', async () => {
  const f = await fixture(); cleanup.push(f.cleanup);
  const env: Record<string, string> = {};
  const { screen, menus } = ui(choices => choices.findIndex(choice => choice.startsWith('Install')));
  const status = await configureReader(f.config, env, screen, new AbortController().signal, io());
  expect(menus[0]).toEqual(expect.arrayContaining(['Built-in reader', 'Turn page reading off']));
  expect(status).toContain('install failed');
  expect(env).toEqual({});
});

it('uses an agent-browser that passes the check, and falls back when it does not', async () => {
  const f = await fixture(); cleanup.push(f.cleanup);
  const bin = join(f.cwd, nativeName()!); await writeFile(bin, '');
  const env: Record<string, string> = { AGENT_BROWSER_BIN: bin };
  const pickUse = (choices: string[]) => choices.findIndex(choice => choice.startsWith('Use agent-browser'));
  expect(await configureReader(f.config, env, ui(pickUse).screen, new AbortController().signal, io())).toBe('pages: agent-browser');
  expect(env).toEqual({ WEB_READER: 'agent-browser', AGENT_BROWSER_BIN: bin });
  expect(f.config.webReader).toEqual({ mode: 'agent-browser', agentBrowserBin: bin });
  expect(await configureReader(f.config, env, ui(pickUse).screen, new AbortController().signal, io({ check: async () => false }))).toContain('check failed');
  expect(env).toEqual({ WEB_READER: 'builtin' });
});

it('can turn page reading off or keep the current setting', async () => {
  const f = await fixture(); cleanup.push(f.cleanup);
  const env: Record<string, string> = {};
  expect(await configureReader(f.config, env, ui(choices => choices.indexOf('Turn page reading off')).screen, new AbortController().signal, io())).toBe('pages: page reading off');
  expect(env).toEqual({ WEB_READER: 'off' });
  expect(await configureReader(f.config, env, ui(choices => choices.findIndex(choice => choice.startsWith('Keep'))).screen, new AbortController().signal, io())).toBe('pages: off');
  expect(env).toEqual({ WEB_READER: 'off' });
});
