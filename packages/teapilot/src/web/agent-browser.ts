import { execFile } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { mkdir, realpath, writeFile } from 'node:fs/promises';
import { createServer, type Server } from 'node:http';
import { delimiter, dirname, join } from 'node:path';
import { exists } from '../config.js';

/** The agent-browser release teapilot installs for itself; its npm tarball must match the checksum. */
export const agentBrowserRelease = {
  version: '0.38.1',
  url: 'https://registry.npmjs.org/agent-browser/-/agent-browser-0.38.1.tgz',
  sha256: '89a7df4761ff335e4dd5367e4cf04cecb9ba4e2cc130a0220f798d188414dc6c',
};

/** The native binary's name inside the npm package, or undefined where no build is published. */
export function nativeName(platform: string = process.platform, arch: string = process.arch, musl = isMusl()): string | undefined {
  if (platform === 'win32') return arch === 'x64' ? 'agent-browser-win32-x64.exe' : undefined;
  if (platform === 'darwin') return ['arm64', 'x64'].includes(arch) ? `agent-browser-darwin-${arch}` : undefined;
  if (platform === 'linux') return ['arm64', 'x64'].includes(arch) ? `agent-browser-linux-${musl ? 'musl-' : ''}${arch}` : undefined;
  return undefined;
}
function isMusl(): boolean {
  if (process.platform !== 'linux') return false;
  const report = process.report?.getReport() as { header?: { glibcVersionRuntime?: string } } | undefined;
  return !report?.header?.glibcVersionRuntime;
}

export const managedDirectory = (stateDir: string): string => join(stateDir, 'tools', 'agent-browser');
export const managedBinary = (stateDir: string): string | undefined => { const name = nativeName(); return name && join(managedDirectory(stateDir), name); };

/**
 * The native agent-browser executable. npm's `.cmd` and `.js` launchers are never run: the first needs a
 * shell, which would interpret characters in URLs, and the second needs a newer Node than teapilot.
 */
export async function findAgentBrowser(stateDir: string, configured?: string, path = process.env.PATH ?? ''): Promise<string | undefined> {
  if (configured) return await native(configured);
  const managed = managedBinary(stateDir);
  if (managed && await exists(managed)) return managed;
  const name = nativeName();
  if (!name) return undefined;
  for (const directory of path.split(delimiter).filter(Boolean)) {
    if (process.platform === 'win32') {
      if (await exists(join(directory, 'agent-browser.exe'))) return join(directory, 'agent-browser.exe');
      const packaged = join(directory, 'node_modules', 'agent-browser', 'bin', name);
      if (await exists(join(directory, 'agent-browser.cmd')) && await exists(packaged)) return packaged;
    } else if (await exists(join(directory, 'agent-browser'))) {
      const found = await native(join(directory, 'agent-browser'));
      if (found) return found;
    }
  }
  return undefined;
}
async function native(path: string): Promise<string | undefined> {
  const real = await realpath(path).catch(() => undefined);
  if (!real) return undefined;
  if (/\.(cmd|bat|ps1)$/i.test(real)) return undefined;
  if (!/\.js$/i.test(real)) return real;
  const name = nativeName();
  const sibling = name && join(dirname(real), name);
  return sibling && await exists(sibling) ? sibling : undefined;
}

export interface MirrorPage { contentType: string; text: string }
/**
 * Serves one already-fetched page to agent-browser on a private loopback URL. agent-browser makes its own
 * requests and ignores proxy settings, so it is only ever given this address: the page, its `.md` variant
 * (fetched through the controller on demand), and 404 for everything else, including llms.txt probes whose
 * links would otherwise be followed to other hosts. Nothing here redirects.
 */
export async function withMirror<T>(page: MirrorPage, markdown: () => Promise<MirrorPage | undefined>, use: (url: string) => Promise<T>): Promise<T> {
  const token = randomBytes(16).toString('hex');
  let variant: Promise<MirrorPage | undefined> | undefined;
  const server: Server = createServer((request, response) => {
    const send = (found?: MirrorPage) => {
      if (!found) { response.writeHead(404, { 'content-type': 'text/plain' }); response.end('Not found'); return; }
      response.writeHead(200, { 'content-type': `${found.contentType}; charset=utf-8`, 'cache-control': 'no-store' });
      response.end(found.text);
    };
    if (request.method !== 'GET') return send();
    if (request.url === `/${token}`) return send(page);
    if (request.url === `/${token}.md`) { variant ??= markdown().catch(() => undefined); void variant.then(send); return; }
    send();
  });
  await new Promise<void>((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
  try {
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('Mirror has no address');
    return await use(`http://127.0.0.1:${address.port}/${token}`);
  } finally {
    await new Promise<void>(resolve => { server.close(() => resolve()); server.closeAllConnections(); });
  }
}

export interface AgentBrowserResult { content: string; source?: string }
export type Runner = (bin: string, args: string[], options: { cwd: string; env: NodeJS.ProcessEnv; signal?: AbortSignal; timeoutMs: number }) => Promise<string>;
export const runAgentBrowser: Runner = (bin, args, options) => new Promise((resolve, reject) => {
  execFile(bin, args, { cwd: options.cwd, env: options.env, signal: options.signal, timeout: options.timeoutMs, windowsHide: true, shell: false, maxBuffer: 1024 * 1024 },
    (error, stdout) => error && !stdout ? reject(error) : resolve(stdout));
});

/**
 * Reads a mirror URL with agent-browser. It runs in its own session and namespace with an empty config,
 * so a person's own agent-browser settings, sessions and proxies neither apply here nor are changed.
 */
export async function agentBrowserRead(bin: string, url: string, stateDir: string, options: { signal?: AbortSignal; timeoutMs?: number; run?: Runner } = {}): Promise<AgentBrowserResult> {
  const home = managedDirectory(stateDir);
  await mkdir(home, { recursive: true });
  const config = join(home, 'teapilot-config.json');
  if (!await exists(config)) await writeFile(config, '{}\n');
  const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !/^(AGENT_BROWSER_|(HTTPS?|ALL|NO)_PROXY$)/i.test(key)));
  const timeoutMs = options.timeoutMs ?? 15_000;
  const stdout = await (options.run ?? runAgentBrowser)(bin, ['read', url, '--json', '--timeout', String(timeoutMs - 2000), '--session', 'teapilot', '--namespace', 'teapilot', '--idle-timeout', '2m', '--config', config],
    { cwd: home, env, signal: options.signal, timeoutMs });
  let parsed: { success?: boolean; data?: { content?: unknown; source?: unknown }; error?: unknown };
  try { parsed = JSON.parse(stdout.trim().split('\n').at(-1) ?? ''); } catch { throw new Error('agent-browser returned output that is not JSON'); }
  if (!parsed.success || typeof parsed.data?.content !== 'string') throw new Error(`agent-browser could not read the page: ${String(parsed.error ?? 'no content')}`);
  return { content: parsed.data.content, source: typeof parsed.data.source === 'string' ? parsed.data.source : undefined };
}
