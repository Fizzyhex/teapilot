# ScratchBench - Import audit board
{tags: "audit", "context-window" }

Version: 1.0 — 28 September 2026  
Status: executable test specification; the fixture, hooks and instrumentation exist (see [Running in this repository](#running-in-this-repository)). No benchmark has been run and no results are claimed here.  
Related proposal: [Teapilot issue #15](https://github.com/Fizzyhex/teapilot/issues/15)

## Purpose

Test whether Teapilot uses session scratchpads to recover relevant evidence after context reduction, while avoiding unnecessary storage, retrieval, and repeated work.

The benchmark succeeds when the agent builds a correct Discord app, selectively retrieves a previously omitted detail, and then reuses what it learned. Creating a scratchpad file or calling a search tool is not success by itself.

This document includes the rationale for the design, an existing-case recommendation, fixture requirements, operator instructions, scoring, and reporting. It is a standalone benchmark specification, not a new installed skill.

## Instructions for the evaluating agent

1. Read the repository's current `AGENTS.md` and `.agents/skills/discord-play-fine-tuner/SKILL.md`. Reconcile current tool names and driver behaviour before running.
2. Use the Discord simulator to exercise the normal Teapilot agent, tools, policy, scratchpad capture, and app runtime. Do not replace the model or scratchpad behaviour with scripted successful responses.
3. Keep evaluator-only data, expected answers, target selection, and scoring instructions out of Teapilot's context and accessible filesystem.
4. Do not tell Teapilot to use the scratchpad. Its ordinary production guidance should be sufficient.
5. Check the live app, its state/source, and tool trace. A confident reply is not proof of success.
6. Freeze implementation and prompts during each scored batch. Changes require a new batch; do not blend tuning runs into final scores.
7. Use an isolated test profile and disposable data. Real models may incur cost. Follow the repository's approval rules and stop every simulator session you start.
8. Report missing instrumentation as a blocker. Do not label an ordinary follow-up or a service restart as compaction without evidence that compaction occurred.

## Why this benchmark

Large logs contain cheap-to-discard noise and expensive-to-lose evidence. Keeping a complete log in context wastes tokens; keeping only its beginning may remove the final outcome or the event that explains a failure.

The design tests three different decisions:

- **Retain:** archive oversized output automatically, while presenting a bounded preview.
- **Retrieve:** search the archive when a later question needs an omitted fact.
- **Reuse:** answer subsequent questions from the established finding without searching again.

A small audit board keeps app implementation simple enough that memory behaviour can be observed. Unique seeded records and private expected answers reduce guessing. A cosmetic follow-up tests restraint. Full-output capture and model-initiated reads are measured separately: automatic host archiving is not model overuse.

Storage alone is not memory. A successful system also preserves the operation outcome and a useful reference in context, so the agent knows what exists and why it matters.

## Best existing case: 1U, Kessel Sabacc

Use the existing case in [ultra-challenges.md](https://github.com/Fizzyhex/teapilot/blob/e205074/.agents/skills/discord-play-fine-tuner/ultra-challenges.md) as a complementary integration test. It naturally spans research, confirmation/correction, implementation, and playtesting.

The [previous report](https://github.com/Fizzyhex/teapilot/blob/e205074/feedback/finetuning-reports/2026-09-27-finetune-2.md) recorded omitted special cards, private-hand leakage, and chip-accounting errors. These give concrete behaviours to inspect.

For a controlled scratchpad variant:

1. Supply a fixed, independently validated, detailed rules document through the normal tool-result path. Keep the original live-web-research case as a separate test.
2. Confirm the rules and add one explicit house-rule correction. Record the correction as authoritative over the source document.
3. Build the game, forcing production compaction at a supported boundary.
4. Ask about a less prominent rule whose details are demonstrably absent from active context. Observe targeted retrieval and play through the affected behaviour.
5. Request a title/emoji change. It should not trigger another rules search.

Judge rule fidelity, preservation of the correction, lack of repeated source acquisition, and restraint on the cosmetic update. Do not force a lookup if the needed rule is already correctly retained in the summary; select/pre-register a retrieval probe and check its validity.

**Why this is not the primary benchmark:** errors in research, rule interpretation, or game implementation can obscure scratchpad effects. Case 3U's co-op farm is useful for continuity across updates, but it has less inherent need to retrieve large retained evidence. Use Import audit board to isolate that requirement more cleanly.

## Benchmark contract

### User-visible task

Build a minimal `discord.play` import audit board from diagnostic output, then add a record-specific explanation and make a cosmetic change.

The board needs a title, clearly labelled totals, and a working Refresh/view control or equivalent minimal interaction. A static model reply does not satisfy the app requirement. The control must not rerun the diagnostic; it displays the already captured snapshot.

### Required fixture

Provide a test-only read-only tool, provisionally `run_import_diagnostic`, returning a deterministic diagnostic snapshot as text. Route it through the same production output-bounding and scratchpad-capture path being evaluated. This name is a proposed fixture interface, not an existing Teapilot command.

The fixture must:

- Generate approximately 10,000 event lines plus a compact header/footer; exceed the configured tool preview cap comfortably.
- Include a header with `snapshot_id`, distinct record count, final-success count, final-failure count, and retried-record count. Success and failure partition records; retried is an overlapping count, not a third final status.
- Include event rows with unique event ID, timestamp/sequence, exact record ID, attempt number, event type, and diagnostic detail.
- Include records with an initial failure followed by successful retry, and records whose retry still fails.
- Interleave similarly named unrelated records and harmless noise. Keep exact-ID matching sufficient; no fuzzy retrieval or domain expertise should be required.
- Place decisive target events outside both the head and tail preview. Include one seed-specific diagnostic detail so a generic guess is insufficient.
- Return the same snapshot on a repeated call. Count every invocation rather than denying repeats and thereby forcing the desired behaviour.
- Have no real network or external side effects and contain no real credentials or personal data.

Use a versioned deterministic generator. For example, derive IDs and event detail from SHA-256 of a private seed plus record/event index; construct valid event sequences first, then interleave them while preserving each record's event order. Compute the header and evaluator manifest from those sequences. Test that the generator's totals and terminal states agree before evaluating the model.

Publish the generator revision and seeds in the evaluator report after the batch, for reproducibility. Teapilot must not see the generator, seed, answer manifest, or a prewritten full-log file. The full log becomes available to it only through the diagnostic result and any legitimate output retention performed by the tested implementation.

Prefer this fixture tool for the primary benchmark. A later shell-backed variant can test Pi's temporary-file import path separately. Do not conflate the two capture mechanisms in one score.

### Evaluator-only manifest

Record at least:

```json
{
  "fixture_version": "<revision>",
  "seed": "<private-during-run>",
  "snapshot_id": "<id>",
  "record_count": 1000,
  "final_success_count": "<integer>",
  "final_failure_count": "<integer>",
  "retried_record_count": "<integer>",
  "target": {
    "record_id": "<id>",
    "initial_failure_event_id": "<id>",
    "initial_failure_detail": "<seed-specific detail>",
    "retry_attempt": "<integer>",
    "terminal_event_id": "<id>",
    "terminal_outcome": "<success-or-failure>",
    "evidence_line_ranges": [["<start>", "<end>"]]
  }
}
```

This is a schema illustration, not a runnable fixture or a user-facing tool result. Select the target deterministically before the run; do not choose whichever record makes a completed run look favourable. The agent learns its ID only in stage 3.

## Instrumentation and validity gates

Capture an evaluator trace containing:

- Repository and fixture revisions; model/provider/version, tier, sampling settings, context/output limits, and redacted profile settings.
- Logical session ID, request/attempt IDs, tool-call IDs, and app ID.
- Diagnostic invocation count and output byte/line count.
- Scratchpad artifact ID, completeness, size, and capture-to-reference mapping.
- Model-visible messages at the relevant boundaries, including previews, retained summaries, and references.
- Compaction/retry/restart events, with pre/post message and token counts where available.
- Model-initiated retrieval calls, returned bytes/lines/tokens, range/query, and stage.
- App snapshots, interaction outcomes, elapsed time, model usage, failures, and final answers.

Do not inject this trace into the tested session. Use synthetic data and redact service secrets from evaluator output.

Before stage 3, verify all of the following:

1. The diagnostic actually executed and its complete output was captured in the scratchpad-enabled condition.
2. The chosen boundary actually occurred.
3. The exact initial-failure detail and terminal-outcome evidence are absent from all active model-visible context, including summaries, earlier searches, notes injected into context, and app source.
4. A usable artifact reference or bounded catalog discovery path remains available in the scratchpad-enabled condition.
5. The target record has not already been investigated.

If gate 3 fails because compaction retained the answer, record a **retrieval probe invalid: evidence retained** outcome, not a model failure. Preserve the continuity result and fix/pre-register a harder fixture for a future batch. Do not manually delete an answer from a real summary merely to manufacture a pass.

Before stages 4 and 5, verify the stage-3 finding remains available in active context and no intervening compaction/restart occurred. Otherwise those stages cannot validly measure unnecessary retrieval.

## Run matrix

Start with a matched comparison:

| Condition | Boundary | Purpose |
| --- | --- | --- |
| Scratchpad enabled | Production compaction | Primary test |
| Clipping-only baseline | Same compaction policy | Measure the benefit of retained evidence |

Change only output retention/retrieval between the primary conditions. Use the same fixture seed, model, profile, prompt sequence, and compaction policy. A baseline that explicitly admits it lost the evidence is honest and should be reported as such; a guessed answer is not a successful retrieval.

Additional, separately reported variants:

- **No boundary:** checks capture and retrieval plumbing without compaction.
- **Forced retry:** restart an attempt after successful capture using a test hook that invokes normal host continuation, without rerunning the diagnostic as part of setup.
- **Service restart:** restart the simulator service after stage 1 and verify session history/reference restoration. Restart is not a synonym for compaction.
- **Natural threshold:** allow context pressure to trigger compaction without a forced hook; record whether it actually triggers.

Use at least five pre-registered seeds for the primary matched comparison. Report every run, including invalid probes and blockers. Expand to more seeds or repeated generations if results are variable. Five runs are a smoke benchmark, not strong statistical proof.

## Running in this repository

The scratchpad is an ordinary folder per session (`.scratch/` inside the conversation's workspace), which the agent uses with its usual file and search tools. An "artifact" or "reference" in this document is a saved file there, and the tool result names its path.

| Benchmark need | How |
| --- | --- |
| Fixture and manifest | `node packages/teapilot/scripts/bench/import-diagnostic.mjs generate --seed <seed> --out <evaluator dir>` writes `snapshot.txt` and the evaluator-only `manifest.json`. |
| `run_import_diagnostic` | `start --fixture <dir>/snapshot.txt`. The simulator copies the snapshot into the session's state and serves it through a read-only tool. Every call is logged as `fixture_invocation`, and repeats are never refused. |
| Clipping-only baseline | `start --scratchpad off`. Long results are still bounded, but nothing is kept. |
| Compaction boundary | `start --compact-history` replays every earlier turn through the production `compact()` step, the newest included, so each stage starts after a real boundary without losing turns. `start --history-tokens N` also caps the budget, which drops whole turns once it is small (4000 dropped stage 3's finding before stage 5). `history_fit` events record turns, levels and tokens. |
| Forced retry | `start --force-retry run_import_diagnostic` ends the first attempt after the diagnostic's first success, through normal host continuation. |
| Model-visible context | `start --trace` writes each model call's system prompt, tools and messages to the session's `trace/` folder. Copy it before `stop`. |
| Capture and retrieval trace | `scratch <name>` lists each conversation's scratchpad files. It also lists the `scratch_saved`, `scratch_access`, `fixture_invocation`, `history_fit` and attempt events since the session started. |

## Procedure

### 0. Preflight and launch

Implement/verify the fixture and tracing first. Use existing production compaction through a test-only threshold override or explicit hook; do not invent a CLI flag. If no supported trigger exists, report the primary condition blocked and run only the clearly labelled no-boundary variant.

The existing driver supports this general command shape; inspect current `--help` before use:

```bash
node packages/teapilot/scripts/agent-discord.mjs --help
node packages/teapilot/scripts/agent-discord.mjs start --name scratchpad-bench-01 --config-dir /absolute/test-profile --root /absolute/disposable-workspace --frozen
```

Replace absolute paths with the isolated profile/workspace. Use a fresh name and clean session for every condition. Keep the same Discord conversation throughout one run. Grant only permissions needed for the fixture and app; inspect any approval before answering it.

### 1. Capture and build

Send exactly:

> Run the import diagnostic and make a minimal discord.play board showing the snapshot ID, total records, final successes, final failures, and records that needed retries. Add a Refresh button that displays this same captured snapshot without rerunning the diagnostic.

Wait for completion. If an approval is necessary, answer it according to the test scope; do not add coaching. Inspect the board and click Refresh. Verify totals, snapshot ID, and that the click does not invoke the diagnostic again.

Expected: one diagnostic invocation, bounded tool preview, complete retained output in the enabled condition, and correct board totals. No full-log reread is necessary because totals are in the header. An unnecessary lookup is measured, not silently excused.

### 2. Apply the selected boundary

For the primary condition, force the actual compaction mechanism at a safe boundary after capture and stage-1 completion. Record the trigger and resulting context. Apply the validity gates above.

For the restart variant, use the driver's `restart` operation and verify restored identity/history directly; help text may lag implementation. Never use `/new` or `/convo clear` as a substitute: those intentionally discard task/conversation state.

### 3. Targeted investigation

Substitute only the preselected record ID:

> Why did record <RECORD_ID> fail initially, and did its retry eventually succeed? Add the initial failure reason, retry attempt number, and final outcome to the board. Include the supporting event IDs so I can trace the explanation.

Expected: targeted retrieval from the original retained artifact, correct causal detail and terminal outcome, and a working updated board. A valid route might be one exact-ID search followed by a small line window. Do not require a particular tool name, exact call count, or use of both search and read when one suffices.

Inspect returned evidence before the explanation in the trace. An answer that merely prints a plausible scratchpad link is not proof of retrieval. Reacquiring the entire diagnostic snapshot counts as repeated work even if it produces a correct answer.

### 4. Cosmetic update

Send exactly:

> Rename the board “Import review” and use ✅ for final successes. Keep the figures and record explanation unchanged.

Expected: correct update without reopening the diagnostic archive or rerunning the diagnostic. Inspect the app before and after. Normal app inspection needed to make a safe edit is allowed and logged separately from scratchpad retrieval.

### 5. Reuse established finding

Send exactly:

> What was the final outcome for that same record? Answer in one sentence.

Expected: correct response from the now-established context, with no archive retrieval and no diagnostic rerun. Repeating the explanation does not require rewriting a scratchpad note.

### 6. Verify and clean up

Typical inspection commands:

```bash
node packages/teapilot/scripts/agent-discord.mjs apps scratchpad-bench-01
node packages/teapilot/scripts/agent-discord.mjs app scratchpad-bench-01 <observed-app-id>
node packages/teapilot/scripts/agent-discord.mjs screen scratchpad-bench-01
node packages/teapilot/scripts/agent-discord.mjs log scratchpad-bench-01
node packages/teapilot/scripts/agent-discord.mjs stop scratchpad-bench-01
```

Use actual message/control IDs returned by the simulator when clicking. `wait --for 'Result: '` is available for turn completion; choose a bounded timeout suited to the configured model. Inspect pending approvals rather than treating waiting as a model failure. Always stop the session, including after exceptions/timeouts.

The standard screen/log commands alone may not expose all retrieval content or outbound context. Additional evaluator instrumentation is required for causal evidence and validity gates.

## Scoring

Report separate dimensions. Do not combine them into a single score that lets high efficiency compensate for incorrect answers.

| Dimension | Pass criterion |
| --- | --- |
| App correctness | Correct totals/snapshot; Refresh works without re-export; record explanation and cosmetic update are correct; no unresolved Discord rejection |
| Evidence correctness | Exact initial-failure detail, retry attempt, terminal outcome, and supporting event IDs match the manifest |
| Retrieval demonstrated | Trace shows decisive evidence returned from retained output before the answer, after a valid omission boundary |
| Continuity | One diagnostic invocation; original artifact remains resolvable across the tested boundary |
| Restraint | No diagnostic-archive reads/searches or duplicate note writes in stages 4–5, with finding still available in context |
| Boundedness | Previews, catalog entries, and retrieval responses stay within configured budgets; no complete-log reinjection |

Initial efficiency target for stage 3: no more than **2,000 model-visible retrieval tokens**, and preferably less than **5% of the full log's token size**. These are provisional engineering thresholds, not established universal limits. Record actual numbers and calibrate using held-out seeds before making them release gates.

Count all retrieved text across scratchpad, shell, and alternative tools so moving a full-log read into bash does not evade the measurement. Count model-visible catalog text as retrieval overhead. Report automatic capture bytes and model-authored note writes separately. Structured host-maintained outcome updates are not penalised as note churn.

Programmatic scanning of the retained file is acceptable if it returns bounded relevant evidence and remains within permissions; measure bytes scanned separately from tokens returned. A full-file scan is not the same as flooding model context.

Use these verdicts:

- **Pass:** correctness, demonstrated retrieval, continuity, restraint, and boundedness all pass.
- **Correct but inefficient:** correct evidence/app, but redundant reads, reruns, or excessive returned content.
- **Incorrect:** wrong evidence or app behaviour, including hallucinated event IDs.
- **Invalid probe:** required omission/availability conditions were not met; do not count as pass or failure.
- **Blocked:** missing fixture, compaction hook, tracing, permissions, or infrastructure prevents evaluation.

Distinguish scratchpad defects from app/runtime/model failures in the report. All remain visible; attribution prevents an unrelated app bug from being misreported as missing memory.

## Report template

```markdown
# Scratchpad benchmark report

## Configuration
- Teapilot revision:
- Fixture revision and seeds:
- Model/provider/runtime and sampling settings:
- Context/output limits and compaction trigger:
- Preview/retrieval/storage limits:
- Conditions and run order:

## Results
| Seed | Condition | Valid probe? | App/evidence correct? | Retrieval demonstrated? | Diagnostic calls | Retrieval tokens, stage 3 | Archive calls, stages 4–5 | Elapsed time | Verdict |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |

## Evidence
- Capture/reference identity and completeness:
- Boundary and post-boundary omission check:
- Search/read calls that supplied decisive evidence:
- App states and tested interactions:
- Failure traces and attribution:

## Comparison
- Valid pairs and invalid/blocked runs:
- Correctness and continuity rates:
- Median/range of retrieval tokens, tool calls, and elapsed time:
- Repeated work and unnecessary storage/retrieval:
- Limitations; implementation or prompt changes during unscored tuning:

## Recommendation
- What improved:
- What still fails:
- Smallest general fix and next validation:
```

## Interpretation and limits

- Do not reward scratchpad activity for its own sake. A correct summary that already contains an answer is useful continuity, but cannot demonstrate retrieval of omitted evidence.
- Do not optimise production prompts for fixture names, seeds, specific record IDs, or these exact stages. General instructions about retained evidence and completed work are appropriate.
- The clipping-only baseline may legitimately be unable to answer. Its purpose is to measure evidence recovery, not force dishonest confidence.
- This evaluates textual retained evidence. It does not establish binary/video retrieval quality, cross-session access isolation, quota handling, or redaction safety; those need separate implementation tests.
- Forced compaction isolates the mechanism; natural-threshold runs establish realism. Neither proves that the original reported repetition was caused by clipping.
- Preserve raw evaluator evidence and distinguish completed work, verified facts, and model interpretation in conclusions.

## Sources and relationship to the repository

- [Scratchpad RFC, issue #15](https://github.com/Fizzyhex/teapilot/issues/15).
- [Discord fine-tuning skill](https://github.com/Fizzyhex/teapilot/blob/e205074/.agents/skills/discord-play-fine-tuner/SKILL.md): simulator workflow, live-app verification, generalised fixes, before/after reports.
- [Ultra challenges](https://github.com/Fizzyhex/teapilot/blob/e205074/.agents/skills/discord-play-fine-tuner/ultra-challenges.md): existing 1U/2U/3U cases.
- [Previous fine-tuning report](https://github.com/Fizzyhex/teapilot/blob/e205074/feedback/finetuning-reports/2026-09-27-finetune-2.md): observed rule-fidelity and continuity problems.
- [Discord simulator driver](https://github.com/Fizzyhex/teapilot/blob/e205074/packages/teapilot/scripts/agent-discord.mjs): command shapes checked during preparation; verify against the implementation being tested.

The case selection, fixture design, efficiency targets, and scoring rules are benchmark proposals, not existing repository functionality or measured results.
