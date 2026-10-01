#!/usr/bin/env node
// Collects one challenge run into a self-contained evidence directory, before the session is stopped.
// The simulator deletes its state on `stop`, and attachments it sent are deleted with it, so anything a
// score has to be defensible from has to be copied out first.
//
//   node packages/teapilot/scripts/bench/challenge/evidence.mjs capture --name <session> --out <dir> [--case ID]
//   node packages/teapilot/scripts/bench/challenge/evidence.mjs verify --dir <dir>
//   node packages/teapilot/scripts/bench/challenge/evidence.mjs list --dir <dir>
//
// What lands in <dir>:
//   manifest.json      revision, profile and model, limits, seeds, timings, what ran
//   discord.json       every message as the payload Discord received, plus warnings, forms and apps
//   apps/<id>.json     each app record and the code the model wrote
//   interactions.jsonl one line per step the runner took, with what the simulator answered
//   telemetry.jsonl    outcomes.jsonl for this run only, keyed by requestId
//   git/               history, status and ignore views, plus every reachable blob indexed
//   trace/*.json       what each model call was sent, when --trace was used
//   transcript.jsonl   the pi session, with its teapilot.attempt markers
//   scratch.json       the scratchpad inventory and its capture/access events
//   files/             attachments teapilot sent, copied before they vanish
//
// The git blob index is the point of the exercise: "was a 549 KB raw capture ever committed" becomes a
// query over indexed blobs rather than a manual walk of every reachable tree.
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { cpSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, relative, resolve } from 'node:path';
import { parseArgs } from 'node:util';

// scripts/bench/challenge/ -> packages/teapilot -> the repository root.
export const packageRoot = resolve(import.meta.dirname, '..', '..', '..');
export const repoRoot = resolve(packageRoot, '..', '..');
const driver = join(packageRoot, 'scripts', 'agent-discord.mjs');
const base = () => join(tmpdir(), 'teapilot-discord');

/** The session directory the driver made, from its metadata. */
export function sessionDir(name) {
  const dir = join(base(), name);
  if (!existsSync(join(dir, 'session.json'))) throw new Error(`No session named ${name}. Use list, or start one.`);
  return dir;
}

export const meta = name => JSON.parse(readFileSync(join(sessionDir(name), 'session.json'), 'utf8'));

/** One driver call, as the runner and the collectors both need it. */
export function call(name, args, { allowFailure = false } = {}) {
  try {
    return { ok: true, text: execFileSync(process.execPath, [driver, ...args], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 }) };
  } catch (error) {
    if (!allowFailure) throw new Error(`agent-discord ${args.join(' ')} failed: ${String(error.stderr ?? error.message).trim()}`);
    return { ok: false, code: error.status, text: String(error.stdout ?? ''), stderr: String(error.stderr ?? '') };
  }
}

const write = (path, data) => { mkdirSync(join(path, '..'), { recursive: true }); writeFileSync(path, typeof data === 'string' ? data : `${JSON.stringify(data, null, 2)}\n`, 'utf8'); };
const sha = text => createHash('sha256').update(text).digest('hex');
const copy = (from, to) => { if (existsSync(from)) { mkdirSync(join(to, '..'), { recursive: true }); cpSync(from, to, { recursive: true }); } };

/** A git command that may fail: a workspace need not be a repository, and that is not an error here. */
const read = (where, args) => { try { return execFileSync('git', ['-C', where, ...args], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024, stdio: ['ignore', 'pipe', 'pipe'] }); } catch { return ''; } };
const patch = () => read(repoRoot, ['diff']);

/** Git views a hygiene score is judged from: history, what is tracked, ignored and untracked, and every reachable blob. */
export function gitEvidence(workspace, out) {
  const views = {
    'log-all': ['log', '--all', '--format=fuller', '--name-status'],
    status: ['status', '--short', '--untracked-files=all'],
    'ls-files': ['ls-files'],
    ignored: ['ls-files', '--others', '--ignored', '--exclude-standard'],
    untracked: ['ls-files', '--others', '--exclude-standard'],
  };
  // A workspace need not be a repository; that is recorded, not thrown, and git's own stderr is kept out
  // of the runner's output so a missing repository does not look like a failure.
  // The sandbox may own this workspace under another OS identity. Trust only this explicit evaluator
  // path for this read, never a global wildcard or a change to the tested repository's configuration.
  const git = args => execFileSync('git', ['-c', `safe.directory=${resolve(workspace).replaceAll('\\', '/')}`, '-C', workspace, ...args], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024, stdio: ['ignore', 'pipe', 'pipe'] });
  const safe = args => { try { return git(args); } catch (error) { return `# git ${args.join(' ')} failed\n${String(error.stderr ?? error.message)}`; } };
  const index = {};
  for (const [name, args] of Object.entries(views)) { const text = safe(args); write(join(out, `${name}.txt`), text); index[name] = text.split('\n').filter(Boolean).length; }

  // Every blob any reachable commit holds, so an oversized or discarded capture is visible as data.
  const blobs = [];
  const commits = [];
  for (const commit of safe(['rev-list', '--all']).split('\n').filter(line => /^[0-9a-f]{40}$/.test(line))) {
    const [hash, author, at, ...subject] = (safe(['show', '-s', '--format=%H%x09%an%x09%aI%x09%s', commit]).split('\n')[0] ?? '').split('\t');
    commits.push({ hash, author, at, subject: subject.join('\t') });
    for (const entry of safe(['ls-tree', '-r', commit]).split('\n').filter(Boolean)) {
      const match = /^\d+ (\w+) ([0-9a-f]{40})\t(.+)$/.exec(entry);
      if (!match || match[1] !== 'blob') continue;
      const [, , blob, path] = match;
      if (blobs.some(entry => entry.path === path && entry.blob === blob)) continue;
      blobs.push({ path, blob, commit: hash, bytes: Number(safe(['cat-file', '-s', blob]).trim()) || 0 });
    }
  }
  write(join(out, 'blobs.json'), blobs.sort((a, b) => b.bytes - a.bytes));
  write(join(out, 'commits.json'), commits);
  return { ...index, blobs: blobs.length, commits: commits.length, largest: blobs[0]?.bytes ?? 0, ignoreFiles: safe(['check-ignore', '-v', '.scratch/outputs/example.txt']) || null };
}

/**
 * The conversation workspaces under the session's own state, never the driver's repo directory. `probe`
 * is the sandbox's own scratch workspace, not a conversation, so it is left out.
 */
export function workspaces(name) {
  const dir = join(sessionDir(name), 'state', 'workspaces');
  if (!existsSync(dir)) return [];
  return readdirSync(dir).filter(id => id !== 'probe').map(id => ({ id, path: join(dir, id) }));
}

/** The scratchpad inventory, and the events a retrieval score reads. */
export function scratchEvidence(name) {
  const { text } = call(name, ['scratch', name, '--last', '500'], { allowFailure: true });
  const [listing, events = ''] = text.split('## events');
  const files = [];
  for (const line of listing.split('\n')) {
    const match = /^\s{2}(.+) \((\d+) B\)$/.exec(line);
    if (match) files.push({ path: match[1], bytes: Number(match[2]) });
  }
  return { files, events: events.split('\n').filter(Boolean).flatMap(line => { try { return [JSON.parse(line)]; } catch { return []; } }) };
}

/**
 * Outcomes for this run only, correlated by requestId. The `scratch` op names the telemetry file it
 * reads, so the profile is found rather than guessed; a run that read it all keeps more of the history
 * than the op's own filter, so the file is read directly when the op reports it.
 */
export function telemetry(name) {
  const started = meta(name).startedAt;
  const raw = call(name, ['scratch', name, '--last', '100000'], { allowFailure: true }).text.split('## events')[1] ?? '';
  const fromOp = raw.split('\n').filter(Boolean).flatMap(line => { try { return [JSON.parse(line)]; } catch { return []; } });
  const path = /## events \((.+)\)/.exec(call(name, ['scratch', name, '--last', '1'], { allowFailure: true }).text)?.[1]?.trim();
  const all = path && existsSync(path)
    ? readFileSync(path, 'utf8').split('\n').filter(Boolean).flatMap(line => { try { return [JSON.parse(line)]; } catch { return []; } })
    : fromOp;
  return { path: path ?? null, all, sinceStarted: all.filter(event => event.at >= started) };
}

const transcriptOf = name => {
  for (const { path } of workspaces(name)) {
    const dir = join(path, '.scratch', 'sessions');
    if (!existsSync(dir)) continue;
    for (const file of readdirSync(dir).filter(entry => /^[0-9a-f]{8}\.jsonl$/.test(entry))) return { path: join(dir, file), workspace: path };
  }
  return undefined;
};

/**
 * Everything one run leaves behind, copied into `out`. `interactions` is what the runner recorded as it
 * went; `caseId` and `label` are what the batch needs to tell repetitions apart.
 */
export function capture(name, out, { caseId, label, interactions = [], startedAt, fixture, seed, notes, configDir } = {}) {
  const directory = resolve(out);
  rmSync(directory, { recursive: true, force: true });
  mkdirSync(directory, { recursive: true });
  const session = meta(name);
  const dump = call(name, ['dump', name, '--out', join(directory, 'discord.json')], { allowFailure: true });
  const apps = [];
  for (const record of (dump.ok && existsSync(join(directory, 'discord.json')) ? JSON.parse(readFileSync(join(directory, 'discord.json'), 'utf8')).apps : [])) {
    write(join(directory, 'apps', `${record.id}.json`), record);
    apps.push({ id: record.id, title: record.title, status: record.status, file: record.file, source: record.source.kind, timers: record.timers.length, consults: record.consults.length, actions: record.log.length });
  }
  // Attachments the simulator wrote for what teapilot sent: copied before stop deletes them.
  for (const file of existsSync(join(sessionDir(name), 'files')) ? readdirSync(join(sessionDir(name), 'files')) : []) copy(join(sessionDir(name), 'files', file), join(directory, 'files', file));

  const events = telemetry(name).sinceStarted;
  write(join(directory, 'telemetry.jsonl'), events.map(event => JSON.stringify(event)).join('\n') + (events.length ? '\n' : ''));
  // The repository's own revision, so a batch can tell a frozen implementation from a moving one.
  const revision = read(repoRoot, ['rev-parse', 'HEAD']);
  write(join(directory, 'interactions.jsonl'), interactions.map(entry => JSON.stringify(entry)).join('\n') + (interactions.length ? '\n' : ''));
  const scratch = scratchEvidence(name);
  write(join(directory, 'scratch.json'), scratch);
  const transcript = transcriptOf(name);
  if (transcript) copy(transcript.path, join(directory, 'transcript.jsonl'));
  copy(join(sessionDir(name), 'trace'), join(directory, 'trace'));
  const git = workspaces(name).map(({ id, path }) => ({ id, ...gitEvidence(path, join(directory, 'git', id)) }));

  const requests = events.filter(event => event.type === 'request_start').length;
  const manifest = {
    case: caseId ?? null, label: label ?? null, session: name, startedAt: startedAt ?? session.startedAt, capturedAt: new Date().toISOString(),
    revision: revision.trim(), patchSha256: sha(patch()),
    configDir: configDir ?? process.env.CHALLENGE_CONFIG_DIR ?? null, seed: seed ?? null, fixture: fixture ?? null, notes: notes ?? null,
    apps, git, workspaces: workspaces(name).map(entry => entry.id), transcript: transcript ? relative(directory, transcript.path) : null,
    trace: existsSync(join(directory, 'trace')) ? readdirSync(join(directory, 'trace')).length : 0,
    events: events.length, requests, scratchFiles: scratch.files.length, scratchBytes: scratch.files.reduce((total, file) => total + file.bytes, 0),
    warnings: (dump.ok && existsSync(join(directory, 'discord.json')) ? JSON.parse(readFileSync(join(directory, 'discord.json'), 'utf8')).snapshot.warnings : []).length,
    models: [...new Set(events.map(event => event.model).filter(Boolean))],
  };
  write(join(directory, 'manifest.json'), manifest);
  return manifest;
}

const usage = `Usage: node scripts/bench/challenge/evidence.mjs <command>

  capture --name <session> --out <dir> [--case ID] [--label L] [--seed S] [--fixture F]
  verify --dir <dir>          what the capture is missing, and what it holds
  list --dir <dir>            apps, warnings and the largest git blobs

Run capture before stopping a session: the simulator deletes its state on stop.`;

if (process.argv[1] && resolve(process.argv[1]) === resolve(import.meta.filename)) {
  const [command, ...rest] = process.argv.slice(2);
  try {
    if (!command || command === '--help') console.log(usage);
    else if (command === 'capture') {
      const { values } = parseArgs({ args: rest, options: { name: { type: 'string' }, out: { type: 'string' }, case: { type: 'string' }, label: { type: 'string' }, seed: { type: 'string' }, fixture: { type: 'string' } } });
      if (!values.name || !values.out) throw new Error('capture needs --name and --out.');
      const interactions = join(values.out, 'interactions.jsonl');
      console.log(JSON.stringify(capture(values.name, values.out, {
        caseId: values.case, label: values.label, seed: values.seed, fixture: values.fixture,
        interactions: existsSync(interactions) ? readFileSync(interactions, 'utf8').split('\n').filter(Boolean).map(line => JSON.parse(line)) : [],
      }), null, 2));
    } else if (command === 'verify' || command === 'list') {
      const { values } = parseArgs({ args: rest, options: { dir: { type: 'string' } } });
      if (!values.dir) throw new Error(`${command} needs --dir.`);
      const dir = resolve(values.dir);
      const manifest = JSON.parse(readFileSync(join(dir, 'manifest.json'), 'utf8'));
      const have = ['manifest.json', 'discord.json', 'telemetry.jsonl', 'scratch.json', 'interactions.jsonl'].filter(file => existsSync(join(dir, file)));
      if (command === 'list') {
        const blobs = existsSync(join(dir, 'git')) ? readdirSync(join(dir, 'git'), { recursive: true }).filter(entry => String(entry).endsWith('blobs.json')) : [];
        const all = blobs.flatMap(entry => JSON.parse(readFileSync(join(dir, 'git', String(entry), 'blobs.json'), 'utf8')));
        console.log(`apps: ${manifest.apps.map(app => `${app.id} ${app.title} (${app.status})`).join(', ') || 'none'}`);
        console.log(`warnings: ${manifest.warnings}; requests: ${manifest.requests}; scratch: ${manifest.scratchFiles} files, ${manifest.scratchBytes} B`);
        console.log(`largest reachable blobs:\n${all.sort((a, b) => b.bytes - a.bytes).slice(0, 10).map(blob => `  ${String(blob.bytes).padStart(9)} B  ${blob.path}`).join('\n') || '  none'}`);
      } else console.log(JSON.stringify({ present: have, missing: ['manifest.json', 'discord.json', 'telemetry.jsonl', 'scratch.json', 'interactions.jsonl'].filter(file => !have.includes(file)), manifest }, null, 2));
    } else console.log(usage);
  } catch (error) { console.error(`evidence: ${error.message}`); process.exitCode = 1; }
}
