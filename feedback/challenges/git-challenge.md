# GitBench: offline kiosk handoff
{tags: "discord.play", "git", "memory", "sub-agents", "latency" }

version: 1.0 — 1 october 2026

this is a challenge for [discord-play-fine-tuner](./SKILL.md). only run it when asked. validate the runtime gates below before starting a scored batch.

## purpose

test whether teapilot uses meaningful commits and concise notes to preserve useful memory, collaborate with juniors and resume work. the task is an offline café kiosk; the evaluator checks git behavior without telling teapilot which git commands or ignore rules to use.

- track concise plans, handoffs, decisions and useful scripts.
- ignore session transcripts, large captured output, archived/downloaded pages and disposable intermediate files.
- keep the directory tidy and git work proportional to useful milestones. commit overuse means unnecessary delays, not simply mentioning a commit in a reply.

git being available, a commit existing, or a confident final reply is not proof of success. inspect the app, artifacts, history and actual tool calls.

## setup and fixture

read the current `AGENTS.md` and skill before running. use an isolated profile with the intended models, normal scratchpad behavior and a fresh disposable simulator session for each repetition. omit `--root`: do not expose this checkout or evaluator files to the tested agent. use `--trace`; do not enable reduced history, forced retry or compaction hooks for this challenge.

### fixed catalog, fixture version 1

| id | category | name | price in pence | available | description |
| --- | --- | --- | --- | --- | --- |
| b1 | breakfast | egg roll | 325 | true | egg in a soft roll |
| b2 | breakfast | toast | 180 | true | two slices with butter |
| b3 | breakfast | porridge | 290 | false | warm oats with apple |
| s1 | sweets | brownie | 260 | true | chocolate brownie |
| s2 | sweets | lemon slice | 245 | false | lemon sponge slice |
| s3 | sweets | flapjack | 210 | true | oat and syrup bar |

generate the fixture in an evaluator-only directory outside the checkout and simulator repository. the following standalone JavaScript is the canonical recipe; run it with Node, setting `GITBENCH_OUT` to that directory. keep the script and manifest out of teapilot's context.

```js
import { mkdirSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { createHash } from 'node:crypto';
if (!process.env.GITBENCH_OUT) throw new Error('set GITBENCH_OUT to an evaluator-only directory');
const out = resolve(process.env.GITBENCH_OUT);
const products = [
  { id: 'b1', category: 'breakfast', name: 'egg roll', price_pence: 325, available: true, description: 'egg in a soft roll' },
  { id: 'b2', category: 'breakfast', name: 'toast', price_pence: 180, available: true, description: 'two slices with butter' },
  { id: 'b3', category: 'breakfast', name: 'porridge', price_pence: 290, available: false, description: 'warm oats with apple' },
  { id: 's1', category: 'sweets', name: 'brownie', price_pence: 260, available: true, description: 'chocolate brownie' },
  { id: 's2', category: 'sweets', name: 'lemon slice', price_pence: 245, available: false, description: 'lemon sponge slice' },
  { id: 's3', category: 'sweets', name: 'flapjack', price_pence: 210, available: true, description: 'oat and syrup bar' },
];
const noise = Array.from({ length: 10000 }, (_, i) => `<!-- archived layout note ${i}: unused banner slot -->`).join('\n');
const html = `<!doctype html>\n<html lang="en"><head><title>archived café supplier catalog</title></head><body>\n<h1>supplier catalog</h1>\n<script id="catalog" type="application/json">${JSON.stringify(products)}</script>\n${noise}\n</body></html>\n`;
if (products.length !== 6 || new Set(products.map(p => p.id)).size !== 6) throw new Error('invalid catalog');
for (const category of ['breakfast', 'sweets']) {
  if (products.filter(p => p.category === category).length !== 3) throw new Error('invalid category count');
}
if (!products.every(p => Number.isInteger(p.price_pence) && p.price_pence > 0)) throw new Error('invalid price');
const extracted = JSON.parse(html.match(/<script id="catalog" type="application\/json">([\s\S]*?)<\/script>/)[1]);
if (JSON.stringify(extracted) !== JSON.stringify(products)) throw new Error('HTML catalog mismatch');
mkdirSync(out, { recursive: true });
writeFileSync(join(out, 'catalog.html'), html, 'utf8');
writeFileSync(join(out, 'manifest.json'), JSON.stringify({
  fixture_version: 1, sha256: createHash('sha256').update(html).digest('hex'),
  bytes: Buffer.byteLength(html), products,
  addition: { category: 'breakfast', name: 'oat pot', price_pence: 240, available: true },
  delivery_decision: 'the café’s delivery queue integration is postponed until november',
}, null, 2) + '\n', 'utf8');
```

the HTML is an archived downloaded-page substitute, not a live-web test. all catalog facts are near the beginning: this tests storage hygiene and durable decisions, not retrieval of a hidden product fact. the repeated comments exceed the default scratch preview cap comfortably, while fitting below the default saved-file cap. compare the actual byte/character count with the tested profile's limits; missing capture invalidates the large-output hygiene probe.

### start and preflight

replace the placeholders with absolute evaluator paths:

```sh
node packages/teapilot/scripts/agent-discord.mjs start --name gitbench-1 --config-dir <isolated-profile> --scratchpad on --trace --fixture <evaluator-dir>/catalog.html --fixture-name fetch_kiosk_catalog --fixture-description "returns the archived café supplier catalog as HTML; read-only and offline, with no network access"
```

only `catalog.html` is passed to the simulator. the fixture mechanism copies it into session state and registers a read-only tool. do not attach the manifest or challenge document, and do not refuse repeated fixture calls: measure them.

before scoring, verify the isolated profile exposes `discord.play`, git, the sandbox and the fixture tool. inspect capability/status evidence and the first model trace. missing prerequisites are blockers, not model failures. follow the repository's approval rules and grant only actions required by this task. do not silently change models or prompts to rescue a scored run.

record repository revision and local changes, fixture hash, model/provider, relevant limits, profile settings without secrets, session/request/app IDs and start time. freeze them for the batch.

## challenge sequence

send each prompt unchanged, one at a time. use `say`, wait for the turn to finish, and inspect `screen` and `log`. wait calls should use short timeouts (at most 60 seconds per call), repeating as needed so approvals and stalled turns can be inspected. exclude evaluator waiting/inspection time from model latency.

### 1. plan and delegate

```text
/plan build an offline discord.play café kiosk using fetch_kiosk_catalog. show breakfast and sweets, product details, prices and availability, with category selection and previous/next controls. keep the normalized catalog and a reusable validator in the workspace so we can update it later. keep the implementation small.
```

inspect the plan embed itself. press **assign juniors**, inspect the revised plan, then press **lgtm!**. discover message/control IDs from the simulator; do not hard-code them. the assign-juniors button refines the plan; it does not approve implementation.

expect deliverables grouped sensibly, dependencies respected and shared-file collisions avoided. planning alone should not implement the app. verify actual delegation, junior ownership/authors and instructor review in transcripts and git calls, not just TODO labels.

### 2. verify the build

use `apps`, `app`, `screen`, `select` and `click` to check both categories, navigation, descriptions, all six prices and the two unavailable products. a reply or static embed alone is insufficient. Discord rejection lines count as correctness failures.

inspect the generated validator before executing it against the normalized catalog; record its command, output and exit status. the canonical catalog has three products per category and four available products. no network should be needed. do not use an evaluator shell command through the model to request git inspection or teach it the rubric.

capture repository snapshot A: git history with authors and changed paths, tracked/ignored/untracked files, scratch inventory, app source/state and tool traces. preserve the catalog acquisition and scratch capture events.

### 3. decision and handoff

```text
leave delivery ordering out because the café’s delivery queue integration is postponed until november. change the unavailable label to “sold out”. leave a short handoff covering what works, decisions, checks and next steps so another agent can pick this up.
```

verify the new label and snapshot B. the historical delivery rationale should survive in useful durable material, without copying the full conversation or repeating implementation details unnecessarily. a handoff saved outside `.scratch` may count as useful memory too; note its location.

do not ask for a commit, name a handoff path, prescribe ignore rules or correct git habits. answer essential product questions only and record deviations from the fixed prompt sequence.

### 4. clear and resume

once the previous turn has finished:

```sh
node packages/teapilot/scripts/agent-discord.mjs slash gitbench-1 "/convo clear"
```

do not choose the offered workspace-clear action, use `/new`, or manually restore files. scratch removal is asynchronous: wait until `.scratch` is absent in the actual conversation workspace. verify that `.git`, non-scratch workspace files and the app remain. snapshot C, including the resulting tracked deletions.

send:

```text
pick up the café kiosk from the existing workspace. why did we leave delivery ordering out, and what has been checked? add an available breakfast item called oat pot at £2.40. update the catalog and run its validator.
```

inspect the first resumed model request in `--trace` output. old turns and the delivery rationale must be absent from replayed conversation history. report any automatic context source that already supplies the answer. if the old history remains, mark the recovery probe **invalid**, not a memory success. clearing is not compaction, and restarting the service is not a substitute.

require correct historical recall, truthful descriptions of checks, observable git-history retrieval and selective recovery of useful artifacts. getting the answer solely from a surviving untracked note is continuity, but not proof of git as memory. restoring the entire scratchpad, including disposable files, loses hygiene credit. missing historical notes is a memory failure, not an invalid probe.

verify seven products, four breakfast items, five available products and the new item's price. check that existing behavior and “sold out” labels remain correct. inspect validator execution and take snapshot D. do not repair artifacts or insert hints if recovery fails.

### 5. restraint

```text
rename the kiosk to “morning counter”.
```

verify the title and capture snapshot E. assess git work proportional to this small update, without unnecessary catalog acquisition, broad validation, repeated handoff reconstruction or fragmented commits. a meaningful title-change commit is allowed.

## evidence and scoring

collect evidence read-only from the simulator session's state directory, whose path is in its metadata under the OS temporary `teapilot-discord/<name>` directory. discover the conversation workspace under `state/workspaces`; do not confuse it with the simulator's `repo` directory. correlate it with the conversation ID and transcript. use only the isolated session's logs, not personal profile conversations.

at each snapshot, inspect these git views from that workspace with literal paths:

```sh
git -C <workspace> log --all --format=fuller --name-status
git -C <workspace> status --short --untracked-files=all
git -C <workspace> ls-files
git -C <workspace> ls-files --others --ignored --exclude-standard
git -C <workspace> ls-files --others --exclude-standard
```

inspect every reachable commit's tree and relevant blobs using `rev-list --all`, `ls-tree -r` and `show <commit>:<path>`. a transcript or raw archive committed and deleted later remains a hygiene failure. distinguish evaluator inspection commands from model calls; only model calls count toward git-use and overhead metrics. exempt the host's initial commit from commit-frequency scoring, but inspect its content for storage leaks.

score each category from 0–4. use 4 for full evidence-backed success, 3 for success with minor waste/omissions, 2 for partial success, 1 for weak or largely unsuccessful behavior and 0 for failure. explain deductions with concrete evidence. total: 20; also retain the five separate scores.

| category | full-credit behavior |
| --- | --- |
| correctness | working kiosk, accurate catalog and controls, working validator, correct resumed addition and title |
| durable memory | useful milestones and concise handoff; correct historical recall, accurate checks and demonstrated git retrieval after clear |
| junior collaboration | sensible ownership, useful junior contributions and instructor review before integration |
| hygiene | concise plans, handoffs, decisions and reusable scripts tracked; transcripts, large output, archived pages and disposable intermediates excluded from history |
| efficiency | tidy working directory, concise notes/messages and git work proportional to meaningful changes |

judge commit contents and recovery value, not a fixed count. durable notes can be consolidated; a commit per tool call or wording tweak is waste unless it preserves a useful milestone. verbose commit bodies and duplicated/stale handoffs reduce credit when they obscure useful information.

automatic host capture is not agent-created clutter. retained ignored output is acceptable. check that generated disposable material is actually ignored rather than merely left unstaged. duplicates, stale intermediates and unnecessary restoration reduce hygiene/efficiency credit. record filenames, sizes, ignore rules and history evidence rather than guessing from directory names.

record each turn's duration, model git tool calls, retries/failures, fixture invocations, redundant operations and commit count excluding initialization. recover evidence from bounded telemetry/transcript tails, model traces and simulator logs. attribute junior calls separately; do not add nested junior time to parent elapsed time.

`--trace` records model-visible context; it is not precise git timing instrumentation. measure git execution time only where matching call boundaries/timestamps support it. for a shell call mixing git and other work, report whole-call elapsed time as an approximate upper bound, not pure git duration. if boundaries cannot be matched, report timing unavailable and still count unnecessary calls. do not infer a causal latency percentage or impose a provider-dependent hard response limit.

## validation, batch and report

before declaring this executable, validate fixture extraction, category counts, prices, hash and size; current simulator commands/buttons; actual git/sandbox/tool availability; app behavior; scratch capture; asynchronous clear semantics; absence of old model history; and available timing evidence. fixture or runtime failures block the affected probe. distinguish invalid recovery/large-output probes from valid model failures; do not give an invalid probe a fabricated numeric score or include its total in aggregate results.

run three fresh repetitions with the same fixture and frozen implementation/profile for the first baseline. disclose any local changes, routing/model variation or operator corrections. preserve all runs, blockers and invalid probes. report individual scores and timing ranges; three runs are a smoke benchmark, not statistical proof. tuning requires a separate batch and generic improvements, not case-specific prompt coaching.

write a short before-run report stating setup and expected behaviors, then append results to `feedback/finetuning-reports/yyyy-mm-dd-finetune-<index>.md` using the run's date and the next unused index. include:

- revisions/profile/fixture hash, validity gates and any deviations;
- a per-run score table, stage timings, git calls/commits/retries and timing limitations;
- evidence for recovery, junior review, tracked useful artifacts and excluded temporary material;
- failures, practical findings and proposed generic improvements; before/after comparisons only when both batches actually ran.

copy required traces, repository evidence and app snapshots to evaluator storage before stopping; the simulator deletes session files on stop. never describe an unperformed run as a baseline or improvement. always stop every session you start, including blocked runs:

```sh
node packages/teapilot/scripts/agent-discord.mjs stop gitbench-1
```
