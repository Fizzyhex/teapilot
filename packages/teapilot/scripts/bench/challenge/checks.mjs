#!/usr/bin/env node
// The predicates a challenge's expectations are written in, each one a pure function of a captured
// evidence directory. Keeping them named, small and separate is what lets a challenge file stay prose
// while the mechanical parts of it stay checkable.
//
//   node packages/teapilot/scripts/bench/challenge/checks.mjs list
//   node packages/teapilot/scripts/bench/challenge/checks.mjs run --dir <evidence> [--only name,name]
//
// A check returns { pass, detail, severity }. `severity` is `failure` unless the check is reporting a
// measurement (hygiene counts, timings), which is `info`: an efficiency score wants the number, not a
// pass or fail. A check that cannot run says why instead of failing, so an unscored dimension is
// visible as unscored rather than as a success.
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { parseArgs } from 'node:util';

const json = (path, fallback) => { try { return JSON.parse(readFileSync(path, 'utf8')); } catch { return fallback; } };
const lines = path => { try { return readFileSync(path, 'utf8').split('\n').filter(Boolean); } catch { return []; } };
const bytes = n => `${(n / 1024).toFixed(1)} KB`;
const verdict = (pass, detail, severity = 'failure') => ({ pass, detail, severity });
const unavailable = why => ({ pass: null, detail: why, severity: 'unscored' });

/**
 * The text people actually see on a message: its content, its embed text, and each control's label,
 * emoji and select options. The raw component payload is not walked, because a control's `custom_id` is
 * its address rather than a word on screen — `:play:8d92:ping` is not a shortcode anyone sees.
 */
function shownStrings(message) {
  const found = [];
  const visit = (value, key) => {
    if (typeof value === 'string') {
      if ((key === undefined || !SKIPPED_KEYS.has(key)) && !value.startsWith('attachment://')) found.push(value);
      return;
    }
    if (Array.isArray(value)) value.forEach(entry => visit(entry, key));
    else if (value && typeof value === 'object') for (const [name, entry] of Object.entries(value)) visit(entry, name);
  };
  visit(message?.content, 'content');
  visit(message?.embeds, 'embeds');
  visit(message?.components, 'components');
  for (const control of message?.controls ?? []) {
    visit(control.label, 'label');
    visit(control.emoji?.name, 'name');
    visit(control.placeholder, 'placeholder');
    visit(control.options, 'options');
  }
  return found;
}

const SKIPPED_KEYS = new Set(['url', 'custom_id', 'customId', 'id', 'value']);

/** Every app record in the capture, whatever workspace it came from. */
const appRecords = evidence => (json(join(evidence, 'discord.json'), { apps: [] }).apps ?? []).map(record => ({ record, evidence: json(join(evidence, 'apps', `${record.id}.json`), record) }));

/** Messages teapilot sent, newest last. */
const botMessages = snapshot => snapshot.messages.filter(message => message.author === 'teapilot');

/** Telemetry for this run only. */
function events(evidence) {
  return lines(join(evidence, 'telemetry.jsonl')).flatMap(line => { try { return [JSON.parse(line)]; } catch { return []; } });
}

/** Transcript entries, with the model call and tool result shapes pi writes. */
function transcript(evidence) {
  return lines(join(evidence, 'transcript.jsonl')).flatMap(line => { try { return [JSON.parse(line)]; } catch { return []; } });
}

const toolResults = entries => entries.filter(entry => entry.type === 'message' && entry.message?.role === 'toolResult');
const assistantCalls = entries => entries.filter(entry => entry.type === 'message' && entry.message?.role === 'assistant')
  .flatMap(entry => (entry.message.content ?? []).filter(part => part.type === 'toolCall'));
const resultText = entry => (entry.message?.content ?? []).filter(part => part.type === 'text').map(part => part.text).join('\n');

/** Every git blob index the capture holds, flattened with its workspace. */
function blobs(evidence) {
  const dir = join(evidence, 'git');
  if (!existsSync(dir)) return [];
  return readdirSync(dir, { withFileTypes: true }).filter(entry => entry.isDirectory()).flatMap(entry =>
    json(join(dir, entry.name, 'blobs.json'), []).map(blob => ({ ...blob, workspace: entry.name })));
}

/**
 * Every predicate. Each takes the evidence directory and options, and returns a verdict. Options are
 * what a challenge supplies for the parts that are not derivable: which app, which label, what "large"
 * means, which words count as the answer.
 */
export const checks = {
  /** The floor every case shares: the skill calls a Discord rejection a failure. */
  noRejections(evidence) {
    const warnings = json(join(evidence, 'discord.json'), { snapshot: { warnings: [] } }).snapshot?.warnings ?? [];
    const rejections = warnings.filter(warning => warning.kind === 'rejection');
    return verdict(rejections.length === 0,
      rejections.length ? rejections.map(warning => `${warning.what ?? 'message'}: ${warning.message}`).join('; ') : 'Discord accepted everything teapilot sent.');
  },

  /**
   * Re-runs the simulator's own payload checks offline, so a capture stays checkable after the
   * session is gone. The caller passes `validate` (scripts/discord-sim/validate.ts) through run options.
   */
  controlsAreValid(evidence, options = {}) {
    const { validate } = options;
    if (!validate) return unavailable('no validate module in options; run through the case runner, which loads it');
    const snapshot = json(join(evidence, 'discord.json'), { snapshot: { messages: [] } }).snapshot ?? { messages: [] };
    const failures = [];
    for (const message of botMessages(snapshot)) {
      try { validate.checkMessage({ content: message.content, embeds: message.embeds, components: message.components, flags: message.flags, files: message.files }); }
      catch (error) { failures.push(`${message.id}: ${error.message}`); }
    }
    return verdict(failures.length === 0, failures.length ? failures.join('; ') : `${botMessages(snapshot).length} messages pass Discord's own checks.`);
  },

  /** A `:shortcode:` is literal text on a button, where Discord shows no emoji. */
  noShortcodeInControls(evidence) {
    const snapshot = json(join(evidence, 'discord.json'), { snapshot: { messages: [] } }).snapshot ?? { messages: [] };
    const found = [];
    for (const message of botMessages(snapshot)) {
      for (const text of shownStrings(message)) for (const match of text.matchAll(/:([a-z0-9_+-]{2,}):/gi)) {
        // A server emoji someone actually shared renders; an unknown one is literal text on screen.
        if (!/<a?:\w+:\d+>/.test(text)) found.push(`${message.id}: :${match[1]}: in ${JSON.stringify(text.slice(0, 60))}`);
      }
    }
    return verdict(found.length === 0, found.length ? found.join('; ') : 'No unrendered shortcodes on screen.');
  },

  /**
   * Some app exists, and what it actually shows matches. `title` is the stored app title, `shows` is a
   * pattern against the message people see (embed title, footer, board text), `source` against the code.
   */
  appExists(evidence, { title, shows, source, min } = {}) {
    const apps = appRecords(evidence);
    if (!apps.length) return unavailable('no app was started');
    if (min && apps.length < min) return verdict(false, `${apps.length} app(s); at least ${min} expected`);
    const snapshot = json(join(evidence, 'discord.json'), { snapshot: { messages: [] } }).snapshot ?? { messages: [] };
    const problems = [];
    for (const { record } of apps) {
      if (title && !new RegExp(title, 'i').test(record.title)) { problems.push(`"${record.title}" does not match /${title}/i`); continue; }
      if (shows) {
        const message = snapshot.messages.find(entry => entry.id === record.messageId);
        const onScreen = message ? shownStrings({ content: message.content, embeds: message.embeds, components: message.components }).join('\n') : '';
        if (!new RegExp(shows, 'i').test(onScreen)) { problems.push(`"${record.title}" shows nothing matching /${shows}/i`); continue; }
      }
      if (source && !new RegExp(source, 'i').test(record.source?.code ?? '')) { problems.push(`"${record.title}" source does not match /${source}/i`); continue; }
      return verdict(true, `${record.id} "${record.title}" (${record.status}, ${record.messageId ?? 'no message'})`, 'info');
    }
    return verdict(false, problems.join('; ') || 'no app matched');
  },

  /** The code the model wrote must contain what the prompt asked for. A floor, not a judgement. */
  appSourceContains(evidence, { pattern, flags = 'i' } = {}) {
    if (!pattern) return unavailable('no pattern given');
    const apps = appRecords(evidence);
    if (!apps.length) return unavailable('no app was started');
    const source = apps.map(app => app.record.source?.code ?? '').join('\n');
    return verdict(new RegExp(pattern, flags).test(source), new RegExp(pattern, flags).test(source) ? `found ${pattern}` : `no app source matches ${pattern}`);
  },

  /** A hardcoded value where the challenge expects the model to be asked. */
  appUsesConsult(evidence, { notPattern } = {}) {
    const apps = appRecords(evidence);
    if (!apps.length) return unavailable('no app was started');
    const source = apps.map(app => app.record.source?.code ?? '').join('\n');
    const uses = /\bconsult\s*\(/.test(source);
    const hardcoded = notPattern ? new RegExp(notPattern, 'i').test(source) : false;
    return verdict(uses && !hardcoded, uses ? (hardcoded ? `consult() is called, but ${notPattern} is hardcoded too` : 'the app calls consult()') : 'the app never calls consult()');
  },

  /** after(ms) below the runtime's 2000 ms floor, or more than the ten pending timers. */
  timersRespectRateLimit(evidence) {
    const apps = appRecords(evidence);
    const problems = [];
    for (const { record } of apps) {
      const source = record.source?.code ?? '';
      for (const match of source.matchAll(/\bafter\s*\(\s*(\d{2,7})\s*[,\)]/g)) {
        const ms = Number(match[1]);
        if (ms > 0 && ms < 2000) problems.push(`${record.id}: after(${ms}) is under the 2000 ms floor`);
      }
      if (record.timers.length > 10) problems.push(`${record.id}: ${record.timers.length} timers pending; 10 is the limit`);
    }
    if (!apps.length) return unavailable('no app was started');
    return verdict(problems.length === 0, problems.length ? problems.join('; ') : `${apps.length} app(s) keep the edit rate within limits`);
  },

  /**
 * What teapilot sent as a file, rather than as a wall of text. Either half fails it: no attachment at
 * all, or a long message where a file was asked for. `maxTextChars` is where a paste stops being a paste.
 */
  sendsFileNotText(evidence, { extension, maxTextChars = 1500 } = {}) {
    const snapshot = json(join(evidence, 'discord.json'), { snapshot: { messages: [] } }).snapshot ?? { messages: [] };
    const sent = botMessages(snapshot).flatMap(message => message.files.map(file => ({ id: message.id, ...file })));
    const matching = extension ? sent.filter(file => file.name.toLowerCase().endsWith(extension.toLowerCase())) : sent;
    const bulky = botMessages(snapshot).filter(message => !message.files.length && message.content.length > maxTextChars)
      .map(message => `${message.id}: ${message.content.length} characters as text`);
    if (!sent.length) return verdict(false, `teapilot sent no attachments${bulky.length ? `, and ${bulky.join('; ')}` : ''}`);
    if (extension && !matching.length) return verdict(false, `no .${extension.replace(/^\./, '')} attachment; sent ${sent.map(file => file.name).join(', ')}`);
    return verdict(bulky.length === 0, bulky.length ? `${sent.length} file(s) sent, but ${bulky.join('; ')}` : `${sent.map(file => `${file.name} (${bytes(file.size)})`).join(', ')}`);
  },

  /**
   * Casual mode, read from the routing decision rather than from a reply's length. `expect` is the
   * number of turns that should have been casual, when a challenge is explicit about it.
   */
  casualPerTurn(evidence, { expect, max, min } = {}) {
    const all = events(evidence);
    const casual = all.filter(event => event.type === 'casual');
    const requests = all.filter(event => event.type === 'request_start').length;
    if (!requests) return unavailable('no requests in this run');
    const detail = `${casual.length} of ${requests} turns routed casual${casual.length ? ` (${casual.map(event => event.capability).join(', ')})` : ''}`;
    if (expect !== undefined) return verdict(casual.length === expect, `${detail}; ${expect} expected`);
    if (max !== undefined) return verdict(casual.length <= max, `${detail}; at most ${max} expected`);
    if (min !== undefined) return verdict(casual.length >= min, `${detail}; at least ${min} expected`);
    return verdict(true, detail, 'info');
  },

  /** How the routing decided, per attempt, from the telemetry teapilot already writes. */
  routingPerTurn(evidence) {
    const attempts = events(evidence).filter(event => event.type === 'attempt_end');
    if (!attempts.length) return unavailable('no attempts in this run');
    return verdict(true, attempts.map(event => `${event.capability}${event.success ? '' : ' (failed)'}${event.reason ? `: ${event.reason}` : ''}${event.turns !== undefined ? `, ${event.turns} turn(s)` : ''}`).join('; '), 'info');
  },

  /**
   * The first model call after a `/convo clear` must hold only the system prompt and the new message.
   * `after` names the trace file to read: the earliest one written after the clear, which a case
   * records when it reaches that stage. Without it the oldest trace is used, which is only right for
   * a run whose very first call is the one being checked.
 */
  historyLacksOldTurns(evidence, { after, mustNotInclude = [], maxUserMessages = 1 } = {}) {
    const traceDir = join(evidence, 'trace');
    if (!existsSync(traceDir)) return unavailable('no trace was captured (start the session with --trace)');
    const files = readdirSync(traceDir).filter(file => file.endsWith('.json')).sort();
    if (!files.length) return unavailable('the trace directory is empty');
    const first = files.find(file => after && file.startsWith(after)) ?? files[0];
    const call = json(join(traceDir, first), { messages: [] });
    const users = (call.messages ?? []).filter(message => message.role === 'user');
    const content = (call.messages ?? []).map(message => JSON.stringify(message.content ?? '')).join('\n');
    const leaked = mustNotInclude.filter(needle => content.includes(needle));
    const ok = users.length <= maxUserMessages && leaked.length === 0;
    return verdict(ok, ok
      ? `${first}: ${users.length} user message(s), no old turns`
      : `${first}: ${users.length} user message(s)${leaked.length ? `, still holds ${leaked.join(', ')}` : ''}`);
  },

  /**
   * The decisive evidence must be read out of history before the answer is given, rather than the answer
   * arriving from a surviving note. A case records which retrieval tools count; a shell call counts when
   * its command mentions git, so moving the read into bash does not evade the check.
 */
  recoveryCameFromGit(evidence, { tools = ['bash', 'shell'], commands = /\bgit\s+(log|show|cat-file|ls-tree)\b/ } = {}) {
    const calls = assistantCalls(transcript(evidence));
    const retrieval = calls.filter(call => tools.includes(call.name) && commands.test(JSON.stringify(call.arguments ?? {})));
    if (!retrieval.length) return verdict(false, `no ${commands} call in the transcript; the answer cannot have come from history`);
    const first = calls.indexOf(retrieval[0]);
    const results = toolResults(transcript(evidence)).filter(entry => retrieval.some(call => call.id === entry.message?.toolCallId));
    const returned = results.map(resultText).join('\n');
    return verdict(true, `${retrieval.length} history call(s), first at step ${first + 1} of ${calls.length}, returning ${returned.length} characters`, 'info');
  },

  /**
   * The decisive evidence must come back from retained output before the answer. `contains` are the
   * manifest's own strings, so a plausible guess fails: only a real read returns them. Returns info
   * rather than a pass or fail, because the benchmark's own validity gates decide whether this probe
   * was possible at all — an invalid probe must not be scored as a model failure.
   */
  retrievalDemonstrated(evidence, { contains = [] } = {}) {
    const results = toolResults(transcript(evidence));
    if (!results.length) return unavailable('no tool results in the transcript');
    const text = results.map(resultText).join('\n');
    if (!contains.length) return verdict(true, `${results.length} tool result(s)`, 'info');
    const missing = contains.filter(needle => !text.includes(needle));
    return verdict(missing.length === 0, missing.length ? `never returned: ${missing.join(', ')}` : `returned ${contains.length} expected detail(s)`, 'info');
  },

  /** The single fact a benchmark forbids the model from guessing, checked against what it actually said. */
  answerMatches(evidence, { contains = [], notContains = [], sinceCall } = {}) {
    const answers = sinceCall
      ? toolResults(transcript(evidence)).filter(entry => String(entry.message?.toolCallId) === sinceCall).map(resultText)
      : transcript(evidence).filter(entry => entry.type === 'message' && entry.message?.role === 'assistant').map(resultText);
    const text = answers.join('\n');
    if (!answers.length) return unavailable(sinceCall ? `no tool result for call ${sinceCall}` : 'no assistant text in the transcript');
    const missing = contains.filter(needle => !text.includes(needle));
    const invented = notContains.filter(needle => text.includes(needle));
    const ok = missing.length === 0 && invented.length === 0;
    return verdict(ok, ok ? 'the answer carries every expected detail'
      : [missing.length ? `missing: ${missing.join(', ')}` : '', invented.length ? `hallucinated: ${invented.join(', ')}` : ''].filter(Boolean).join('; '));
  },

  /** How much evidence the model pulled back, against the whole log's size. */
  retrievalBudget(evidence, { maxChars = 2000, fullLogChars } = {}) {
    const reads = toolResults(transcript(evidence)).filter(entry => /\b(read|search|grep|bash|shell)\b/.test(String(entry.message?.toolName)));
    const chars = reads.map(resultText).reduce((total, text) => total + text.length, 0);
    const pct = fullLogChars ? `${((chars / fullLogChars) * 100).toFixed(1)}% of the log` : 'no log size given';
    return verdict(chars <= maxChars, `${bytes(chars)} of model-visible retrieval across ${reads.length} call(s), ${pct} (budget ${bytes(maxChars)})`, 'info');
  },

  /** The hygiene floor: an oversized capture or a transcript must never be reachable in history. */
  noOversizedBlobReachable(evidence, { maxBytes = 100_000, ignore = ['/sessions/'] } = {}) {
    const all = blobs(evidence);
    if (!all.length) return unavailable('no git blobs were indexed (no git workspace, or nothing committed)');
    const big = all.filter(blob => blob.bytes > maxBytes && !ignore.some(part => blob.path.includes(part)));
    return verdict(big.length === 0, big.length ? `${big.length} blob(s) over ${bytes(maxBytes)} are reachable: ${big.slice(0, 5).map(blob => `${bytes(blob.bytes)} ${blob.path}`).join(', ')}` : `${all.length} reachable blobs, none over ${bytes(maxBytes)}`);
  },

  /** Transcripts, captured output and disposable intermediates should be ignored, not merely unstaged. */
  disposableMaterialIgnored(evidence, { patterns = ['/sessions/', 'outputs/'] } = {}) {
    const all = blobs(evidence);
    if (!all.length) return unavailable('no git blobs were indexed');
    const tracked = all.filter(blob => patterns.some(part => blob.path.includes(part)));
    return verdict(tracked.length === 0, tracked.length ? `${tracked.length} disposable path(s) are reachable: ${[...new Set(tracked.map(blob => blob.path))].slice(0, 5).join(', ')}` : 'no transcript or captured output is in history');
  },

  /**
   * Git work, judged against what actually changed rather than by commit count alone. `exclude`
   * drops the host's own initial commit; the report's rule is that a commit per tool call is waste,
   * while a commit per useful milestone is fine, so both numbers are reported and the verdict is left
   * to the prose score unless the case sets a ceiling.
   */
  commitsProportional(evidence, { max, excludeInitial = true, subjects } = {}) {
    const dir = join(evidence, 'git');
    if (!existsSync(dir)) return unavailable('no git evidence in this capture');
    const commits = readdirSync(dir, { withFileTypes: true }).filter(entry => entry.isDirectory())
      .flatMap(entry => json(join(dir, entry.name, 'commits.json'), []));
    if (!commits.length) return unavailable('no commits in this workspace');
    const counted = excludeInitial ? commits.filter(commit => !/^initial/i.test(commit.subject ?? '')) : commits;
    const blobsIndexed = readdirSync(dir, { withFileTypes: true }).filter(entry => entry.isDirectory())
      .reduce((total, entry) => total + json(join(dir, entry.name, 'blobs.json'), []).length, 0);
    const detail = `${counted.length} commit(s) excluding initialization, over ${blobsIndexed} tracked path(s); ${counted.slice(0, 4).map(commit => commit.subject).join(' | ')}`;
    return verdict(max === undefined ? true : counted.length <= max, max === undefined ? detail : `${detail}; at most ${max} expected`, 'info');
  },

  /** Useful durable notes should be tracked, so a later agent can pick the work up. */
  trackedUsefulArtifacts(evidence, { patterns = [] } = {}) {
    const all = blobs(evidence);
    if (!patterns.length) return verdict(all.length > 0, `${all.length} tracked blob(s)`, 'info');
    const matched = all.filter(blob => patterns.some(part => blob.path.toLowerCase().includes(part.toLowerCase())));
    return verdict(matched.length > 0, matched.length ? matched.map(blob => `${blob.path} (${bytes(blob.bytes)})`).join(', ') : `nothing tracked matches ${patterns.join(', ')}`);
  },

  /**
   * Apps must still be usable after a restart. `case` records the app ids captured before the restart,
   * so an app that vanished is a failure rather than an app that was never started.
   */
  appSurvivesRestart(evidence, { before } = {}) {
    const apps = appRecords(evidence);
    if (!before?.length) return unavailable('the case did not record which apps existed before the restart');
    const after = new Set(apps.map(app => app.record.id));
    const lost = before.filter(id => !after.has(id));
    const broken = apps.filter(app => app.record.status === 'paused' && before.includes(app.record.id));
    return verdict(lost.length === 0 && broken.length === 0, lost.length ? `${lost.join(', ')} did not come back`
      : broken.length ? `${broken.map(app => app.record.title).join(', ')} came back paused`
      : `all ${before.length} app(s) survived`, 'info');
  },

  /** Measurements for the efficiency column: what happened, reported as data rather than a verdict. */
  turnTimings(evidence) {
    const all = events(evidence);
    const starts = new Map(all.filter(event => event.type === 'request_start').map(event => [event.requestId, Date.parse(event.at)]));
    const ends = all.filter(event => event.type === 'request_end');
    if (!ends.length) return unavailable('no completed requests');
    const seconds = ends.map(event => {
      const from = starts.get(event.requestId);
      return from ? Math.round((Date.parse(event.at) - from) / 100) / 10 : undefined;
    }).filter(value => value !== undefined);
    const total = Math.round(seconds.reduce((sum, value) => sum + value, 0));
    const slowest = seconds.length ? Math.max(...seconds) : 0;
    return verdict(true, `${ends.length} request(s), ${ends.filter(event => event.success).length} successful; ${seconds.length} timed, total ${total}s, slowest ${slowest}s`, 'info');
  },

  toolCalls(evidence) {
    const tools = events(evidence).filter(event => event.type === 'tool');
    if (!tools.length) return unavailable('no tool telemetry in this run');
    const failed = tools.filter(event => !event.succeeded);
    return verdict(true, `${tools.length} tool call(s), ${failed.length} failed`, 'info');
  },

  fixtureInvocations(evidence, { max = 1 } = {}) {
    const calls = events(evidence).filter(event => event.type === 'fixture_invocation');
    return verdict(calls.length <= max, `${calls.length} fixture invocation(s); at most ${max} expected`, 'info');
  },
};

export const names = Object.keys(checks);
export const info = Object.entries(checks).filter(([, check]) => check.length > 1).map(([name, check]) => ({ name, options: check.length - 1 }));

/** Runs the named checks over one capture. Unrunnable ones come back unscored, never as passes. */
export function run(evidence, requested = names, { options = {}, validate } = {}) {
  const directory = resolve(evidence);
  return requested.map(name => {
    const check = checks[name];
    if (!check) return { name, pass: null, detail: 'no such check', severity: 'unscored' };
    try { return { name, ...check(directory, options[name] ?? {}), ...(validate && name === 'controlsAreValid' ? validate : {}) }; }
    catch (error) { return { name, pass: null, detail: `threw: ${error.message}`, severity: 'unscored' }; }
  });
}

const usage = `Usage: node scripts/bench/challenge/checks.mjs <command>

  list                              every check, and which ones take options
  run --dir <evidence> [--only a,b]  run checks over a capture; unscored checks say why

Options are given per run in the case file. See packages/teapilot/scripts/bench/challenge/README.md.`;

if (process.argv[1] && resolve(process.argv[1]) === resolve(import.meta.filename)) {
  const [command, ...rest] = process.argv.slice(2);
  if (command === 'list') {
    for (const name of names) console.log(`${name}${info.some(entry => entry.name === name) ? '  (takes options)' : ''}`);
    console.log(`\n${names.length} checks.`);
  } else if (command === 'run') {
    const { values } = parseArgs({ args: rest, options: { dir: { type: 'string' }, only: { type: 'string' }, options: { type: 'string' } } });
    if (!values.dir) { console.error('run needs --dir.'); process.exitCode = 1; }
    else {
      const results = run(values.dir, values.only ? values.only.split(',') : names, { options: values.options ? JSON.parse(values.options) : {} });
      for (const result of results) console.log(`${result.pass === null ? '?' : result.pass ? '✓' : '✗'} ${result.name}${result.severity === 'info' ? ' (info)' : ''}: ${result.detail}`);
      const failures = results.filter(result => result.pass === false);
      console.log(`\n${results.filter(result => result.pass === true).length} passed, ${failures.length} failed, ${results.filter(result => result.pass === null).length} unscored.`);
      if (failures.length) process.exitCode = 1;
    }
  } else console.log(usage);
}
