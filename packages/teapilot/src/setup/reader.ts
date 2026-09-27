import { createHash } from 'node:crypto';
import { chmod, mkdir, rename, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { during } from '../activity.js';
import type { Config } from '../config.js';
import { command } from '../runtime/process.js';
import { agentBrowserRead, agentBrowserRelease, findAgentBrowser, managedBinary, managedDirectory, nativeName, withMirror } from '../web/agent-browser.js';
import type { SetupUI } from './terminal.js';

export interface ReaderSetupIO {
  fetch: typeof fetch;
  /** Extracts one member of a .tgz into a directory. */
  extract: (archive: string, directory: string, member: string, signal: AbortSignal) => Promise<void>;
  /** Whether agent-browser reads a page teapilot serves it. */
  check: (bin: string, stateDir: string) => Promise<boolean>;
}
const tar = () => process.platform === 'win32' ? join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'tar.exe') : 'tar';
export const defaultReaderIO: ReaderSetupIO = {
  fetch: (...args) => fetch(...args),
  extract: async (archive, directory, member, signal) => { await command(tar(), ['-xzf', archive, '-C', directory, member], signal); },
  check: async (bin, stateDir) => {
    const page = { contentType: 'text/html', text: '<main><h1>teapilot check</h1><p>page reading works</p></main>' };
    const result = await withMirror(page, async () => undefined, url => agentBrowserRead(bin, url, stateDir)).catch(() => undefined);
    return Boolean(result?.content.includes('page reading works'));
  },
};

/**
 * How web.search sessions read pages. agent-browser is optional: teapilot can install a pinned copy for
 * itself (checksum verified, only the native binary extracted, no install scripts run), use one found on
 * PATH, or read pages with its built-in extraction.
 */
export async function configureReader(config: Config, env: Record<string, string>, ui: SetupUI, signal: AbortSignal, io: ReaderSetupIO = defaultReaderIO): Promise<string> {
  const managed = managedBinary(config.stateDir);
  const found = await findAgentBrowser(config.stateDir, env.AGENT_BROWSER_BIN).catch(() => undefined);
  const current = env.WEB_READER === 'off' ? 'off' : env.WEB_READER === 'builtin' ? 'built-in' : found ? 'agent-browser' : 'built-in';
  const choices: Array<[string, () => Promise<string>]> = [];
  if (found) choices.push([`Use agent-browser at ${found}`, () => use(found, found === managed ? undefined : found)]);
  if (nativeName() && found !== managed) choices.push([`Install agent-browser ${agentBrowserRelease.version} for teapilot`, install]);
  choices.push(['Built-in reader', async () => set('builtin', 'built-in reader')]);
  choices.push([`Keep current (${current})`, async () => `pages: ${current}`]);
  choices.push(['Turn page reading off', async () => set('off', 'page reading off')]);
  ui.log('Page reading lets web research open pages from search results. Local and private network addresses are never read.');
  const choice = await ui.choose('Page reading · Optional', choices.map(([label]) => label), choices.length - 2);
  return await choices[choice]![1]();

  function set(mode: 'agent-browser' | 'builtin' | 'off', label: string, bin?: string): string {
    env.WEB_READER = mode;
    if (bin) env.AGENT_BROWSER_BIN = bin; else delete env.AGENT_BROWSER_BIN;
    config.webReader = { mode, agentBrowserBin: bin };
    return `pages: ${label}`;
  }
  async function use(bin: string, configured?: string): Promise<string> {
    if (!await during(ui, 'Checking agent-browser...', () => io.check(bin, config.stateDir))) {
      ui.log('agent-browser did not read the check page, so the built-in reader stays in use.');
      return set('builtin', 'built-in reader (agent-browser check failed)');
    }
    ui.log('agent-browser: PASS.');
    return set('agent-browser', 'agent-browser', configured);
  }
  async function install(): Promise<string> {
    const name = nativeName()!, directory = managedDirectory(config.stateDir);
    if (!await ui.confirm(`Download agent-browser ${agentBrowserRelease.version} (Apache-2.0, about 53 MB) from npm into ${directory}? Only its ${name} binary is kept, no install scripts run, and nothing outside that folder changes.`)) return `pages: ${current} (install declined)`;
    try {
      await during(ui, 'Downloading agent-browser...', async () => {
        await mkdir(directory, { recursive: true });
        const response = await io.fetch(agentBrowserRelease.url, { signal: AbortSignal.any([signal, AbortSignal.timeout(10 * 60 * 1000)]) });
        if (!response.ok) throw new Error(`npm returned HTTP ${response.status}`);
        const bytes = Buffer.from(await response.arrayBuffer());
        if (createHash('sha256').update(bytes).digest('hex') !== agentBrowserRelease.sha256) throw new Error('the download did not match its pinned checksum');
        const archive = join(directory, 'agent-browser.tgz');
        await writeFile(archive, bytes);
        try {
          await io.extract(archive, directory, `package/bin/${name}`, signal);
          await rename(join(directory, 'package', 'bin', name), join(directory, name));
          if (process.platform !== 'win32') await chmod(join(directory, name), 0o755);
        } finally { await rm(archive, { force: true }); await rm(join(directory, 'package'), { recursive: true, force: true }); }
      });
    } catch (error) {
      signal.throwIfAborted();
      ui.log(`agent-browser install failed: ${error instanceof Error ? error.message : 'unknown error'}. Pages are read with the built-in reader.`);
      return `pages: ${current} (agent-browser install failed)`;
    }
    return await use(join(directory, name));
  }
}
