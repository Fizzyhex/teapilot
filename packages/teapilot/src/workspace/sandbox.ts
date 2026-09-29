import { execFile, spawn } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { copyFile, mkdir, readFile, rm, stat } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { StringDecoder } from 'node:string_decoder';
import { promisify } from 'node:util';
import type { SandboxRuntimeConfig } from '@anthropic-ai/sandbox-runtime';
import { cleanChildEnvironment } from '../execution/policy.js';
import { packagesFolder, pandocFolder, pythonAbi, pythonPackages, toolsFolder, type PythonInfo } from './toolchain.js';

/** How workspace commands are sandboxed: WORKSPACE_SANDBOX, WORKSPACE_ALLOWED_DOMAINS and WORKSPACE_DENIED_DOMAINS. */
export interface WorkspaceSettings {
  /** off turns workspace commands off; auto uses the sandbox wherever it is installed. */
  sandbox: 'auto' | 'off';
  /** Hosts commands reach without asking, such as an internal package mirror. */
  allowedDomains: string[];
  /** Hosts commands never reach, even when someone approves them. */
  deniedDomains: string[];
}
export const defaultWorkspaceSettings: WorkspaceSettings = { sandbox: 'auto', allowedDomains: [], deniedDomains: [] };
export const runLimits = { defaultSeconds: 60, maxSeconds: 300, outputChars: 8000 };

/** A tool commands can use: its command, what it is, and its version. */
export interface Tool { name: string; kind: string; version: string }
export interface SandboxStatus {
  available: boolean;
  reason?: string;
  shell: 'bash' | 'powershell';
  tools: Tool[];
  /** The Python commands run, which teapilot's own packages must be installed for. */
  python?: PythonInfo;
}
export interface RunOptions {
  timeoutSeconds: number;
  signal?: AbortSignal;
  /** Asked when the command connects to a host that is neither allowed nor denied; true lets it through. */
  network(host: string): Promise<boolean>;
  /** Receives all of the output as it arrives, before any of it is left out. */
  tee?(text: string): void;
}
/** `clipped` says part of the output was left out of `output`. */
export interface RunResult { exitCode: number | null; output: string; timedOut: boolean; cancelled: boolean; clipped?: boolean }

/** Runs commands with a workspace folder as the only place they can write; tests use their own. */
export interface WorkspaceSandbox {
  status(): Promise<SandboxStatus>;
  run(folder: string, command: string, options: RunOptions): Promise<RunResult>;
}

/** The tools workspace commands are told about, each checked by running it inside the sandbox. */
const probes: Array<{ name: string; commands: string[] }> = [
  { name: 'ffmpeg', commands: ['ffmpeg -hide_banner -version'] },
  { name: 'imagemagick', commands: ['magick -version', 'convert -version'] },
  { name: 'python', commands: ['python3 --version', 'python --version'] },
  { name: 'pandoc', commands: ['pandoc --version'] },
  { name: 'node', commands: ['node --version'] },
];
const versionOf = (name: string, output: string): string | undefined => {
  const line = output.split(/\r?\n/).find(text => text.trim())?.trim() ?? '';
  const version = line.match(/(\d+\.\d+(?:\.\d+)?(?:-\d+)?)/)?.[1] ?? (name === 'ffmpeg' ? line.match(/version (\S+)/)?.[1] : undefined);
  return version;
};

/** The first and last part of long output, which is where errors and results are. */
export function clip(text: string, limit: number): string {
  if (text.length <= limit) return text;
  const head = Math.floor(limit / 4);
  return `${text.slice(0, head)}\n[… ${text.length - limit} characters left out …]\n${text.slice(text.length - (limit - head))}`;
}

const execFileAsync = promisify(execFile);
const windows = process.platform === 'win32';

/** Windows only: creates the srt-sandbox account and its firewall rules, after one administrator prompt. False when declined. */
export async function installWindowsSandbox(): Promise<boolean> {
  const srt = await import('@anthropic-ai/sandbox-runtime');
  const result = await srt.installWindowsSandboxAsync({ srtWin: srt.resolveSrtWin({ path: srt.VENDORED_SRT_WIN_EXE }) });
  return !result.cancelled;
}

/**
 * Commands in a workspace run under the Anthropic Sandbox Runtime (srt): bubblewrap on Linux, Seatbelt on macOS, and
 * a dedicated srt-sandbox account on Windows. They can read the system and write only their own workspace; home,
 * teapilot's state and its configuration stay out of reach, and the network is closed except for hosts people approve.
 * The sandbox is configured for one workspace at a time, so runs take turns; teapilot's turns already do.
 */
export class SrtSandbox implements WorkspaceSandbox {
  private checked?: Promise<SandboxStatus>;
  private tail: Promise<unknown> = Promise.resolve();
  private current?: string;
  private active?: RunOptions;
  /** Network questions waiting for a person; a command's time does not run out while it waits for one. */
  private asking = 0;
  private srtWin?: { path: string };
  /** teapilot's own tools and Python packages, when installed: before the system's on PATH, and on PYTHONPATH. */
  private toolPath: string[] = [];
  private pythonPath?: string;
  private readonly probeFolder: string;

  constructor(private readonly stateDir: string, private readonly settings: WorkspaceSettings = defaultWorkspaceSettings, private readonly configDir?: string) {
    this.probeFolder = join(stateDir, 'workspaces', 'probe');
  }

  status(): Promise<SandboxStatus> { return this.checked ??= this.check(); }

  private async check(): Promise<SandboxStatus> {
    const shell = windows ? 'powershell' : 'bash';
    const unavailable = (reason: string): SandboxStatus => ({ available: false, reason, shell, tools: [] });
    if (this.settings.sandbox === 'off') return unavailable('Workspace commands are turned off (WORKSPACE_SANDBOX=off).');
    let srt: typeof import('@anthropic-ai/sandbox-runtime');
    try { srt = await import('@anthropic-ai/sandbox-runtime'); } catch (error) { return unavailable(`The sandbox runtime could not load: ${error instanceof Error ? error.message : String(error)}`); }
    if (!srt.SandboxManager.isSupportedPlatform()) return unavailable(`The sandbox does not support ${process.platform}.`);
    if (windows) {
      const reason = await this.prepareWindows(srt).catch(error => error instanceof Error ? error.message : String(error));
      if (reason) return unavailable(reason);
    } else {
      const dependencies = await srt.SandboxManager.checkDependenciesAsync();
      if (dependencies.errors.length) return unavailable(`The sandbox needs ${dependencies.errors.join('; ')}.`);
    }
    try { await mkdir(this.probeFolder, { recursive: true }); await this.session(this.probeFolder); }
    catch (error) { return unavailable(`The sandbox could not start: ${error instanceof Error ? error.message : String(error)}`); }
    const pandoc = pandocFolder(this.stateDir);
    if (await stat(join(pandoc, windows ? 'pandoc.exe' : 'pandoc')).catch(() => undefined)) this.toolPath = [pandoc];
    const tools: Tool[] = [];
    const probe = (command: string) => this.execute(this.probeFolder, command, { timeoutSeconds: 20, network: async () => false }).catch(() => undefined);
    let python: PythonInfo & { command: string } | undefined;
    for (const { name, commands } of probes) {
      for (const command of commands) {
        const result = await probe(command);
        const version = result?.exitCode === 0 ? versionOf(name, result.output) : undefined;
        if (!version) continue;
        tools.push({ name: command.split(' ')[0]!, kind: name, version });
        if (name === 'python') python = await this.python(command.split(' ')[0]!, probe);
        break;
      }
      if (name === 'python' && python) tools.push(...await this.packages(python.command, probe));
    }
    return { available: true, shell, tools, ...python ? { python: { executable: python.executable, abi: python.abi } } : {} };
  }

  /** Which of the packages teapilot installs Python can already import, from teapilot's folder or the system's. */
  private async packages(command: string, probe: (command: string) => Promise<RunResult | undefined>): Promise<Tool[]> {
    const result = await probe(`${command} -c "import importlib.metadata as m; print(*(d.metadata['Name'] + ' ' + d.version for d in m.distributions()), sep=chr(10))"`);
    const normal = (name: string) => name.toLowerCase().replace(/[-_.]+/g, '-');
    const found = new Map((result?.exitCode === 0 ? result.output.split(/\r?\n/) : []).map(line => line.trim().split(' ') as [string, string?]).map(([name, version]) => [normal(name), version]));
    return pythonPackages.flatMap(entry => {
      const version = found.get(normal(entry.name));
      return version ? [{ name: entry.name, kind: normal(entry.name), version }] : [];
    });
  }

  /** Where the sandbox's Python lives and which ABI it has; teapilot's packages for that ABI go on PYTHONPATH. */
  private async python(command: string, probe: (command: string) => Promise<RunResult | undefined>): Promise<PythonInfo & { command: string } | undefined> {
    const result = await probe(`${command} -c "import sys, sysconfig; print(sys.executable); print(sysconfig.get_config_var('EXT_SUFFIX') or '')"`);
    const [executable, suffix] = result?.exitCode === 0 ? result.output.split(/\r?\n/).map(line => line.trim()) : [];
    const abi = suffix ? pythonAbi(suffix) : undefined;
    if (!executable || !abi) return undefined;
    const packages = packagesFolder(this.stateDir, abi);
    // Their commands, such as yt-dlp, sit in bin.
    if (await stat(packages).catch(() => undefined)) { this.pythonPath = packages; this.toolPath.push(join(packages, 'bin')); }
    return { command, executable, abi };
  }

  /**
   * Windows runs commands as the srt-sandbox account, which a one-time `srt windows-install` creates. That account
   * starts srt's helper, so the helper must sit where the account can read it: a copy in teapilot's tools folder.
   */
  private async prepareWindows(srt: typeof import('@anthropic-ai/sandbox-runtime')): Promise<string | undefined> {
    const vendored = { path: srt.VENDORED_SRT_WIN_EXE };
    const user = await srt.getWindowsSandboxUserStatusAsync({ srtWin: srt.resolveSrtWin(vendored) });
    if (!user.provisioned || !user.credPresent || !user.sid) return 'The Windows sandbox account is not set up. Run `teapilot doctor` for the one-time install (one administrator prompt).';
    const digest = createHash('sha256').update(await readFile(srt.VENDORED_SRT_WIN_EXE)).digest('hex').slice(0, 16);
    const folder = join(this.stateDir, 'tools', 'srt-win', digest);
    const copy = join(folder, 'srt-win.exe');
    if (!await stat(copy).catch(() => undefined)) {
      await mkdir(folder, { recursive: true });
      await copyFile(srt.VENDORED_SRT_WIN_EXE, copy);
    }
    await execFileAsync('icacls', [folder, '/grant', `*${user.sid}:(OI)(CI)RX`], { windowsHide: true });
    // teapilot's own tools and packages, read-only; what is installed there later inherits this.
    const tools = toolsFolder(this.stateDir);
    await mkdir(tools, { recursive: true });
    await execFileAsync('icacls', [tools, '/grant', `*${user.sid}:(OI)(CI)RX`], { windowsHide: true });
    this.srtWin = { path: copy };
    return undefined;
  }

  /** Points the sandbox at `folder`: it alone is writable, and on Windows it alone is granted at all. */
  private async session(folder: string): Promise<void> {
    if (this.current === folder) return;
    const { SandboxManager } = await import('@anthropic-ai/sandbox-runtime');
    await SandboxManager.reset();
    this.current = undefined;
    const home = homedir();
    const nodeFolder = dirname(dirname(process.execPath));
    const config: SandboxRuntimeConfig = {
      network: { allowedDomains: this.settings.allowedDomains, deniedDomains: this.settings.deniedDomains },
      filesystem: windows
        // The sandbox account reads nothing of this user's profile unless granted; the workspace is the only grant.
        ? { denyRead: [], allowRead: [], allowWrite: [folder], denyWrite: [] }
        : { denyRead: [home, this.stateDir, ...this.configDir ? [this.configDir] : []], allowRead: [folder, nodeFolder, join(this.stateDir, 'tools')], allowWrite: [folder], denyWrite: [] },
      ...(this.srtWin ? { windows: { srtWin: this.srtWin } } : {}),
    };
    await SandboxManager.initialize(config, async ({ host }) => {
      const run = this.active;
      if (!run) return false;
      this.asking++;
      try { return await run.network(host); } catch { return false; } finally { this.asking--; }
    });
    this.current = folder;
  }

  run(folder: string, command: string, options: RunOptions): Promise<RunResult> {
    const next = this.tail.then(async () => {
      const status = await this.status();
      if (!status.available) throw new Error(status.reason);
      return this.execute(folder, command, options);
    });
    this.tail = next.catch(() => undefined);
    return next;
  }

  private async execute(folder: string, command: string, options: RunOptions): Promise<RunResult> {
    const { SandboxManager } = await import('@anthropic-ai/sandbox-runtime');
    await this.session(folder);
    const temporary = join(folder, '.tmp');
    await mkdir(temporary, { recursive: true });
    // Tools keep their packages, caches and settings in the workspace rather than a home they share with others.
    const own: Record<string, string> = {
      HOME: folder, TMPDIR: temporary, TMP: temporary, TEMP: temporary,
      PYTHONUSERBASE: join(folder, '.packages'), PIP_USER: '1', PIP_NO_CACHE_DIR: '1', PIP_DISABLE_PIP_VERSION_CHECK: '1', PYTHONDONTWRITEBYTECODE: '1',
      npm_config_cache: join(folder, '.cache', 'npm'), npm_config_update_notifier: 'false', MPLCONFIGDIR: join(folder, '.cache', 'matplotlib'),
      ...(this.pythonPath ? { PYTHONPATH: this.pythonPath } : {}),
      ...(windows ? { USERPROFILE: folder, APPDATA: join(folder, '.appdata'), LOCALAPPDATA: join(folder, '.appdata', 'local') } : {}),
    };
    // Windows starts the command from the sandbox account's own environment and passes only what the command
    // line sets, PATH extended with teapilot's own tools; elsewhere the command inherits the spawn environment,
    // which never carries teapilot's secrets. PowerShell there starts at C:\ although the process starts in the
    // workspace, and runs other programs from its own location. Set-Location to the workspace is refused, since
    // PowerShell reads every folder above it to spell the path, so it moves to a drive rooted at the workspace.
    const quoted = (value: string) => `'${value.replace(/'/g, "''")}'`;
    // srt names its proxy for http and https only. Clients that look a proxy up by URL scheme, such as aiohttp
    // for wss://, then connect directly, which the sandbox drops without asking, so the command hangs.
    const script = windows
      ? [`$null = New-PSDrive -Name W -PSProvider FileSystem -Root ${quoted(folder)}`, 'Set-Location W:\\', ...Object.entries(own).map(([key, value]) => `$env:${key}=${quoted(value)}`), ...this.toolPath.length ? [`$env:PATH=${quoted(`${this.toolPath.join(';')};`)}+$env:PATH`] : [],
        'if ($env:HTTPS_PROXY) { $env:WSS_PROXY=$env:HTTPS_PROXY }', 'if ($env:HTTP_PROXY) { $env:WS_PROXY=$env:HTTP_PROXY }', command].join('; ')
      : `[ -n "\${HTTPS_PROXY:-}" ] && export WSS_PROXY="$HTTPS_PROXY"\n[ -n "\${HTTP_PROXY:-}" ] && export WS_PROXY="$HTTP_PROXY"\n${command}`;
    const commandId = randomUUID();
    // srt hands POSIX commands its own TMPDIR, /tmp/claude unless this names another; one shared by every
    // conversation would let them pass files, so each run gets its workspace's own.
    const shared = process.env.CLAUDE_CODE_TMPDIR;
    if (!windows) process.env.CLAUDE_CODE_TMPDIR = temporary;
    let argv: string[];
    try { ({ argv } = await SandboxManager.wrapWithSandboxArgv(script, windows ? 'powershell' : '/bin/bash', undefined, options.signal, folder, { commandId, commandText: command })); }
    finally { if (shared === undefined) delete process.env.CLAUDE_CODE_TMPDIR; else process.env.CLAUDE_CODE_TMPDIR = shared; }
    const env = { ...cleanChildEnvironment(), ...own, PATH: [join(folder, '.packages', 'bin'), join(folder, 'node_modules', '.bin'), ...this.toolPath, process.env.PATH ?? ''].join(windows ? ';' : ':') };
    this.active = options;
    try {
      return await new Promise<RunResult>(resolve => {
        const child = spawn(argv[0]!, argv.slice(1), { cwd: folder, env, windowsHide: true, detached: !windows, stdio: ['ignore', 'pipe', 'pipe'] });
        let output = '', timedOut = false, cancelled = false, clipped = false;
        const decoders = [new StringDecoder('utf8'), new StringDecoder('utf8')];
        const keep = (index: number) => (chunk: Buffer) => {
          const text = decoders[index]!.write(chunk);
          options.tee?.(text);
          output += text;
          if (output.length > runLimits.outputChars * 8) { output = clip(output, runLimits.outputChars * 4); clipped = true; }
        };
        child.stdout!.on('data', keep(0)); child.stderr!.on('data', keep(1));
        const kill = () => {
          if (child.exitCode !== null || child.pid === undefined) return;
          if (windows) execFile('taskkill', ['/pid', String(child.pid), '/T', '/F'], { windowsHide: true }, () => undefined);
          else try { process.kill(-child.pid, 'SIGKILL'); } catch { child.kill('SIGKILL'); }
        };
        const expire = () => {
          if (this.asking) { timer = setTimeout(expire, 1000); return; }
          timedOut = true; kill();
        };
        let timer = setTimeout(expire, options.timeoutSeconds * 1000);
        const abort = () => { cancelled = true; kill(); };
        options.signal?.addEventListener('abort', abort, { once: true });
        const finish = (exitCode: number | null) => {
          clearTimeout(timer);
          options.signal?.removeEventListener('abort', abort);
          const annotated = SandboxManager.annotateStderrWithSandboxFailures(commandId, output).trim();
          resolve({ exitCode, output: clip(annotated, runLimits.outputChars), timedOut, cancelled, clipped: clipped || annotated.length > runLimits.outputChars });
        };
        child.on('error', error => { output += `\n${error.message}`; finish(null); });
        child.on('close', code => finish(code));
      });
    } finally {
      this.active = undefined;
      await rm(temporary, { recursive: true, force: true }).catch(() => undefined);
    }
  }

  /** Ends the sandbox session once the check and runs under way finish: its proxies stop and Windows grants are taken back. */
  async close(): Promise<void> {
    await this.checked?.catch(() => undefined);
    await this.tail.catch(() => undefined);
    if (this.current === undefined) return;
    const { SandboxManager } = await import('@anthropic-ai/sandbox-runtime');
    await SandboxManager.reset();
    this.current = undefined;
  }
}
