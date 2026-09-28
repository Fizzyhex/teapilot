import { during, type ActivityUI } from '../activity.js';
import type { Config } from '../config.js';
import type { SandboxStatus } from './sandbox.js';
import { pandocAsset, pandocRelease, pythonPackages, toolsFolder, type PythonInfo } from './toolchain.js';

export interface WorkspaceUI extends ActivityUI {
  confirm(message: string): Promise<boolean>;
  log(message: string): void;
}

/** What configuring workspaces touches; tests use their own. */
export interface WorkspaceIO {
  platform: NodeJS.Platform;
  /** A fresh check of the sandbox and the tools it can run. */
  status(config: Config): Promise<SandboxStatus>;
  /** Windows only: the srt-sandbox account and its firewall rules; false when the administrator prompt is declined. */
  installWindows(): Promise<boolean>;
  /** Whether pandoc publishes a build for this platform. */
  pandocAvailable(): boolean;
  installPandoc(stateDir: string, signal: AbortSignal): Promise<unknown>;
  installPythonPackages(stateDir: string, python: PythonInfo, signal: AbortSignal): Promise<unknown>;
}

export const defaultWorkspaceIO: WorkspaceIO = {
  platform: process.platform,
  status: async config => {
    const { SrtSandbox } = await import('./sandbox.js');
    const sandbox = new SrtSandbox(config.stateDir, config.workspace, config.source?.directory);
    try { return await sandbox.status(); } finally { await sandbox.close(); }
  },
  installWindows: async () => (await import('./sandbox.js')).installWindowsSandbox(),
  pandocAvailable: () => Boolean(pandocAsset()),
  installPandoc: async (stateDir, signal) => (await import('./toolchain.js')).installPandoc(stateDir, signal),
  installPythonPackages: async (stateDir, python, signal) => (await import('./toolchain.js')).installPythonPackages(stateDir, python, signal),
};

const linuxPackages: Record<string, string> = { bwrap: 'bubblewrap', socat: 'socat', ripgrep: 'ripgrep' };
const systemPackages: Record<string, string> = { ffmpeg: 'ffmpeg', imagemagick: 'imagemagick', python: 'python3', node: 'nodejs' };

/**
 * Workspace commands are optional. This checks the sandbox, offers its one-time install on Windows (or the packages
 * to install on Linux), offers teapilot's own pandoc and Python packages, and reports what commands can use.
 */
export async function configureWorkspace(config: Config, ui: WorkspaceUI, signal: AbortSignal, io: WorkspaceIO = defaultWorkspaceIO): Promise<SandboxStatus> {
  const check = () => during(ui, 'Checking workspace sandbox...', () => io.status(config));
  let status = await check();
  if (!status.available && io.platform === 'win32' && /not set up/.test(status.reason ?? '')
    && await ui.confirm('Set up the Windows sandbox for workspace commands? It adds a local srt-sandbox account and firewall rules for it, after one administrator prompt.')) {
    ui.log(await io.installWindows() ? 'Workspace sandbox: installed.' : 'Workspace sandbox: install cancelled; nothing changed.');
    status = await check();
  }
  if (!status.available) {
    ui.log(`Workspace commands: OFF (${status.reason})`);
    const missing = Object.entries(linuxPackages).filter(([name]) => status.reason?.includes(name)).map(([, name]) => name);
    if (io.platform === 'linux' && missing.length) ui.log(`Install them with your package manager, for example: sudo apt install ${missing.join(' ')}`);
    return status;
  }
  // pandoc and the Python packages are teapilot's to install: one pinned copy, read-only to every workspace.
  const has = (kind: string) => status.tools.some(tool => tool.kind === kind);
  const python = status.python;
  const offers = [
    ...!has('pandoc') && io.pandocAvailable() ? [{ name: 'pandoc', label: `pandoc ${pandocRelease.version} (GPL-2.0, about 40 MB from GitHub, checked against its pinned checksum)`, install: () => io.installPandoc(config.stateDir, signal) }] : [],
    ...pythonPackages.some(entry => !has(entry.name.toLowerCase())) && python ? [{ name: 'Python packages', label: `${pythonPackages.map(entry => `${entry.name} ${entry.version}`).join(', ')} (prebuilt, from PyPI for ${python.executable})`, install: () => io.installPythonPackages(config.stateDir, python, signal) }] : [],
  ];
  if (offers.length && await ui.confirm(`Install ${offers.map(offer => offer.label).join(' and ')} into ${toolsFolder(config.stateDir)} for workspace commands? Commands can read them there but not change them.`)) {
    for (const offer of offers) {
      await during(ui, `Installing ${offer.name}...`, offer.install).catch(error => {
        signal.throwIfAborted();
        ui.log(`${offer.name} install failed: ${error instanceof Error ? error.message : String(error)}`);
      });
    }
    status = await check();
  }
  ui.log(`Workspace commands: sandboxed ${status.shell}; ${status.tools.length ? status.tools.map(tool => `${tool.name} ${tool.version}`).join(', ') : 'no media tools found'}`);
  const missing = Object.keys(systemPackages).filter(kind => !has(kind));
  if (missing.length) ui.log(`Workspace tools not found inside the sandbox: ${missing.join(', ')}. ${io.platform === 'win32'
    ? 'Install them for all users (for example under Program Files); per-user installs are invisible to the sandbox account.'
    : `Install them with your package manager, for example: sudo apt install ${missing.map(kind => systemPackages[kind]).join(' ')}.`}`);
  return status;
}
