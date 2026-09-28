import { cpSync, existsSync } from 'node:fs';
import { copyFile, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { SrtSandbox, type RunOptions } from '../src/workspace/sandbox.js';
import { WorkspaceStore } from '../src/workspace/store.js';
import { toolsFolder } from '../src/workspace/toolchain.js';

/**
 * The real sandbox, where it is installed: Linux needs bubblewrap, socat and ripgrep; Windows needs the one-time
 * `srt windows-install`. Elsewhere this whole file is skipped. pandoc and Pillow come from the system, or from what
 * `teapilot doctor` installed for the default profile.
 */
const state = await mkdtemp(join(tmpdir(), 'teapilot-sandbox-'));
const installed = toolsFolder(join(homedir(), '.teapilot'));
if (existsSync(installed)) cpSync(installed, toolsFolder(state), { recursive: true });
const sandbox = new SrtSandbox(state);
const status = await sandbox.status();
const store = WorkspaceStore.at(state);
const shell = process.platform === 'win32';
const offline: RunOptions = { timeoutSeconds: 60, network: async () => false };
const tool = (kind: string) => status.tools.find(entry => entry.kind === kind)?.name;
const python = status.tools.find(entry => entry.kind === 'python')?.name;

describe.skipIf(!status.available)('sandboxed workspace commands', () => {
  let mine: string, other: string;
  beforeAll(async () => {
    mine = store.folder('dm:mine'); other = store.folder('dm:other');
    await writeFile(join(other, 'secret.txt'), 'other conversation');
    await writeFile(join(state, 'host-secret.txt'), 'teapilot state');
    await copyFile(join(import.meta.dirname, '..', '..', '..', 'samples', 'tree.png'), join(mine, 'tree.png'));
  });
  afterAll(async () => { await sandbox.close(); await rm(state, { recursive: true, force: true }); });

  it('reads and writes its own workspace by relative names', async () => {
    const result = await sandbox.run(mine, shell ? 'echo hello> out.txt && type out.txt' : 'echo hello > out.txt && cat out.txt', offline);
    expect(result).toMatchObject({ exitCode: 0, timedOut: false });
    expect(result.output).toContain('hello');
  }, 60_000);

  it('cannot read another conversation\'s workspace or teapilot\'s state, nor write outside its own', async () => {
    const read = (path: string) => sandbox.run(mine, shell ? `type "${path}"` : `cat "${path}"`, offline);
    expect((await read(join(other, 'secret.txt'))).output).not.toContain('other conversation');
    expect((await read(join(state, 'host-secret.txt'))).output).not.toContain('teapilot state');
    const escape = join(state, 'escaped.txt');
    await sandbox.run(mine, shell ? `echo x> "${escape}"` : `echo x > "${escape}"`, offline);
    expect(existsSync(escape)).toBe(false);
    await sandbox.run(mine, shell ? `echo x> "${join(other, 'planted.txt')}"` : `echo x > "${join(other, 'planted.txt')}"`, offline);
    expect(existsSync(join(other, 'planted.txt'))).toBe(false);
  }, 120_000);

  it.skipIf(!tool('imagemagick'))('turns an image with ImageMagick', async () => {
    const result = await sandbox.run(mine, `${tool('imagemagick')} tree.png -flop -rotate 90 turned.png`, offline);
    expect(result.exitCode, result.output).toBe(0);
    const changes = await store.reconcile('dm:mine');
    expect(changes.added.find(file => file.name === 'turned.png')).toMatchObject({ width: 300, height: 480 });
  }, 60_000);

  it.skipIf(!tool('ffmpeg'))('makes audio with ffmpeg', async () => {
    const result = await sandbox.run(mine, 'ffmpeg -hide_banner -loglevel error -y -f lavfi -i sine=d=1 tone.mp3', offline);
    expect(result.exitCode, result.output).toBe(0);
    expect(existsSync(join(mine, 'tone.mp3'))).toBe(true);
  }, 60_000);

  it.skipIf(!tool('pandoc'))('converts a document with pandoc', async () => {
    await writeFile(join(mine, 'notes.md'), '# Notes\n\nSome **bold** text.\n');
    const result = await sandbox.run(mine, 'pandoc notes.md -o notes.docx', offline);
    expect(result.exitCode, result.output).toBe(0);
    expect((await readFile(join(mine, 'notes.docx'))).subarray(0, 2).toString()).toBe('PK');
  }, 60_000);

  it.skipIf(!tool('pillow'))('edits an image with Pillow', async () => {
    const result = await sandbox.run(mine, `${python} -c "from PIL import Image; Image.open('tree.png').transpose(Image.Transpose.ROTATE_90).save('pillow.png')"`, offline);
    expect(result.exitCode, result.output).toBe(0);
    const changes = await store.reconcile('dm:mine');
    expect(changes.added.find(file => file.name === 'pillow.png')).toMatchObject({ width: 300, height: 480 });
  }, 60_000);

  it.skipIf(!tool('python'))('asks before reaching the network, and connects only when approved', async () => {
    const fetch = `${tool('python')} -c "import urllib.request as u; print(u.urlopen('https://pypi.org/simple/six/', timeout=20).status)"`;
    const asked: string[] = [];
    const denied = await sandbox.run(mine, fetch, { timeoutSeconds: 60, network: async host => { asked.push(host); return false; } });
    expect(denied.output).not.toMatch(/^200$/m);
    expect(asked).toContain('pypi.org');
    const approved = await sandbox.run(mine, fetch, { timeoutSeconds: 60, network: async host => host === 'pypi.org' });
    expect(approved.output).toMatch(/^200$/m);
  }, 120_000);
});
