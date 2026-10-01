// The case runner drives a session, resolves controls by label rather than by message id, and captures
// what it did. These cover the parts that must not rot: label resolution, and the capture a batch scores.
import { afterEach, describe, expect, it } from 'vitest';
import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { findControl, loadCases, scoreOut } from '../scripts/bench/challenge/case.mjs';
import { gitEvidence } from '../scripts/bench/challenge/evidence.mjs';
import { captures, score, compare } from '../scripts/bench/challenge/report.mjs';
import type { ChallengeCase, Control, WorldSnapshot } from '../scripts/bench/challenge/case.mjs';

const loadingDirs: string[] = [];
const loadingDir = () => {
  const dir = mkdtempSync(join(tmpdir(), 'challenge-loading-'));
  loadingDirs.push(dir);
  return dir;
};
afterEach(() => { for (const dir of loadingDirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });

const control = (id: string, label?: string, extra: Partial<Control> = {}): Control => ({ id, type: 2, label, disabled: false, ...extra });

/** Only the parts a control lookup reads, which is all these tests need. */
const world = (...rows: Array<{ id: string; author: string; controls: Control[] }>) =>
  ({ messages: rows.map(row => ({ ...row, channel: 'dm-op', content: '', embeds: [], components: [], files: [], edits: 0, reactions: [] })),
    warnings: [], forms: [], channels: [] }) as unknown as WorldSnapshot;

describe('control resolution', () => {
  const snapshot = world(
    { id: 'm4', author: 'teapilot', controls: [control('left', '⬜ left'), control('go', 'Go')] },
    { id: 'm9', author: 'teapilot', controls: [control('play', '▶')] },
  );

  it('finds a control by id, by label, and by emoji, on the newest message that has it', () => {
    expect(findControl(snapshot, 'play')?.message).toBe('m9');
    expect(findControl(snapshot, 'Go')?.message).toBe('m4');
    expect(findControl(snapshot, '⬜ left')?.message).toBe('m4');
    expect(findControl(snapshot, 'nonexistent')).toBeUndefined();
  });

  it('stays on the message a case names, so a step does not drift onto a later board', () => {
    expect(findControl(snapshot, 'Go', 'm4')?.message).toBe('m4');
  });
});

describe('the cases', () => {
  const cases = loadCases();

  it('loads the twelve challenges in order and keeps the tooling fixture optional', () => {
    const challenges = loadCases({ fixtures: false });
    expect(Object.keys(challenges)).toHaveLength(12);
    expect(Object.keys(challenges)).toEqual(Object.keys(challenges).sort());
    expect(challenges).not.toHaveProperty('tooling-smoke');
    expect(Object.keys(cases)).toEqual([...Object.keys(challenges), 'tooling-smoke']);
  });

  it('loads default exports synchronously and ignores declarations and non-case files', () => {
    const directory = loadingDir();
    writeFileSync(join(directory, 'b.ts'), `export default { id: 'second', steps: [{ inspect: true }] };`);
    writeFileSync(join(directory, 'a.ts'), `export default { id: 'first', steps: [{ say: \`hello
world\` }] };`);
    writeFileSync(join(directory, 'helper.d.ts'), 'declare const helper: string;');
    writeFileSync(join(directory, 'old.json'), '{ invalid json');
    const loaded = loadCases({ directory, fixtures: false });
    expect(Object.keys(loaded)).toEqual(['first', 'second']);
    expect(loaded.first?.steps[0]).toEqual({ say: 'hello\nworld' });
  });

  it.each([
    ['export const value = {};', 'default export'],
    ['export default null;', 'default export'],
    ["export default { id: '', steps: [{ inspect: true }] };", 'non-empty id'],
    ["export default { id: 'empty', steps: [] };", 'steps'],
    ["export default { id: 'typo', steps: [{ inspect: true }], expect: ['noRejection'] };", 'unknown check noRejection'],
    ["export default { id: 'bad-expect', steps: [{ inspect: true }], expect: {} };", 'expect must be an array'],
    ['export default {', 'could not load case'],
  ])('reports invalid case files with their source path', (source, message) => {
    const directory = loadingDir();
    const file = join(directory, 'invalid.ts');
    writeFileSync(file, source);
    expect(() => loadCases({ directory, fixtures: false })).toThrow(message);
    expect(() => loadCases({ directory, fixtures: false })).toThrow(file);
  });

  it('rejects duplicate ids across challenges and fixtures, naming both files', () => {
    const directory = loadingDir();
    const fixtureDirectory = loadingDir();
    const first = join(directory, 'first.ts');
    const second = join(fixtureDirectory, 'second.ts');
    for (const file of [first, second]) writeFileSync(file, `export default { id: 'same', steps: [{ inspect: true }] };`);
    expect(() => loadCases({ directory, fixtureDirectory })).toThrow(`duplicate case id same: ${first} and ${second}`);
  });

  it('keeps list and show --json usable from plain Node, without a loader flag', () => {
    const script = fileURLToPath(new URL('../scripts/bench/challenge/case.mjs', import.meta.url));
    const list = execFileSync(process.execPath, [script, 'list'], { encoding: 'utf8' });
    expect(list).toContain('tooling-smoke');
    const shown = execFileSync(process.execPath, [script, 'show', 'snake', '--json'], { encoding: 'utf8' });
    expect(JSON.parse(shown)).toEqual(cases.snake);
  });

  it('runs the dry-run CLI without contacting or stopping a session or touching output', () => {
    const directory = loadingDir();
    const out = join(directory, 'untouched');
    const script = fileURLToPath(new URL('../scripts/bench/challenge/case.mjs', import.meta.url));
    const result = spawnSync(process.execPath, [script, 'run', 'snake', '--name', 'review-dry', '--out', out, '--dry-run'], { encoding: 'utf8' });
    expect(result.status).toBe(0);
    expect(result.stderr).toBe('');
    expect(result.stdout).toContain('(dry run)');
    expect(result.stdout).toContain('outcome: complete');
    expect(existsSync(out)).toBe(false);
  });

  it('loads every case with an id, steps and prose', () => {
    expect(Object.keys(cases).length).toBeGreaterThan(0);
    for (const [id, value] of Object.entries(cases)) {
      expect(value.id, id).toBe(id);
      expect(value.steps?.length, id).toBeGreaterThan(0);
      expect(value.prose, id).toBeTruthy();
      expect(value.judged?.length, id).toBeGreaterThan(0);
    }
  });

  it('names only checks that exist, so a case fails loudly rather than silently unscoring', async () => {
    const { names } = await import('../scripts/bench/challenge/checks.mjs');
    for (const [id, value] of Object.entries(cases)) {
      for (const entry of value.expect ?? []) {
        const name = typeof entry === 'string' ? entry : entry.check;
        expect(names, `${id} expects ${name}`).toContain(name);
      }
    }
  });

  it('keeps case data out of the checks themselves', async () => {
    // A check must not know about a fixture name or a record id; that is how a case-specific fix hides.
    const source = readFileSync(new URL('../scripts/bench/challenge/checks.mjs', import.meta.url), 'utf8');
    for (const needle of ['fetch_kiosk_catalog', 'run_import_diagnostic', 'oat pot', 'morning counter', 'greggs'])
      expect(source.toLowerCase()).not.toContain(needle.toLowerCase());
  });
});

describe('git evidence', () => {
  it('does not count git error lines as commits when the workspace is not a repository', () => {
    const workspace = loadingDir();
    const out = loadingDir();
    const result = gitEvidence(workspace, out);
    expect(result.commits).toBe(0);
    expect(result.blobs).toBe(0);
    expect(JSON.parse(readFileSync(join(out, 'commits.json'), 'utf8'))).toEqual([]);
  });

  it('indexes a repository without changing its local or global trust configuration', () => {
    const workspace = loadingDir();
    const out = loadingDir();
    execFileSync('git', ['init', '-q', workspace]);
    writeFileSync(join(workspace, 'catalog.json'), '[1,2,3]\n');
    execFileSync('git', ['-C', workspace, 'add', 'catalog.json']);
    execFileSync('git', ['-C', workspace, '-c', 'user.name=evaluator', '-c', 'user.email=evaluator@example.test', 'commit', '-qm', 'catalog']);
    const config = readFileSync(join(workspace, '.git', 'config'), 'utf8');
    const result = gitEvidence(workspace, out);
    expect(result.commits).toBe(1);
    expect(result.blobs).toBe(1);
    expect(result.largest).toBe(8);
    expect(readFileSync(join(workspace, '.git', 'config'), 'utf8')).toBe(config);
  });
});

describe('scoring a capture', () => {
  it('keeps separate options for repeated expectations of the same check', async () => {
    const dir = loadingDir();
    writeFileSync(join(dir, 'discord.json'), JSON.stringify({
      apps: [{ id: 'kiosk', source: { code: 'breakfast' } }]
    }));
    const results = await scoreOut(dir, {
      id: 'two-patterns', steps: [{ inspect: true }], expect: [
        { check: 'appSourceContains', options: { pattern: 'breakfast' } },
        { check: 'appSourceContains', options: { pattern: 'sweets' } }
      ]
    });
    expect(results.map(result => result.pass)).toEqual([true, false]);
    expect(results.map(result => result.detail)).toEqual(['found breakfast', 'no app source matches sweets']);
  });

  const captureDir = (extra: Record<string, unknown> = {}) => {
    const dir = mkdtempSync(join(tmpdir(), 'challenge-score-'));
    writeFileSync(join(dir, 'manifest.json'), JSON.stringify({ case: 'snake', label: 'baseline', revision: 'abc123', patchSha256: 'p1', models: ['m'], apps: [], warnings: 0, requests: 1, notes: null, ...extra }));
    writeFileSync(join(dir, 'discord.json'), JSON.stringify({ snapshot: { messages: [{ id: 'm2', author: 'teapilot', content: 'hi', embeds: [], components: [], files: [], edits: 0, reactions: [], controls: [] }], warnings: [], forms: [] }, apps: [] }));
    const events = [
      { at: '2026-10-01T00:00:00Z', requestId: 'r1', type: 'request_start' },
      { at: '2026-10-01T00:00:01Z', requestId: 'r1', type: 'casual', capability: 'ask.fast' },
      { at: '2026-10-01T00:00:02Z', requestId: 'r1', type: 'request_end', success: true, status: 'completed', attempts: 1 },
    ];
    writeFileSync(join(dir, 'telemetry.jsonl'), `${events.map(event => JSON.stringify(event)).join('\n')}\n`);
    return dir;
  };

  it('reports failures, and keeps measured numbers as info rather than as a verdict', () => {
    const dir = captureDir();
    const cases = loadCases();
    // Only the expectations matter to a score, so a partial case is enough here.
    const partial = { expect: [{ check: 'noRejections' }, { check: 'casualPerTurn', options: { expect: 2 } }, { check: 'turnTimings' }], judged: cases.snake?.judged } as unknown as ChallengeCase;
    const result = score(dir, { value: partial });
    expect(result.checks.find(check => check.name === 'noRejections')).toMatchObject({ pass: true });
    // One casual turn when two were expected: a failure, with the reason.
    expect(result.checks.find(check => check.name === 'casualPerTurn')).toMatchObject({ pass: false });
    expect(result.checks.find(check => check.name === 'turnTimings')).toMatchObject({ severity: 'info' });
    expect(result.judged).toHaveLength(3);
  });

  it('marks a check unscored when the run has no evidence for it, never as a pass', () => {
    const dir = captureDir();
    const only = { expect: [{ check: 'noOversizedBlobReachable' }] } as unknown as ChallengeCase;
    const result = score(dir, { value: only });
    expect(result.checks[0]).toMatchObject({ pass: null, severity: 'unscored' });
    expect(result.unscored).toHaveLength(1);
  });

  it('finds a batch of repetitions, not just a single capture', () => {
    const dir = mkdtempSync(join(tmpdir(), 'challenge-batch-'));
    for (const rep of [1, 2, 3]) {
      const nested = join(dir, `rep-${rep}`);
      mkdirSync(nested, { recursive: true });
      captureDirTo(nested);
    }
    expect(captures(dir)).toHaveLength(3);
  });

  it('resolves the saved case when scoring without an explicit value, including from the CLI', () => {
    const dir = captureDir();
    loadingDirs.push(dir);
    expect(score(dir).checks.find(check => check.name === 'controlsAreValid')).toMatchObject({ pass: true });
    const script = fileURLToPath(new URL('../scripts/bench/challenge/report.mjs', import.meta.url));
    const result = JSON.parse(execFileSync(process.execPath, [script, 'score', '--dir', dir, '--json'], { encoding: 'utf8' }));
    expect(result.checks.map((check: { name: string }) => check.name)).toContain('noRejections');
    expect(result.judged).toHaveLength(3);
  });

  it.each(['controlsAreValid', { check: 'controlsAreValid' }] as const)('injects payload validation for expectation %j', async entry => {
    const dir = captureDir();
    loadingDirs.push(dir);
    const value = { id: 'validation', steps: [{ inspect: true }], expect: [entry] } satisfies ChallengeCase;
    expect((await scoreOut(dir, value))[0]).toMatchObject({ pass: true });
    writeFileSync(join(dir, 'discord.json'), JSON.stringify({ snapshot: { messages: [{ author: 'teapilot', content: 'x'.repeat(2001), embeds: [], components: [], files: [] }] } }));
    expect((await scoreOut(dir, value))[0]).toMatchObject({ pass: false });
    expect(score(dir, { value }).checks[0]).toMatchObject({ pass: false });
  });

  it.each(['before', 'after'])('rejects comparisons when the %s batch has varying patches', side => {
    const before = loadingDir();
    const after = loadingDir();
    const summary = { entries: [], failures: [], models: ['model'], cases: ['snake'], runs: 2, frozen: true, frozenPatch: true };
    writeFileSync(join(before, 'batch.json'), JSON.stringify({ ...summary, frozenPatch: side !== 'before' }));
    writeFileSync(join(after, 'batch.json'), JSON.stringify({ ...summary, frozenPatch: side !== 'after' }));
    expect(compare(before, after)).toMatchObject({ comparable: false });
    expect(compare(before, after).caveats.join()).toContain('working-tree patch');
  });

  it('keeps comparisons comparable when each batch has a frozen revision and patch', () => {
    const before = loadingDir();
    const after = loadingDir();
    const summary = { entries: [], failures: [], models: ['model'], cases: ['snake'], runs: 2, frozen: true, frozenPatch: true };
    for (const dir of [before, after]) writeFileSync(join(dir, 'batch.json'), JSON.stringify(summary));
    expect(compare(before, after)).toMatchObject({ comparable: true, caveats: [] });
  });
});

function captureDirTo(dir: string) {
  writeFileSync(join(dir, 'manifest.json'), JSON.stringify({ case: 'snake', label: 'baseline', revision: 'abc123', patchSha256: 'p1', models: [], apps: [], warnings: 0, requests: 0, notes: null }));
  writeFileSync(join(dir, 'discord.json'), JSON.stringify({ snapshot: { messages: [], warnings: [], forms: [] }, apps: [] }));
  if (!existsSync(join(dir, 'telemetry.jsonl'))) writeFileSync(join(dir, 'telemetry.jsonl'), '');
}
