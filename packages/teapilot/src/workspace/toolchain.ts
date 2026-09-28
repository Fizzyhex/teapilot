import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { chmod, mkdir, rename, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { promisify } from 'node:util';

/**
 * Tools teapilot installs for workspace commands when the system lacks them: pandoc, and Pillow for Python.
 * They live under teapilot's state, which sandboxed commands may read but not write, so one copy serves every
 * conversation. ffmpeg, ImageMagick, Python and Node come from the system.
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
/** Python packages every workspace can import, pinned; prebuilt wheels only, so nothing is compiled or run to install them. */
export const pythonPackages = [{ name: 'Pillow', version: '12.3.0' }];

/** The Python the sandbox runs, as it reports itself: its executable and the ABI its compiled packages must match. */
export interface PythonInfo { executable: string; abi: string }

export const toolsFolder = (stateDir: string) => join(stateDir, 'tools', 'workspace');
export const pandocFolder = (stateDir: string) => join(toolsFolder(stateDir), 'pandoc', pandocRelease.version);
export const packagesFolder = (stateDir: string, abi: string) => join(toolsFolder(stateDir), 'python', abi);
export const pandocAsset = (platform = process.platform, arch = process.arch) => pandocRelease.assets[`${platform}-${arch}`];

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
  const folder = pandocFolder(stateDir);
  const binary = join(folder, process.platform === 'win32' ? 'pandoc.exe' : 'pandoc');
  const response = await get(`https://github.com/jgm/pandoc/releases/download/${pandocRelease.version}/${asset.file}`, { signal: AbortSignal.any([signal, AbortSignal.timeout(10 * 60 * 1000)]) });
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
    await execFileAsync(python.executable, ['-m', 'pip', 'install', '--target', staging, '--only-binary=:all:', '--no-deps', '--no-input', '--disable-pip-version-check', '--no-warn-script-location', ...pythonPackages.map(entry => `${entry.name.toLowerCase()}==${entry.version}`)], { signal, windowsHide: true, maxBuffer: 16 * 1024 * 1024 });
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
