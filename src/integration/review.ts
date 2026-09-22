import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { randomUUID } from 'node:crypto';
import { mkdir, readdir, readFile, writeFile, rm, lstat } from 'node:fs/promises';
import { join, relative, resolve, isAbsolute } from 'node:path';
import type { Config } from '../config.js';
import { cleanChildEnvironment, ExecutionPolicy } from '../execution/policy.js';

const exec = promisify(execFile);
const FILE_LIMIT = 1024 * 1024;
const TOTAL_LIMIT = 100 * 1024 * 1024;
export interface ReviewedChange { path: string; index: number; kind: 'created' | 'deleted' | 'modified' }
export interface ReviewResult { id: string; root: string; changes: ReviewedChange[]; skipped: string[]; createdAt: number }

export async function privateDirectory(path: string) {
  await mkdir(path, { recursive: true, mode: 0o700 });
  if (process.platform === 'win32') {
    const { stdout } = await exec('whoami', ['/user', '/fo', 'csv', '/nh'], { windowsHide: true });
    const sid = stdout.match(/S-1-[\d-]+/)?.[0];
    if (!sid) throw new Error('Cannot determine private storage permissions');
    await exec('icacls', [path, '/inheritance:r', '/grant:r', `*${sid}:(OI)(CI)F`], { windowsHide: true });
  }
}

export class Review {
  private before = new Map<string, string | null>();
  private skipped = new Set<string>();
  private bytes = 0;
  private readonly policy: ExecutionPolicy;
  constructor(private readonly root: string, private readonly config: Config) { this.policy = new ExecutionPolicy(root, config, async () => false); }
  private async files(): Promise<string[]> {
    try {
      const { stdout } = await exec('git', ['-c', 'core.fsmonitor=false', '-c', 'core.untrackedCache=false', 'ls-files', '-z', '--cached', '--others', '--exclude-standard'], { cwd: this.root, env: cleanChildEnvironment(), windowsHide: true, maxBuffer: 8 * 1024 * 1024 });
      return [...new Set(stdout.split('\0').filter(Boolean))].sort();
    } catch {
      const files: string[] = [];
      const walk = async (directory: string) => {
        for (const entry of await readdir(directory, { withFileTypes: true })) {
          if (files.length >= 50_000) { this.skipped.add('Workspace enumeration limit reached'); return; }
          if (entry.isSymbolicLink() || ['.git', 'node_modules', '.teapilot', '.jevrouter'].includes(entry.name)) continue;
          const path = join(directory, entry.name);
          if (entry.isDirectory()) await walk(path); else if (entry.isFile()) files.push(relative(this.root, path));
        }
      };
      await walk(this.root); return files.sort();
    }
  }
  private async text(path: string): Promise<string | null | undefined> {
    try {
      const target = await this.policy.path(path, false);
      const info = await lstat(target);
      if (!info.isFile() || info.size > FILE_LIMIT || this.bytes + info.size > TOTAL_LIMIT) { this.skipped.add(path); return undefined; }
      const bytes = await readFile(target);
      if (bytes.includes(0)) { this.skipped.add(path); return undefined; }
      const text = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
      this.bytes += bytes.length;
      return text;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
      this.skipped.add(path); return undefined;
    }
  }
  async capture(path: string) {
    const name = relative(this.root, resolve(this.root, path));
    if (this.before.has(name) || this.skipped.has(name)) return;
    const text = await this.text(name); if (text !== undefined) this.before.set(name, text);
  }
  async start() { for (const path of await this.files()) await this.capture(path); }
  async finish(): Promise<ReviewResult> {
    const id = randomUUID();
    const directory = join(this.config.stateDir, 'reviews', id);
    await privateDirectory(directory);
    const changes: ReviewedChange[] = [];
    for (const path of new Set([...this.before.keys(), ...await this.files()])) {
      if (this.skipped.has(path)) continue;
      const before = this.before.get(path) ?? null;
      const after = await this.text(path);
      if (after === undefined || before === after) continue;
      const index = changes.length;
      await writeFile(join(directory, `${index}.before`), before ?? '', { mode: 0o600 });
      await writeFile(join(directory, `${index}.after`), after ?? '', { mode: 0o600 });
      changes.push({ path, index, kind: before === null ? 'created' : after === null ? 'deleted' : 'modified' });
    }
    const result = { id, root: this.root, changes, skipped: [...this.skipped], createdAt: Date.now() };
    await writeFile(join(directory, 'review.json'), JSON.stringify(result), { mode: 0o600 });
    return result;
  }
}

function reviewDirectory(state: string, id: string) {
  if (!/^[0-9a-f-]{36}$/.test(id)) throw new Error('Invalid review identifier');
  const root = resolve(state, 'reviews');
  const target = resolve(root, id);
  if (relative(root, target).startsWith('..') || isAbsolute(relative(root, target))) throw new Error('Invalid review path');
  return target;
}
export async function readReview(state: string, id: string): Promise<ReviewResult> {
  const directory = reviewDirectory(state, id);
  if ((await lstat(directory)).isSymbolicLink()) throw new Error('Linked review directories are not allowed');
  return JSON.parse(await readFile(join(directory, 'review.json'), 'utf8'));
}
export async function readReviewText(state: string, id: string, index: number, side: 'before' | 'after') {
  const review = await readReview(state, id);
  if (!review.changes.some(c => c.index === index)) throw new Error('Unknown review file');
  return readFile(join(reviewDirectory(state, id), `${index}.${side}`), 'utf8');
}
export async function cleanReviews(state: string, all = false) {
  const root = resolve(state, 'reviews');
  for (const entry of await readdir(root, { withFileTypes: true }).catch(() => [])) {
    if (!entry.isDirectory() || entry.isSymbolicLink() || !/^[0-9a-f-]{36}$/.test(entry.name)) continue;
    const target = reviewDirectory(state, entry.name);
    if (all || Date.now() - (await lstat(target)).mtimeMs > 7 * 86400_000) await rm(target, { recursive: true, force: true });
  }
}
