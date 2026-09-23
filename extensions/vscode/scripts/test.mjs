import { runTests } from '@vscode/test-electron';
import { build } from 'esbuild';
import { mkdtempSync, mkdirSync, rmSync, createWriteStream } from 'node:fs';
import { pipeline } from 'node:stream/promises';
import yauzl from 'yauzl';
import { tmpdir } from 'node:os';
import { dirname, join, resolve, relative, isAbsolute } from 'node:path';

async function extract(file, destination) {
  await new Promise((done, reject) => yauzl.open(file, { lazyEntries: true }, (error, zip) => {
    if (error) return reject(error);
    zip.on('error', reject); zip.on('end', done);
    zip.on('entry', entry => {
      const target = resolve(destination, entry.fileName);
      const rel = relative(destination, target);
      if (isAbsolute(rel) || rel.startsWith('..') || ((entry.externalFileAttributes >>> 16) & 0xf000) === 0xa000) { zip.close(); reject(new Error('Unsafe VSIX entry')); return; }
      if (entry.fileName.endsWith('/')) { mkdirSync(target, { recursive: true }); zip.readEntry(); return; }
      mkdirSync(dirname(target), { recursive: true });
      zip.openReadStream(entry, (error, stream) => {
        if (error) { zip.close(); reject(error); return; }
        void pipeline(stream, createWriteStream(target, { flags: 'wx' })).then(() => zip.readEntry(), error => { zip.close(); reject(error); });
      });
    });
    zip.readEntry();
  }));
}

const temporary = mkdtempSync(join(tmpdir(), 'teapilot-editor-test-'));
const workspace = join(temporary, 'workspace'); mkdirSync(workspace);
delete process.env.ELECTRON_RUN_AS_NODE;
await build({ entryPoints: ['test/suite.ts'], outfile: 'dist/test.cjs', bundle: true, platform: 'node', format: 'cjs', target: 'node22', external: ['vscode'] });
try {
  await extract(resolve('teapilot.vsix'), join(temporary, 'installed'));
  await runTests({
    version: '1.138.0',
    vscodeExecutablePath: process.env.VSCODE_EXECUTABLE_PATH,
    extensionDevelopmentPath: join(temporary, 'installed', 'extension'),
    extensionTestsPath: resolve('dist/test.cjs'),
    launchArgs: [workspace, ...(process.env.TEAPILOT_NATIVE_TEST === 'true' ? [] : ['--disable-extensions']), '--disable-workspace-trust', '--skip-welcome', '--skip-release-notes', '--disable-gpu', '--no-sandbox', '--user-data-dir', join(temporary, 'editor-data'), '--extensions-dir', join(temporary, 'extensions')],
    extensionTestsEnv: { TEAPILOT_TEST_ROOT: workspace },
  });
} finally {
  if (temporary.startsWith(join(tmpdir(), 'teapilot-editor-test-')) && !relative(tmpdir(), temporary).startsWith('..')) rmSync(temporary, { recursive: true, force: true });
}
