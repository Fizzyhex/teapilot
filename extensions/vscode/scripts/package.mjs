import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, copyFileSync, cpSync, rmSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve, relative, isAbsolute } from 'node:path';
import { fileURLToPath } from 'node:url';

const extension = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const root = resolve(extension, '../..');
const temporary = mkdtempSync(join(tmpdir(), 'teapilot-vsix-'));
const npm = process.env.npm_execpath;
if (!npm) throw new Error('Run through npm run package');
const runNpm = (args, cwd) => execFileSync(process.execPath, [npm, ...args], { cwd, stdio: 'inherit', windowsHide: true });
const staging = join(temporary, 'extension');
const runtime = join(staging, 'runtime');
function pruneRuntime(directory) {
  const relativeDirectory = relative(runtime, resolve(directory));
  if (relativeDirectory.startsWith('..') || isAbsolute(relativeDirectory)) throw new Error('Invalid pruning target');
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    if (entry.isSymbolicLink()) continue;
    const unsupportedBinary = directory.replaceAll('\\', '/').endsWith('/@esbuild') && !['win32-x64', 'win32-arm64', 'linux-x64', 'linux-arm64'].includes(entry.name);
    if (unsupportedBinary || entry.isFile() && (/\.(map|d\.ts)$/.test(entry.name) || /^\.env(?:\.|$)/.test(entry.name))) rmSync(path, { recursive: entry.isDirectory(), force: true });
    else if (entry.isDirectory()) pruneRuntime(path);
  }
}
try {
  runNpm(['pack', '--pack-destination', temporary], root);
  mkdirSync(runtime, { recursive: true });
  writeFileSync(join(runtime, 'package.json'), JSON.stringify({ name: 'teapilot-vscode-runtime', private: true, version: '0.0.0' }));
  const packageFile = readdirSync(temporary).find(name => name.endsWith('.tgz'));
  runNpm(['install', '--omit=dev', '--no-audit', '--no-fund', '--ignore-scripts', join(temporary, packageFile)], runtime);
  pruneRuntime(runtime);
  runNpm(['run', 'build'], extension);
  for (const name of ['package.json', 'README.md', 'CHANGELOG.md', '.vscodeignore']) copyFileSync(join(extension, name), join(staging, name));
  cpSync(join(extension, 'dist'), join(staging, 'dist'), { recursive: true });
  copyFileSync(join(root, 'LICENSE'), join(staging, 'LICENSE'));
  copyFileSync(join(root, 'THIRD_PARTY_NOTICES.md'), join(staging, 'THIRD_PARTY_NOTICES.md'));
  // Packaging uses only allowlisted files, never the repository or local profile.
  const vsce = join(extension, 'node_modules', '@vscode', 'vsce', 'vsce');
  execFileSync(process.execPath, [vsce, 'package', '--no-dependencies', '--out', join(extension, 'teapilot.vsix')], { cwd: staging, stdio: 'inherit', windowsHide: true });
} finally {
  if (!relative(tmpdir(), temporary).startsWith('..') && temporary.startsWith(join(tmpdir(), 'teapilot-vsix-'))) rmSync(temporary, { recursive: true, force: true });
}
