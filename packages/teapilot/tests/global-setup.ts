import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ensureRipgrep } from '../src/workspace/toolchain.js';

/**
 * One rg for every test, as teapilot keeps one under its state: the system's, or the pinned copy, fetched once into
 * a folder the tests share rather than into each fixture's state. Workers inherit the PATH this sets.
 */
export default async function setup(): Promise<void> {
  await ensureRipgrep(join(tmpdir(), 'teapilot-test-tools'));
}
