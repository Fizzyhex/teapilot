# challenge

Tooling for running the `discord-play-fine-tuner` challenges and scoring what came back.

Four pieces, each usable on its own:

| file | what it does |
| --- | --- |
| `evidence.mjs` | captures one run into a self-contained evidence directory, before the session is stopped |
| `checks.mjs` | the named predicates a case's expectations are written in |
| `case.mjs` | runs a declarative case file against the simulator |
| `report.mjs` | scores a capture, batches repetitions, compares before/after, checks for cheating |
| `cases/*.ts` | typed challenge cases, as steps plus mechanical expectations |

## The one rule

**Capture before you stop.** The simulator deletes its session directory on `stop`, and the attachments
teapilot sent with it. `case.mjs run` does this for you. If you drive a session by hand, run
`evidence.mjs capture` first.

## Running a case

```sh
node packages/teapilot/scripts/bench/challenge/case.mjs list
node packages/teapilot/scripts/bench/challenge/case.mjs show snake --json
node packages/teapilot/scripts/bench/challenge/case.mjs run snake --name snake-1 --out /tmp/ev/snake-1
```

`--reps N` runs N repetitions into `rep-1`, `rep-2`, … Three is a smoke benchmark, not statistical proof.
Use `--config-dir` for an isolated profile, `--fixture FILE` for a benchmark fixture, `--root DIR` when a
case needs a real repository, `--dry-run` to check a case file without spending a model, and
`--only 1,3` for a subset of steps.

Runs use real models and cost money. `--frozen` is on by default so timers only fire when a step calls
`advance`.

## Scoring a capture

```sh
node packages/teapilot/scripts/bench/challenge/checks.mjs list
node packages/teapilot/scripts/bench/challenge/checks.mjs run --dir /tmp/ev/snake-1
node packages/teapilot/scripts/bench/challenge/report.mjs score --dir /tmp/ev/snake-1
```

Every check returns `pass`, `fail` or **unscored**. Unscored is not a pass: it means the evidence needed to
answer was not there (no trace, no git workspace, no app started), and the report says which. A dimension
with no machine verdict stays for the agent to read by hand — the tooling narrows the judgement, it does
not replace it.

Checks that measure rather than judge (`turnTimings`, `toolCalls`, `commitsProportional`,
`fixtureInvocations`, `retrievalBudget`) report `info`: the number is the point, and the prose score
decides whether it is good.

## Before and after

```sh
node packages/teapilot/scripts/bench/challenge/report.mjs batch --out /tmp/ev/baseline --label baseline
# make your change, then
node packages/teapilot/scripts/bench/challenge/report.mjs batch --out /tmp/ev/tuned --label tuned
node packages/teapilot/scripts/bench/challenge/report.mjs compare --before /tmp/ev/baseline --after /tmp/ev/tuned
node packages/teapilot/scripts/bench/challenge/report.mjs cheat-check --before /tmp/ev/baseline --after /tmp/ev/tuned
```

`batch` records the revision and patch hash of every run and refuses to call a batch frozen when they
differ. `compare` states its caveats rather than implying an improvement it cannot support: unequal batch
sizes, a changed prompt, a different model or a different case set all make it not comparable as an
aggregate. `cheat-check` greps the implementation diff for fixture names, seeds and challenge strings —
the case-specific coaching the challenge docs warn against.

## Writing a case

A case is the prose, plus steps that can be taken without judgement, plus the mechanical part of what is
expected. Anything left to judgement goes in `judged` and stays yours to read.

```ts
import type { ChallengeCase } from '../case.mjs';

export default {
  id: 'my-case',
  title: 'one line',
  prose: 'feedback/challenges/which-file.md, which case',
  steps: [
    { say: `the prompt, which can span multiple lines`, record: true },
    { click: '▶', note: 'controls resolve by label' },
    { advance: '30s' },
    { restart: true, record: true }
  ],
  expect: ['noRejections', { check: 'appExists', options: { shows: 'Find your yummy' } }],
  judged: ["what still needs an agent's reading"]
} satisfies ChallengeCase;
```

Each step has exactly one action: `say` (with `as`, `in`, `attach`), `slash` (with `choose`, `oneShot`),
`click`, `select`, `submit`, `approve`, `advance`, `restart: true`, `sleep` (milliseconds), or
`inspect: true`. Actors are `op`, `user`, or `stranger`. Every step may carry `note` and `record: true`.
`say` waits for turn completion unless `wait: false`; `slash` finishes on acknowledgement, and
`slash` and `click` wait for a model turn only with `wait: true`.
Check names and their options are checked by `npm run typecheck -w teapilot`, along with every case.

`click` takes a **label, emoji or id**, not a `m4 c0` pair. A selection is
`{ select: { control: 'category', values: ['breakfast'] } }`. Controls resolve against the live dump
at the moment of use — so a case does not rot as message ids shift. `record: true` on the step *before* a
restart is how `appSurvivesRestart` and `historyLacksOldTurns` get the "before" they compare against.

Turns subscribe over one open socket to the simulator's completion events. A deadline is only a safety
ceiling: expiry blocks the run, never advances it. Pending approvals block for operator review; the runner
does not approve automatically. Missing controls and failed interactions also block rather than guessing.

## What a capture holds

`manifest.json` (revision, patch hash, models, counts), `discord.json` (every message as the payload
Discord received, with each control's id; plus warnings, forms and app records), `apps/<id>.json`,
`interactions.jsonl`, `telemetry.jsonl` (this run's events only), `git/` (history, status, ignore views,
and `blobs.json`: **every blob any reachable commit holds**, with its size), `trace/`, `transcript.jsonl`,
`scratch.json`, and `files/` (what teapilot sent).

The blob index is what makes hygiene a query rather than an expedition:

```sh
node packages/teapilot/scripts/bench/challenge/evidence.mjs list --dir /tmp/ev/gitbench-1-rep-1
```

A 549 KB raw capture committed and deleted later is still a reachable blob, and this is where that shows
up. It is the single most common finding in the existing reports, and it was the most expensive to find by
hand.

## Adding a check

Add one function to `checks` in `checks.mjs`. It takes the evidence directory and an options object, and
returns `{ pass, detail, severity }`. Use `verdict(pass, detail)` for a judgement, `verdict(pass, detail,
'info')` for a measurement, and `unavailable(why)` when the evidence is not there. Return `unavailable`
rather than `false`: a missing trace is not a model failure, and scoring it as one is how an invalid probe
becomes a fabricated number.
