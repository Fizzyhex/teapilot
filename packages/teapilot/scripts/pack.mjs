// Packs teapilot from a staging directory. In the workspace, npm hoists bundled dependencies to the
// monorepo root and `npm pack` would silently leave them out; user docs and notices also live at the root.
// Arguments are passed to `npm pack` (for example --json or --pack-destination DIR); run `npm run build` first.
// The package's own prepack runs this with --refuse, so a plain `npm pack` in the workspace fails instead.
import { execFileSync } from 'node:child_process';
import { existsSync, realpathSync } from 'node:fs';
import { cp, mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const pkg = fileURLToPath(new URL('..', import.meta.url)), root = resolve(pkg, '../..');
const manifest = JSON.parse(await readFile(join(pkg, 'package.json'), 'utf8'));
if (process.argv.includes('--refuse')) throw new Error('Pack teapilot with npm run pack: packing inside the workspace would leave out its bundled dependencies.');
if (!existsSync(join(pkg, 'dist/cli.js'))) throw new Error('Build teapilot before packing: npm run build');
const npm = process.env.npm_execpath ?? join(dirname(process.execPath), 'node_modules/npm/bin/npm-cli.js');
const args = process.argv.slice(2).map((arg, index, all) => all[index - 1] === '--pack-destination' ? resolve(arg) : arg);
const staging = await mkdtemp(join(tmpdir(), 'teapilot-pack-'));

function locate(name, from) {
  for (let dir = from; ; dir = dirname(dir)) {
    const candidate = join(dir, 'node_modules', name);
    if (existsSync(join(candidate, 'package.json'))) return realpathSync(candidate);
    if (dirname(dir) === dir) throw new Error(`Cannot find bundled dependency ${name} from ${from}`);
  }
}
// The installed closure of the bundled dependencies, copied with its node_modules layout intact.
async function bundled() {
  const found = new Set(), queue = (manifest.bundleDependencies ?? []).map(name => [name, pkg]);
  while (queue.length) {
    const [name, from] = queue.shift(), dir = locate(name, from);
    if (found.has(dir)) continue;
    found.add(dir);
    const dependency = JSON.parse(await readFile(join(dir, 'package.json'), 'utf8'));
    for (const next of Object.keys({ ...dependency.dependencies, ...dependency.optionalDependencies })) {
      try { queue.push([next, locate(next, dir)]); } catch (error) { if (!(next in (dependency.optionalDependencies ?? {}))) throw error; }
    }
  }
  const outermost = [...found].filter(dir => ![...found].some(other => other !== dir && dir.startsWith(other + sep)));
  return outermost.map(dir => {
    const base = [pkg, root].find(owner => dir.startsWith(join(owner, 'node_modules') + sep));
    if (!base) throw new Error(`Bundled dependency outside node_modules: ${dir}`);
    return [dir, join(staging, relative(base, dir))];
  });
}
try {
  for (const name of ['package.json', 'dist', 'config']) await cp(join(pkg, name), join(staging, name), { recursive: true });
  for (const name of ['README.md', 'docs', 'LICENSE', 'THIRD_PARTY_NOTICES.md']) await cp(join(root, name), join(staging, name), { recursive: true });
  for (const [from, to] of await bundled()) await cp(from, to, { recursive: true, dereference: true });
  process.stdout.write(execFileSync(process.execPath, [npm, 'pack', '--ignore-scripts', ...args], { cwd: staging, windowsHide: true, encoding: 'utf8', stdio: ['ignore', 'pipe', 'inherit'] }));
} finally {
  if (dirname(staging) === tmpdir() && staging.includes('teapilot-pack-')) await rm(staging, { recursive: true, force: true });
}
