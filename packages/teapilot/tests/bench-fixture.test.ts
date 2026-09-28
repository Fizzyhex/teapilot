import { expect, it } from 'vitest';
// @ts-expect-error: a plain script, typed by what it returns
import { generate } from '../scripts/bench/import-diagnostic.mjs';
import { clip } from '../src/workspace/sandbox.js';
import { scratchLimits } from '../src/workspace/scratch.js';

type Manifest = { snapshot_id: string; record_count: number; final_success_count: number; final_failure_count: number; retried_record_count: number;
  target: { record_id: string; initial_failure_event_id: string; initial_failure_detail: string; retry_attempt: number; terminal_event_id: string; terminal_outcome: string; evidence_line_ranges: number[][] } };
const run = (seed: string) => generate(seed) as { text: string; manifest: Manifest };

it('gives the same snapshot for a seed, and a different one for another seed', () => {
  expect(run('seed-a').text).toBe(run('seed-a').text);
  expect(run('seed-b').manifest.snapshot_id).not.toBe(run('seed-a').manifest.snapshot_id);
});

it('states totals that agree with the events, and has about ten thousand lines', () => {
  const { text, manifest } = run('seed-a');
  const lines = text.split('\n');
  expect(lines.length).toBeGreaterThan(10_000);
  expect(text).toContain(`records=${manifest.record_count} final_success=${manifest.final_success_count} final_failure=${manifest.final_failure_count} retried=${manifest.retried_record_count}`);
  expect(manifest.final_success_count + manifest.final_failure_count).toBe(1000);
  const finals = new Map<string, string>();
  for (const line of lines) {
    const match = / record=(\S+) attempt=\d+ type=(imported|failed) /.exec(line);
    if (match) finals.set(match[1]!, match[2]!);
  }
  expect(finals.size).toBe(1000);
  expect([...finals.values()].filter(type => type === 'imported')).toHaveLength(manifest.final_success_count);
});

it('hides the target record from the preview, and an exact search finds only its own events', () => {
  for (const seed of ['seed-a', 'seed-b', 'seed-c']) {
    const { text, manifest } = run(seed);
    const { target } = manifest;
    expect(clip(text, scratchLimits.previewChars)).not.toContain(target.record_id);
    const lines = text.split('\n');
    const matching = lines.filter(line => line.includes(target.record_id));
    expect(matching).toHaveLength(target.evidence_line_ranges.length);
    expect(matching.every(line => line.includes(` record=${target.record_id} `))).toBe(true);
    expect(lines[target.evidence_line_ranges[0]![0]! - 1]).toContain(`record=${target.record_id}`);
    expect(matching.join('\n')).toContain(target.initial_failure_detail);
    expect(matching.join('\n')).toContain(target.terminal_event_id);
    expect(target.retry_attempt).toBe(2);
  }
});
