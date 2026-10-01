// The challenge checks turn prose expectations into verdicts over a captured run. The properties that
// matter: a rejection is a failure, a shortcode on a button is a failure, an oversized blob that is still
// reachable in history is a failure however it was deleted, and evidence that is not there comes back
// unscored rather than as a pass.
import { describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { checks, run as runChecks } from '../scripts/bench/challenge/checks.mjs';
import { gitEvidence } from '../scripts/bench/challenge/evidence.mjs';
import type { CheckName } from '../scripts/bench/challenge/checks.mjs';
import { checkMessage } from '../scripts/discord-sim/validate.js';

interface CaptureExtra { telemetry?: Array<Record<string, unknown>>; transcript?: unknown[] }

/** A capture directory holding just the files a check reads, so each test states only what it cares about. */
const capture = (discord: unknown, extra: CaptureExtra = {}) => {
  const dir = mkdtempSync(join(tmpdir(), 'challenge-test-'));
  writeFileSync(join(dir, 'discord.json'), JSON.stringify(discord));
  writeFileSync(join(dir, 'telemetry.jsonl'), `${(extra.telemetry ?? []).map(event => JSON.stringify(event)).join('\n')}\n`);
  if (extra.transcript) writeFileSync(join(dir, 'transcript.jsonl'), `${extra.transcript.map(entry => JSON.stringify(entry)).join('\n')}\n`);
  return dir;
};

type Over = Record<string, unknown>;
const message = (over: Over = {}) => ({ id: 'm2', channel: 'dm-op', author: 'teapilot', content: '', embeds: [], components: [], files: [], edits: 0, reactions: [], controls: [], ...over });
const bot = (over: Over = {}) => ({ snapshot: { messages: [message(over)], warnings: [], forms: [] }, apps: [] });

describe('the floor every case shares', () => {
  it('calls a Discord rejection a failure', () => {
    const clean = capture(bot({ snapshot: { messages: [message()], warnings: [], forms: [] } }));
    expect(checks.noRejections(clean)).toMatchObject({ pass: true });
    const rejected = capture({ snapshot: { messages: [message()], forms: [], warnings: [{ kind: 'rejection', what: 'a message in #dm-op', message: 'too long', text: '…' }] }, apps: [] });
    const result = checks.noRejections(rejected);
    expect(result.pass).toBe(false);
    expect(result.detail).toContain('too long');
  });

  it('re-runs Discord\u2019s own checks over the capture, so it stays checkable after the session is gone', () => {
    const dir = capture(bot({ content: 'x'.repeat(2001) }));
    expect(runChecks(dir, ['controlsAreValid'], { options: { controlsAreValid: { validate: { checkMessage } } } })[0]).toMatchObject({ pass: false });
    const good = capture(bot({ content: 'short enough' }));
    expect(runChecks(good, ['controlsAreValid'], { options: { controlsAreValid: { validate: { checkMessage } } } })[0]).toMatchObject({ pass: true });
    const fileOnly = capture(bot({ files: [{ name: 'game.js', size: 100, path: 'output' }] }));
    expect(runChecks(fileOnly, ['controlsAreValid'], { options: { controlsAreValid: { validate: { checkMessage } } } })[0]).toMatchObject({ pass: true });
  });

  it('fails a shortcode left in a button, and passes the unicode emoji in its place', () => {
    const shortcode = capture(bot({ components: [{ type: 1, components: [{ type: 2, style: 2, label: ':white_large_square: go', custom_id: 'a' }] }] }));
    expect(checks.noShortcodeInControls(shortcode).pass).toBe(false);
    expect(checks.noShortcodeInControls(shortcode).detail).toContain('white_large_square');
    const unicode = capture(bot({ components: [{ type: 1, components: [{ type: 2, style: 2, label: '⬜ go', custom_id: 'a' }] }] }));
    expect(checks.noShortcodeInControls(unicode).pass).toBe(true);
  });

  it('reports no evidence as unscored, not as a pass', () => {
    const dir = capture(bot());
    const withoutEvidence = ['appSurvivesRestart', 'historyLacksOldTurns', 'noOversizedBlobReachable', 'retrievalDemonstrated'] as const satisfies readonly CheckName[];
    for (const name of withoutEvidence) expect(checks[name](dir, {}), name).toMatchObject({ pass: null, severity: 'unscored' });
  });
});

describe('app checks', () => {
  const withApp = (code: string, over: Over = {}) => ({ snapshot: { messages: [message({ id: 'm3', embeds: [{ title: 'Find your yummy' }] })], warnings: [], forms: [] }, apps: [{ id: 'abc1234567', title: 'Find your yummy', status: 'running', messageId: 'm3', timers: [], consults: [], log: [], source: { kind: 'sandbox', code }, ...over }] });

  it('reads the title and the board, and the code, separately', () => {
    const dir = capture(withApp('const c = "🪑";'));
    expect(checks.appExists(dir, { shows: 'Find your yummy' }).pass).toBe(true);
    expect(checks.appExists(dir, { source: '🪑' }).pass).toBe(true);
    expect(checks.appExists(dir, { shows: 'nothing like this' }).pass).toBe(false);
    expect(checks.appSourceContains(dir, { pattern: '🪑' }).pass).toBe(true);
    expect(checks.appSourceContains(dir, { pattern: '🐷' }).pass).toBe(false);
  });

  it('wants consult() rather than hardcoded content', () => {
    expect(checks.appUsesConsult(capture(withApp('view(s) { consult("a recipe"); } }')), {})).toMatchObject({ pass: true });
    expect(checks.appUsesConsult(capture(withApp('const recipes = ["chocolate cake"];')), {})).toMatchObject({ pass: false });
    expect(checks.appUsesConsult(capture(withApp('consult("x"); const r = ["hardcoded"];')), { notPattern: 'hardcoded' }).pass).toBe(false);
  });

  it('catches an after() below the runtime floor', () => {
    expect(checks.timersRespectRateLimit(capture(withApp('after(500, "tick");'))).pass).toBe(false);
    expect(checks.timersRespectRateLimit(capture(withApp('after(2000, "tick");'))).pass).toBe(true);
  });

  it('wants a file rather than a wall of text', () => {
    const attached = capture({ snapshot: { messages: [message({ files: [{ name: 'kiosk.js', size: 3000, path: 'x' }] })], warnings: [], forms: [] }, apps: [] });
    expect(checks.sendsFileNotText(attached, { extension: '.js' }).pass).toBe(true);
    const pasted = capture(bot({ content: 'x'.repeat(2000) }));
    expect(checks.sendsFileNotText(pasted, { extension: '.js' }).pass).toBe(false);
    expect(checks.sendsFileNotText(pasted, {}).detail).toContain('2000 characters as text');
  });

  it('does not count the user upload as a file returned by teapilot', () => {
    const input = message({ author: 'op', files: [{ name: 'game.js', size: 100, path: 'input' }] });
    const dir = capture({ snapshot: { messages: [input, message({ content: 'done' })], warnings: [], forms: [] }, apps: [] });
    expect(checks.sendsFileNotText(dir, { extension: '.js' })).toMatchObject({ pass: false });
    const returned = capture({ snapshot: { messages: [input, message({ files: [{ name: 'game.js', size: 200, path: 'output' }] })], warnings: [], forms: [] }, apps: [] });
    expect(checks.sendsFileNotText(returned, { extension: '.js' })).toMatchObject({ pass: true });
  });
});

describe('git hygiene', () => {
  // A real repository, so the blob index is built the way the evidence capture builds it.
  const repo = () => {
    const dir = mkdtempSync(join(tmpdir(), 'challenge-git-'));
    const git = (...args: string[]) => execFileSync('git', ['-C', dir, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
    git('init', '-q');
    git('config', 'user.email', 't@t');
    git('config', 'user.name', 't');
    writeFileSync(join(dir, 'handoff.md'), 'what works, decisions, checks\n');
    git('add', 'handoff.md');
    git('commit', '-qm', 'handoff');
    return { dir, git };
  };
  const withGit = (workspace: string) => {
    const dir = mkdtempSync(join(tmpdir(), 'challenge-ev-'));
    mkdirSync(join(dir, 'git', workspace), { recursive: true });
    writeFileSync(join(dir, 'discord.json'), JSON.stringify({ snapshot: { messages: [], warnings: [], forms: [] }, apps: [] }));
    writeFileSync(join(dir, 'telemetry.jsonl'), '');
    return { dir };
  };

  it('finds an oversized capture that was committed and then deleted', () => {
    const { dir, git } = repo();
    mkdirSync(join(dir, '.scratch', 'outputs'), { recursive: true });
    writeFileSync(join(dir, '.scratch', 'outputs', 'fetch-1.txt'), 'x'.repeat(600_000));
    git('add', '-A');
    git('commit', '-qm', 'sweep');
    // Delete it afterwards: the blob is still reachable, which is the whole point.
    rmSync(join(dir, '.scratch'), { recursive: true, force: true });
    git('add', '-A');
    git('commit', '-qm', 'clean up');
    const { dir: evidence } = withGit('ws');
    gitEvidence(dir, join(evidence, 'git', 'ws'));
    const result = checks.noOversizedBlobReachable(evidence, { maxBytes: 100_000 });
    expect(result.pass).toBe(false);
    expect(result.detail).toContain('outputs/fetch-1.txt');
  });

  it('says a transcript or captured output is disposable, and a handoff is not', () => {
    const { dir, git } = repo();
    mkdirSync(join(dir, '.scratch', 'sessions'), { recursive: true });
    writeFileSync(join(dir, '.scratch', 'sessions', 'abc.jsonl'), 'transcript');
    git('add', '-A');
    git('commit', '-qm', 'transcript');
    const { dir: evidence } = withGit('ws');
    gitEvidence(dir, join(evidence, 'git', 'ws'));
    expect(checks.disposableMaterialIgnored(evidence, { patterns: ['/sessions/'] }).pass).toBe(false);
    expect(checks.trackedUsefulArtifacts(evidence, { patterns: ['handoff'] }).pass).toBe(true);
    expect(checks.trackedUsefulArtifacts(evidence, { patterns: ['validator'] }).pass).toBe(false);
  });
});
