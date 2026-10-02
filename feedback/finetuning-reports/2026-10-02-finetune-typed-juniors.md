# typed juniors: real-profile wolf3d smoke test

**outcome: planning-quality failure; implementation/play blocked by invalid plans.** No production code edited. One simulated Discord session (`typed-wolf`), real personal profile, source-mode tree, model `Qwen3.8-27B-heretic-ara-exl3-4.0bpw`. Evidence captured before stopping.

## before vs after

- Before: the delegating agent described prior overthinking/redundant research and planning/delegation issues; no comparable pre-change run was supplied or performed here. Do not interpret this as a measured before/after improvement.
- After: both requests were mechanically marked successful and rendered saved plans with **lgtm / assign juniors / request change** controls, but neither plan accurately implemented original Wolf3D mechanics. Bounded exploration terminated, yet fabricated source claims and redundant research survived.

## prompts and fixture

Initial prompt, unchanged:

> /plan port the rest of the missing core level 1 from wolfenstein to tea-wolfenstein: doors, exit doors, stone walls. use the id-software wolf3d source on GitHub as a reference.

Baseline copied from the explicitly authorized user's app into `C:/Users/simul/AppData/Local/Temp/opencode/typed-juniors-wolf/apps/tea-wolfenstein.js`; driver started with that fixture as `--root`. **Harness caveat:** tools actually inspected a separate empty conversation workspace, not the driver's root. This first plan is not a valid existing-app-context test.

One normal adaptation: reran the same prompt with `existing app attached; canonical reference: https://github.com/id-Software/wolf3d`, attaching the unchanged source. No role/budget hints, workaround instructions, source answers, or researcher summaries supplied. This rerun successfully read the app and is the substantive existing-app result.

Original and fixture SHA-256 remained identical: `54c65e7d5f745a6faff92e33c4b7d458b709b77dd59ae1527b7901545961cc8f`.

## observed requests

| request | elapsed | telemetry turns / toolCalls | actual calls emitted | result |
| --- | --- | --- | --- | --- |
| `bb843c4b-6f6b-4037-8d4c-fc707a7a462f` | 4m 39s | 20 / 22 | 22 | empty-workspace plan, wrong source files and exit behavior |
| `7c3f2d53-30c7-4ec1-ab3d-7091aff54b3d` | 3m 06s | 10 / 8 | 12 including refused searches | app-aware plan, nonfaithful mechanics |

Total accounted cost $0.000406350; local model inference reports zero model cost. No typed junior calls, capability requests, exploratory compaction entries, or live apps. Neither run exercised per-junior caps. First run received the exploration-withdrawal notice below the request-wide cap of 24; thus this does not prove a cap-boundary test. Second run had three identical refused searches and then a tools-withdrawn notice. It read the same `WL_DEF.H` URL three times and repeatedly searched invented `walltype` names. First run also read its own transcript instead of using bounded task receipts, searched nonexistent enums, and hit one artifact limit validation error. No observable paging intervention.

## qualitative findings / source check

- First plan falsely assigned door logic to `ID_MM.C` (memory manager), wall-type enums to `ID_VL.H` (video layer), and actual map placement to `MAPSWL1.H`.
- Attached-source plan recognized DDA/18x12 rendering and 12x10 grid, but made doors boolean-only, explicitly deferred animation/timing, and completed the level by walking onto/reaching an exit door. This is not the requested original-source behavior.
- It proposed turning existing blue walls into "stone" while keeping the same blue glyph, rather than a solid visual variant. It proposed adding tiles "where level 1 has them" without map data and made geometry reconciliation optional.
- Independent evaluator-only checks (not fed to teapilot): [WL_ACT1.C](https://github.com/id-Software/wolf3d/blob/master/WOLFSRC/WL_ACT1.C) contains `OperateDoor`, sliding `doorposition`, opening/open/closing states and timed closing with occupancy guards; [WL_AGENT.C](https://github.com/id-Software/wolf3d/blob/master/WOLFSRC/WL_AGENT.C) `Cmd_Use` operates facing doors and the elevator switch (`ELEVATORTILE`) to complete the level. `EXITTILE` in movement invokes castle victory, not the normal level-1 elevator exit. [MAPSWL1.H](https://github.com/id-Software/wolf3d/blob/master/WOLFSRC/MAPSWL1.H) contains map-name enum indexes, not geometry.
- The commercial map data was not supplied. Exact original level-1 geometry was neither established nor implemented; do not claim otherwise.

## scores (separate, not an aggregate pass)

- Mechanical: **3/3 observed checks pass** — plan saved/rendered with controls; no observed plan-mode source mutations; zero Discord payload warnings. Typed delegation, cap boundary, intervention and compaction: **unscored / not exercised**.
- Qualitative planning: **1/5** — app recognition improved after attachment, but source correctness and core mechanic fidelity failed. Research efficiency **1/5** — bounded but repetitive and misdirected.
- Implementation, actual doors/exits/stone collision, stranger control rejection and restart survival: **unscored / blocked**, not passes. No valid plan was available to approve, so no implementation was authorized. Approving a knowingly incorrect plan or seeding researched corrections would weaken this smoke test.

## evidence and unresolved issues

Evidence directory (outside the checkout): `C:/Users/simul/AppData/Local/Temp/opencode/teapilot-feedback/bench-runs/2026-10-02-typed-juniors-wolf/` contains `manifest.json`, `discord.json` (m3/m7 plans and controls), `transcript.jsonl`, `telemetry.jsonl`, 30 model-call traces, task/scratch snapshots and unchanged `baseline-tea-wolfenstein.js`. Only this isolated test's conversations were captured.

Main blockers: ask-mode planning never requested `discord.play`, despite the interactive-app task and system advice; no typed delegation was exercised; exploration limits stop research but do not prevent unsupported plans; repeated refused searches persisted. Also document/resolve the driver's `--root` versus per-conversation workspace mismatch for fixture-based tests. No further prompt workarounds attempted.

## extension: authorized plan approval and implementation

**Correction to the preceding interpretation:** planning can inspect attached workspace source without requesting `discord.play`; lack of a planning grant is not itself failure. Delegation is optional: no juniors means those mechanics were unexercised, not failed. Earlier scores and evidence above are retained.

Fresh session `typed-wolf-impl` used the same unchanged baseline, attached with the identical adapted prompt above (canonical URL and ordinary existing-app context only). Main agent reported the pinned-context duplication fix now present; this is a later tree, not an identical-revision repetition. No corrective solution instructions, source symbols, budget/role hints or researched answers were supplied. Actual `m3` **approve** button was clicked as test authorization, not source endorsement.

### observed plan and implementation

- Plan request `1a0ad3f8-f4a3-45c3-9991-5a7cd83fd98a`: **7m 23s, 22 turns / 22 tool calls**, one context compaction at 21,842 tokens (16s). It searched thirteen times and read nine pages, including a Doom E1M1 Hangar walkthrough; its final plan mislabeled Wolf3D level 1 as a north hangar/south corridor/east room approximation. It omitted opening mechanics and made doors static blockers. No source fidelity pass. No plan-mode source writes observed. Controls saved/rendered and approval succeeded.
- Approved implementation request `d17bc955-900a-43d4-a5b4-039fabc07c33`: **15 turns / 14 calls** at cancellation, approximately 7m 30s from approval to restart. Two context compactions (21,697 and 22,436 tokens; ~19s each), task-state reads, one source write, a failed edit followed by exact-text rereads and successful edit. No typed delegation or `request_capabilities` call; `play_test` and `play_start` were already available. No permission prompt required answering.
- Two actual `play_test` runs: 3 actions gave 1 pass/2 failed assertions; 49 actions gave 0 passes/1 failure. Some assertions/probes themselves were wrong (e.g. expect unchanged y after turning and moving; 49 forwards never navigated to exit). Third test was refused because automated testing allowance was exhausted. The model still launched via `play_start`; do not count launch as verification. One live app: `e32df08c7e`, message `m6`.
- Restart was deliberately performed for survival testing near the authorized ~15-minute session limit; it cancelled the still-running request. Telemetry final status is **cancelled**, not a completed implementation report. Total accounted cost for this phase $0.000473382. No extra model request/workaround was made.

### actual code and live gameplay

- Saved output: `implemented-tea-wolfenstein.js` in the second evidence directory. Its `LEVEL` is the baseline layout with just `[8][10]` changed to exit type 3. **There are zero type-2 door tiles**, no open/use button, no sliding/open/closing state, no timers. The comments claim a simplified E1M1 hangar structure without supporting map data. Exact commercial level geometry remains unestablished; this is fabricated descriptive attribution, not an honest successful port.
- `isWall` blocks every tile >=1 while `checkWin` requires the player's current tile to equal 3. From the ordinary spawn, clicked south to row 8 then east toward the exit, reaching **x=9.9, y=8.4, won=false**; further forwards were blocked. This confirms an unreachable win condition, not merely a wrong test probe.
- Stone collision: five backwards clicks left x at **1.2**, blocked by boundary stone; no passage through it. Stone visual remains the original blue glyph, not an added distinct variant. Ray color code also samples with perpendicular distance rather than retaining the actual DDA hit tile, so type-specific rendering is not reliable.
- Stranger click on actual `fwd` changed player x from **1.5 to 1.8**. App declares `participants: everyone`, with no actor restriction. Thus stranger controls are openly permitted; rejection/isolation does not pass (the original single-player app also lacked actor checks).
- Restart preserved x=9.9/y=8.4 and won=false. A subsequent real `back` click worked, moving x to **9.6**. Recovery and post-restart interaction pass; functional correctness still fails.
- No Discord payload warnings. No real user's workspace was modified; all implementation writes were in the simulated conversation's scratch attachment.

### extension scores and evidence

- Mechanical: **4/4 observed checks pass** — actual plan approval, app launch, zero payload warnings, restart preservation plus working control. Door presence, reachable exit completion and stranger rejection **fail**. Stone solidity passes; new stone visual variant fails. Typed junior scopes/caps and paging intervention remain unscored.
- Qualitative: planning **0/5** (Doom/Wolf3D conflation); implementation fulfillment **1/5** (launchable but no doors, broken exit, unsupported geometry); efficiency **1/5** (three compactions across the phase and ~15-minute tiny-app task). No source fidelity pass.
- Second evidence (outside the checkout): `C:/Users/simul/AppData/Local/Temp/opencode/teapilot-feedback/bench-runs/2026-10-02-typed-juniors-wolf-implementation/` — full isolated Discord/transcript/telemetry, 37 traces, source snapshot, plus `typed-wolf-gameplay.txt` containing stranger/stone/exit probes and `typed-wolf-restart.json` containing pre/post recovery state. Captured before stopping; both sessions stopped.
