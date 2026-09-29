import { execFile, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { chmod, mkdir, rename, rm, writeFile } from 'node:fs/promises';
import { delimiter, join } from 'node:path';
import { promisify } from 'node:util';

/**
 * Tools teapilot installs for workspace commands when the system lacks them: pandoc, and Python packages.
 * They live under teapilot's state, which sandboxed commands may read but not write, so one copy serves every
 * conversation. ffmpeg, ImageMagick, Python and Node come from the system. ripgrep, for the grep tool, is teapilot's
 * own too, pinned and checked the same way.
 */
export const pandocRelease = {
  version: '3.11',
  /** GitHub release assets by `${platform}-${arch}`, with the checksum GitHub publishes and the binary's path inside. */
  assets: {
    'win32-x64': { file: 'pandoc-3.11-windows-x86_64.zip', sha256: '2ab72baf2399450e148ddf7a2a8689806c42e1bba71862b57e220fd9b8456d3d', binary: 'pandoc-3.11/pandoc.exe' },
    'linux-x64': { file: 'pandoc-3.11-linux-amd64.tar.gz', sha256: '37edb3bbcf722f921a009941bf5874e2e0c09263226c9b4a2d980788cb062ab6', binary: 'pandoc-3.11/bin/pandoc' },
    'linux-arm64': { file: 'pandoc-3.11-linux-arm64.tar.gz', sha256: '56ed5566ec41d22ec9ee0704e6ac0b98ba102e92384efd5306173a22d314c79a', binary: 'pandoc-3.11/bin/pandoc' },
    'darwin-x64': { file: 'pandoc-3.11-x86_64-macOS.zip', sha256: '3b1c1b57f160112c821d02f23d946ede8b7f57a6ccf4632a25a512d334a9291f', binary: 'pandoc-3.11-x86_64/bin/pandoc' },
    'darwin-arm64': { file: 'pandoc-3.11-arm64-macOS.zip', sha256: '15806bedf9517bfead72e88fe6a6696635c3691efbb6e152173440e9c5bb50b4', binary: 'pandoc-3.11-arm64/bin/pandoc' },
  } as Record<string, { file: string; sha256: string; binary: string }>,
};
/** ripgrep for the grep tool, which pi would otherwise download unpinned on first use. */
export const ripgrepRelease = {
  version: '14.1.1',
  assets: {
    'win32-x64': { file: 'ripgrep-14.1.1-x86_64-pc-windows-msvc.zip', sha256: 'd0f534024c42afd6cb4d38907c25cd2b249b79bbe6cc1dbee8e3e37c2b6e25a1', binary: 'ripgrep-14.1.1-x86_64-pc-windows-msvc/rg.exe' },
    'linux-x64': { file: 'ripgrep-14.1.1-x86_64-unknown-linux-musl.tar.gz', sha256: '4cf9f2741e6c465ffdb7c26f38056a59e2a2544b51f7cc128ef28337eeae4d8e', binary: 'ripgrep-14.1.1-x86_64-unknown-linux-musl/rg' },
    'linux-arm64': { file: 'ripgrep-14.1.1-aarch64-unknown-linux-gnu.tar.gz', sha256: 'c827481c4ff4ea10c9dc7a4022c8de5db34a5737cb74484d62eb94a95841ab2f', binary: 'ripgrep-14.1.1-aarch64-unknown-linux-gnu/rg' },
    'darwin-x64': { file: 'ripgrep-14.1.1-x86_64-apple-darwin.tar.gz', sha256: 'fc87e78f7cb3fea12d69072e7ef3b21509754717b746368fd40d88963630e2b3', binary: 'ripgrep-14.1.1-x86_64-apple-darwin/rg' },
    'darwin-arm64': { file: 'ripgrep-14.1.1-aarch64-apple-darwin.tar.gz', sha256: '24ad76777745fbff131c8fbc466742b011f925bfa4fffa2ded6def23b5b937be', binary: 'ripgrep-14.1.1-aarch64-apple-darwin/rg' },
  } as Record<string, { file: string; sha256: string; binary: string }>,
};
/** Python packages every workspace can import, pinned; prebuilt wheels only, so nothing is compiled or run to install them. */
export const pythonPackages = [{ name: 'Pillow', version: '12.3.0' }, { name: 'numpy', version: '2.5.3' }, { name: 'yt-dlp', version: '2026.8.19' }];

/** The Python the sandbox runs, as it reports itself: its executable and the ABI its compiled packages must match. */
export interface PythonInfo { executable: string; abi: string }

export const toolsFolder = (stateDir: string) => join(stateDir, 'tools', 'workspace');
export const pandocFolder = (stateDir: string) => join(toolsFolder(stateDir), 'pandoc', pandocRelease.version);
export const packagesFolder = (stateDir: string, abi: string) => join(toolsFolder(stateDir), 'python', abi);
export const pandocAsset = (platform = process.platform, arch = process.arch) => pandocRelease.assets[`${platform}-${arch}`];
export const ripgrepFolder = (stateDir: string) => join(stateDir, 'tools', 'ripgrep', ripgrepRelease.version);

/** `.cp314-win_amd64.pyd` or `.cpython-312-x86_64-linux-gnu.so` as a folder name, so each interpreter gets matching wheels. */
export function pythonAbi(extensionSuffix: string): string | undefined {
  const abi = extensionSuffix.trim().replace(/^\./, '').replace(/\.(so|pyd)$/i, '').replace(/[^\w.-]/g, '_');
  return abi || undefined;
}

const execFileAsync = promisify(execFile);
const tar = () => process.platform === 'win32' ? join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'tar.exe') : 'tar';
const failure = (error: unknown) => {
  const output = error as { stderr?: string; message?: string };
  return (output.stderr?.trim().split(/\r?\n/).slice(-3).join(' ') || output.message || String(error)).slice(0, 400);
};

/** Downloads the pinned pandoc for this platform, checks it, and keeps only the binary; returns its path. */
export async function installPandoc(stateDir: string, signal: AbortSignal, get: typeof fetch = fetch): Promise<string> {
  const asset = pandocAsset();
  if (!asset) throw new Error(`pandoc publishes no build for ${process.platform} ${process.arch}`);
  return installBinary(`https://github.com/jgm/pandoc/releases/download/${pandocRelease.version}/${asset.file}`, asset, pandocFolder(stateDir), 'pandoc', signal, get);
}

/** Downloads the pinned ripgrep for this platform, checks it, and keeps only the binary; returns its path. */
export async function installRipgrep(stateDir: string, signal: AbortSignal, get: typeof fetch = fetch): Promise<string> {
  const asset = ripgrepRelease.assets[`${process.platform}-${process.arch}`];
  if (!asset) throw new Error(`ripgrep publishes no build for ${process.platform} ${process.arch}`);
  return installBinary(`https://github.com/BurntSushi/ripgrep/releases/download/${ripgrepRelease.version}/${asset.file}`, asset, ripgrepFolder(stateDir), 'rg', signal, get);
}

let ripgrep: Promise<string> | undefined, found: string | undefined;
/**
 * Makes rg findable for pi's grep, which runs the first rg on PATH: the system's, or else teapilot's pinned copy,
 * installed on first use. PI_OFFLINE keeps pi from downloading an unpinned one of its own.
 */
export async function ensureRipgrep(stateDir: string, get: typeof fetch = fetch): Promise<string> {
  process.env.PI_OFFLINE = '1';
  // The copy found before is used again while it is still there.
  if (found && (found === 'rg' || existsSync(found))) return found;
  ripgrep ??= (async () => {
    if (!spawnSync('rg', ['--version'], { stdio: 'ignore', windowsHide: true }).error) return 'rg';
    const folder = ripgrepFolder(stateDir);
    const binary = join(folder, process.platform === 'win32' ? 'rg.exe' : 'rg');
    if (!existsSync(binary)) await installRipgrep(stateDir, AbortSignal.timeout(2 * 60 * 1000), get);
    process.env.PATH = `${folder}${delimiter}${process.env.PATH ?? ''}`;
    return binary;
  })();
  // A failed install is tried again by the next search.
  try { return found = await ripgrep; } finally { ripgrep = undefined; }
}

async function installBinary(url: string, asset: { file: string; sha256: string; binary: string }, folder: string, name: string, signal: AbortSignal, get: typeof fetch): Promise<string> {
  const binary = join(folder, process.platform === 'win32' ? `${name}.exe` : name);
  const response = await get(url, { signal: AbortSignal.any([signal, AbortSignal.timeout(10 * 60 * 1000)]) });
  if (!response.ok) throw new Error(`GitHub returned HTTP ${response.status}`);
  const bytes = Buffer.from(await response.arrayBuffer());
  if (createHash('sha256').update(bytes).digest('hex') !== asset.sha256) throw new Error('the download did not match its pinned checksum');
  await mkdir(folder, { recursive: true });
  const archive = join(folder, asset.file);
  await writeFile(archive, bytes);
  try {
    await execFileAsync(tar(), ['-xf', archive, '-C', folder, asset.binary], { signal, windowsHide: true });
    await rename(join(folder, asset.binary), binary);
    if (process.platform !== 'win32') await chmod(binary, 0o755);
  } catch (error) { throw new Error(failure(error)); }
  finally { await rm(archive, { force: true }); await rm(join(folder, asset.binary.split('/')[0]!), { recursive: true, force: true }); }
  return binary;
}

/**
 * Installs the pinned Python packages with the sandbox's own interpreter into a folder for its ABI, which workspace
 * commands get on PYTHONPATH. A failed install leaves any earlier one in place.
 */
export async function installPythonPackages(stateDir: string, python: PythonInfo, signal: AbortSignal): Promise<void> {
  const target = packagesFolder(stateDir, python.abi);
  const staging = `${target}.partial`;
  await rm(staging, { recursive: true, force: true });
  await mkdir(staging, { recursive: true });
  try {
    await execFileAsync(python.executable, ['-m', 'pip', 'install', '--target', staging, '--only-binary=:all:', '--no-deps', '--no-input', '--disable-pip-version-check', '--no-warn-script-location', ...pythonPackages.map(entry => `${entry.name}==${entry.version}`)], { signal, windowsHide: true, maxBuffer: 16 * 1024 * 1024 });
  } catch (error) {
    await rm(staging, { recursive: true, force: true });
    throw new Error(failure(error));
  }
  await rm(target, { recursive: true, force: true });
  await rename(staging, target);
  // pip builds in the user's temp folder and moves files in, and a moved file keeps the permissions it had there; the
  // Windows sandbox account reads them only once they take this folder's again.
  if (process.platform === 'win32') await execFileAsync(join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'icacls.exe'), [target, '/reset', '/T', '/Q'], { windowsHide: true });
}
