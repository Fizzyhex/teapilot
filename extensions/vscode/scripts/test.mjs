import { runTests } from '@vscode/test-electron';
import { build } from 'esbuild';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve, relative } from 'node:path';

const temporary = mkdtempSync(join(tmpdir(), 'teapilot-editor-test-'));
delete process.env.ELECTRON_RUN_AS_NODE;
await build({ entryPoints: ['test/suite.ts'], outfile: 'dist/test.cjs', bundle: true, platform: 'node', format: 'cjs', target: 'node22', external: ['vscode'] });
try {
  await runTests({
    version: '1.138.0',
    vscodeExecutablePath: process.env.VSCODE_EXECUTABLE_PATH,
    extensionDevelopmentPath: resolve('.'),
    extensionTestsPath: resolve('dist/test.cjs'),
    launchArgs: [temporary, '--disable-extensions', '--disable-workspace-trust', '--skip-welcome', '--skip-release-notes', '--disable-gpu', '--no-sandbox', '--user-data-dir', join(temporary, 'editor-data'), '--extensions-dir', join(temporary, 'extensions')],
    extensionTestsEnv: { TEAPILOT_TEST_ROOT: temporary },
  });
} finally {
  if (temporary.startsWith(join(tmpdir(), 'teapilot-editor-test-')) && !relative(tmpdir(), temporary).startsWith('..')) rmSync(temporary, { recursive: true, force: true });
}
