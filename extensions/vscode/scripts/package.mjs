import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, copyFileSync, rmSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const extension = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const root = resolve(extension, '../..');
const temporary = mkdtempSync(join(tmpdir(), 'teapilot-vsix-'));
const npm = process.env.npm_execpath;
if (!npm) throw new Error('Run through npm run package');
const runNpm = (args, cwd) => execFileSync(process.execPath, [npm, ...args], { cwd, stdio: 'inherit', windowsHide: true });
const runtime = join(extension, 'runtime');
// Only remove the fixed generated runtime directory inside this extension.
if (relative(extension, runtime) !== 'runtime') throw new Error('Invalid runtime target');
try {
  runNpm(['pack', '--pack-destination', temporary], root);
  rmSync(runtime, { recursive: true, force: true }); mkdirSync(runtime, { recursive: true });
  writeFileSync(join(runtime, 'package.json'), JSON.stringify({ name: 'teapilot-vscode-runtime', private: true, version: '0.0.0' }));
  const packageFile = readdirSync(temporary).find(name => name.endsWith('.tgz'));
  runNpm(['install', '--omit=dev', '--no-audit', '--no-fund', '--ignore-scripts', join(temporary, packageFile)], runtime);
  runNpm(['run', 'build'], extension);
  copyFileSync(join(root, 'LICENSE'), join(extension, 'LICENSE'));
  copyFileSync(join(root, 'THIRD_PARTY_NOTICES.md'), join(extension, 'THIRD_PARTY_NOTICES.md'));
  // Packaging uses only allowlisted files, never the repository or local profile.
  const vsce = join(extension, 'node_modules', '@vscode', 'vsce', 'vsce');
  execFileSync(process.execPath, [vsce, 'package', '--no-dependencies', '--out', join(extension, 'teapilot.vsix')], { cwd: extension, stdio: 'inherit', windowsHide: true });
} finally {
  if (!relative(tmpdir(), temporary).startsWith('..') && temporary.startsWith(join(tmpdir(), 'teapilot-vsix-'))) rmSync(temporary, { recursive: true, force: true });
}
