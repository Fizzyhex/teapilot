#!/usr/bin/env node
// Generates the scratchpad benchmark's diagnostic snapshot (.agents/skills/discord-play-fine-tuner/teapilot-scratchpad-benchmark.md):
// a deterministic import log of about 10,000 lines, and an evaluator-only manifest with its totals and the record the
// investigation stage asks about. Everything derives from SHA-256 of the seed, so a seed always gives the same files.
//
//   node packages/teapilot/scripts/bench/import-diagnostic.mjs generate --seed <seed> --out <dir> [--records 1000]
//
// Keep the manifest away from teapilot: only snapshot.txt is served to it, through the simulator's --fixture.
import { createHash } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { fileURLToPath } from 'node:url';

export const fixtureVersion = 'import-diagnostic/1';
/** The part of a result teapilot shows unsaved: the start and the end (see clip in src/workspace/sandbox.ts). */
const preview = { headChars: 2000, tailChars: 6000 };

const hash = (...parts) => createHash('sha256').update(parts.join(':')).digest('hex');
const unit = (...parts) => parseInt(hash(...parts).slice(0, 12), 16) / 2 ** 48;
const pick = (list, ...parts) => list[Math.floor(unit(...parts) * list.length)];

const causes = [
  (h) => `timestamp carries an explicit offset +0${1 + (parseInt(h[0], 16) % 8)}:00 in field ts_${h.slice(1, 5)}; the parser assumes UTC`,
  (h) => `column amount_${h.slice(0, 4)} expected decimal, got "${h.slice(4, 7)}.${h.slice(7, 9)}.${h.slice(9, 10)}"`,
  (h) => `foreign key customer=${h.slice(0, 8)} not found in snapshot shard ${parseInt(h[8], 16) % 4}`,
  (h) => `duplicate natural key order_ref=${h.slice(0, 10)} (first seen in batch b-${h.slice(10, 14)})`,
  (h) => `encoding error at byte ${parseInt(h.slice(0, 5), 16)}: invalid UTF-8 continuation 0x${h.slice(5, 7)}`,
];
const retryCauses = [
  (h) => `lock timeout on partition p${parseInt(h[0], 16) % 12} after 3000 ms`,
  (h) => `upstream 503 from pricing-service (trace ${h.slice(0, 12)})`,
];
const noise = ['heartbeat worker=w%d lag_ms=%d', 'cache_warm shard=%d entries=%d', 'gc pause_ms=%d heap_mb=%d', 'metrics flush series=%d dropped=%d'];

/** One record's events in order, with its outcome. */
function recordEvents(seed, index, id) {
  const roll = unit(seed, 'outcome', index);
  const detail = (list, label) => pick(list, seed, label, index)(hash(seed, 'detail', label, index));
  // About 88% import first time, 8% fail and then succeed on retry, 4% fail and fail again.
  const plan = roll < 0.88 ? ['ok'] : roll < 0.96 ? ['fail', 'ok'] : ['fail', 'fail'];
  const events = [];
  plan.forEach((step, attempt) => {
    if (attempt) events.push({ type: 'retry_scheduled', attempt: attempt + 1, detail: `backoff_ms=${250 * 2 ** attempt}` });
    events.push({ type: 'validated', attempt: attempt + 1, detail: `rows=${1 + Math.floor(unit(seed, 'rows', index) * 400)}` });
    if (step === 'ok') events.push({ type: 'imported', attempt: attempt + 1, detail: `rows_written=${1 + Math.floor(unit(seed, 'rows', index) * 400)}` });
    else events.push({ type: 'failed', attempt: attempt + 1, detail: attempt ? detail(retryCauses, `retry${attempt}`) : detail(causes, 'initial') });
  });
  return { id, plan, events: [{ type: 'queued', attempt: 1, detail: `source=batch-${hash(seed, 'batch', Math.floor(index / 50)).slice(0, 6)}` }, ...events] };
}

export function generate(seed, { records: count = 1000 } = {}) {
  if (!seed) throw new Error('A seed is required.');
  const snapshotId = `snap-${hash(seed, 'snapshot').slice(0, 10)}`;
  // Exact IDs, with look-alikes that share a prefix, so only an exact match finds the right record.
  const unique = new Set();
  for (let index = 0; unique.size < count; index++) {
    const base = hash(seed, 'record', index).slice(0, 6);
    unique.add(`imp-${base}`);
    // A look-alike differs in the last character only, so it is never a prefix of another ID.
    const last = [...'0123456789abcdef'].filter(char => char !== base[5]);
    if (unique.size < count && unit(seed, 'twin', index) < 0.15) unique.add(`imp-${base.slice(0, 5)}${pick(last, seed, 'twin', index)}`);
  }
  const ids = [...unique];
  const records = ids.map((id, index) => recordEvents(seed, index, id));
  // Each record starts at its own time and its events follow in order; noise fills the gaps.
  const timeline = [];
  records.forEach((record, index) => {
    let at = unit(seed, 'start', index) * 3_600_000;
    record.events.forEach((event, step) => {
      at += 50 + unit(seed, 'gap', index, step) * (event.type === 'retry_scheduled' ? 600_000 : 20_000);
      timeline.push({ at, record: record.id, ...event });
    });
  });
  const noiseCount = Math.max(0, 10_000 - timeline.length);
  for (let index = 0; index < noiseCount; index++) {
    const template = pick(noise, seed, 'noise', index);
    let n = 0;
    timeline.push({ at: unit(seed, 'noise-at', index) * 3_600_000 + 60_000, noise: template.replace(/%d/g, () => String(Math.floor(unit(seed, 'noise-value', index, n++) * 5000))) });
  }
  timeline.sort((a, b) => a.at - b.at);
  const start = Date.UTC(2026, 8, 1, 9, 0, 0);
  const success = records.filter(record => record.plan.at(-1) === 'ok').length;
  const failure = records.length - success;
  const retried = records.filter(record => record.plan.length > 1).length;
  const lines = [
    `${fixtureVersion} import diagnostic`,
    `snapshot_id=${snapshotId}`,
    `records=${records.length} final_success=${success} final_failure=${failure} retried=${retried}`,
    'Each record ends imported or failed; retried counts records with more than one attempt.',
    '--- events ---',
  ];
  const placed = new Map();
  timeline.forEach((event, seq) => {
    const stamp = new Date(start + Math.round(event.at)).toISOString();
    if (event.noise) { lines.push(`${stamp} seq=${String(seq).padStart(6, '0')} ${event.noise}`); return; }
    const eventId = `ev-${hash(seed, 'event', event.record, event.type, event.attempt).slice(0, 10)}`;
    lines.push(`${stamp} seq=${String(seq).padStart(6, '0')} event=${eventId} record=${event.record} attempt=${event.attempt} type=${event.type} detail="${event.detail}"`);
    const list = placed.get(event.record) ?? [];
    list.push({ ...event, eventId, line: lines.length });
    placed.set(event.record, list);
  });
  lines.push(`--- end of snapshot ${snapshotId}: ${timeline.length} events ---`);
  const text = lines.join('\n') + '\n';

  // Check the header against the events before anyone relies on it.
  const finals = new Map();
  for (const [record, events] of placed) finals.set(record, events.filter(event => ['imported', 'failed'].includes(event.type)).at(-1).type);
  const counted = { success: [...finals.values()].filter(type => type === 'imported').length, failure: [...finals.values()].filter(type => type === 'failed').length };
  if (counted.success !== success || counted.failure !== failure || finals.size !== records.length) throw new Error('Generated totals disagree with the events.');

  // The target failed first, was retried, and has every event outside what a preview shows.
  const headLines = text.slice(0, preview.headChars).split('\n').length;
  const tailLines = text.slice(-preview.tailChars).split('\n').length;
  const hidden = (line) => line > headLines + 100 && line < lines.length - tailLines - 100;
  const candidates = records.filter(record => record.plan[0] === 'fail' && placed.get(record.id).every(event => hidden(event.line)))
    .sort((a, b) => hash(seed, 'target', a.id).localeCompare(hash(seed, 'target', b.id)));
  const target = candidates[0];
  if (!target) throw new Error('No record fits the target rules; choose another seed.');
  const events = placed.get(target.id);
  const initial = events.find(event => event.type === 'failed');
  const terminal = events.filter(event => ['imported', 'failed'].includes(event.type)).at(-1);
  const manifest = {
    fixture_version: fixtureVersion, seed, snapshot_id: snapshotId, record_count: records.length,
    final_success_count: success, final_failure_count: failure, retried_record_count: retried,
    event_lines: timeline.length, bytes: Buffer.byteLength(text),
    target: {
      record_id: target.id, initial_failure_event_id: initial.eventId, initial_failure_detail: initial.detail,
      retry_attempt: events.find(event => event.type === 'retry_scheduled').attempt,
      terminal_event_id: terminal.eventId, terminal_outcome: terminal.type === 'imported' ? 'success' : 'failure',
      evidence_line_ranges: events.map(event => [event.line, event.line]),
    },
  };
  return { text, manifest };
}

async function main() {
  const { positionals, values } = parseArgs({ allowPositionals: true, options: { seed: { type: 'string' }, out: { type: 'string' }, records: { type: 'string', default: '1000' } } });
  if (positionals[0] !== 'generate' || !values.seed || !values.out) {
    console.log('Usage: import-diagnostic.mjs generate --seed <seed> --out <dir> [--records 1000]');
    process.exitCode = positionals.length ? 1 : 0;
    return;
  }
  const out = resolve(values.out);
  const { text, manifest } = generate(values.seed, { records: Number(values.records) });
  await mkdir(out, { recursive: true });
  await writeFile(join(out, 'snapshot.txt'), text);
  await writeFile(join(out, 'manifest.json'), JSON.stringify(manifest, null, 2) + '\n');
  console.log(`Wrote ${join(out, 'snapshot.txt')} (${manifest.event_lines} events) and ${join(out, 'manifest.json')} (evaluator only).`);
  console.log(`Serve the snapshot with: node packages/teapilot/scripts/agent-discord.mjs start --fixture ${join(out, 'snapshot.txt')}`);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) await main();
