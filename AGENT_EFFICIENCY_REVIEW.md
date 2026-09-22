# Teapilot agent efficiency review

Assessment date: 2026-09-23. Based on the current working tree, including existing uncommitted editor integration changes. This is an architectural assessment, not measured performance results. No paid inference or implementation changes were made for this review.

Source: [Why yet another agent?](https://docs.google.com/document/d/1G61uUB0FifUnmmrPzFQojZ3KpczYKmXGpgEXDJ2l_Zg/edit?tab=t.0), read through its text export.

**Decision: retain the small pi host, make task evidence explicit, improve deterministic retrieval, and route according to measured cost and time to a verified result.** Treat TypeSafe context selection, recursive calls, and background agents as experiments with budgets and baselines.

Fastest and cheapest are different objectives. Offer cost-first and latency-first policies, both subject to a quality floor and the same permissions. Local-only is a separate data-egress constraint. Do not claim a universally optimal model or host without workload and hardware measurements.

## What the document gets right, and where to challenge it

| Proposal | Assessment for teapilot | Decision |
| --- | --- | --- |
| Explicit, query-relevant state | Strong fit: bounded raw handoffs and recency-only history currently lose useful evidence | Adopt incrementally |
| Routing can lose to a cached strong model | Correct possibility; the document's universal claim is unsupported | Measure whole-task economics |
| Rebuild context dynamically | Can reduce irrelevant input but invalidate useful cache prefixes and omit dependencies | Stable prefix, selective evidence, rebuild at boundaries |
| Huge tool catalog with lazy schemas | Useful when there is a large catalog; teapilot currently exposes four coding tools plus escalation and optional web search | Defer catalog infrastructure |
| Cheap subagents | Useful for bounded, independently verifiable work; coordination and rereads can erase savings | One optional read-only retrieval worker first |
| Conditional instructions | Relevant to nested repository instructions | Deterministic scope loading; never let relevance scoring remove mandatory rules |
| Background review and explanations | Can share retrieval artifacts, but still consume inference and compete for resources | Opt-in, snapshot-bound, cancellable jobs |
| Recursive language models | Interesting for very large corpora; not established as the fastest ordinary coding loop | Research track |
| Security-aware routing | Correct to constrain egress; nationality is not evidence of provider behavior | Explicit provider/data policy, enforced before transmission |
| Batteries at near-zero cost | Catalog storage may be cheap; auth, maintenance, discovery, mistakes, and model calls are not | Add integrations only for measured demand |

The simple while-loop observation does not make the surrounding host trivial. Teapilot's budget reservations, cancellation, editing boundaries, model compatibility, and editor checkpoints are substantive product work. Preserve those investments.

## Current implementation and its consequences

1. **Routing is already optional.** `src/host.ts` supports direct selection and hosted JevRouter. Direct selection chooses the first eligible candidate, not an empirically optimal model. Hosted routing adds calls even after escalation has narrowed selection to a single tier. Skip a semantic decision when policy leaves one eligible choice; preserve all execution checks and audit records. An enabled local endpoint is probed before selection, with a three-second timeout; cache readiness briefly where appropriate and measure cold versus warm behavior.

2. **Strong-first behavior is constrained.** `src/routing/capabilities.ts` excludes the strong tier initially when `automaticEconomy` is enabled. Cheap-first is a policy preference, not a proven economy. Permit a configured or measured strong-first route for difficult workloads, respecting existing cloud consent and spend limits.

3. **Search is an unusually promising target.** `src/agents/coder.ts` exposes read, write, edit, and shell. There is no dedicated repository search tool. `src/execution/policy.ts` automatically permits a short Git allowlist; ordinary search shell commands require approval unless explicitly trusted. Add a bounded `repo_search` tool with a validated query schema, scoped paths, ignored/protected-file filtering, result limits, line references, and explicit truncation. Use a direct process API or library, never interpolated shell text. This can remove approval delays and reduce model turns without another model call.

4. **Escalation is bounded but lossy.** `src/agents/run.ts` takes the last eight messages, serializes them, then keeps the final 10,000 characters. It may cut across structured records and omit the original failure, rejected approach, or edit provenance. The next attempt gets the current request, selected user/assistant history, and that handoff, while edits remain on disk. Replace this with structured evidence and retrievable artifacts.

5. **Editor history is newer than the status document.** `src/integration/events.ts` retains complete recent user/assistant pairs within a character cap. It does not retain a semantic task ledger or complete tool history across requests. Avoid designing from the README's statement that requests have no conversation support alone.

6. **Cache-aware economics are absent.** `src/inference/providers.ts` assigns cache read/write the ordinary input rate in fallback accounting. Provider-reported costs take precedence when available. This does not prove that caching is disabled; it means fallback estimates and route decisions cannot accurately value different cache behavior. Add provider-specific usage normalization and distinguish reported invoice cost, estimates, and held reservations.

7. **Input admission is deliberately conservative.** The provider guard compares serialized UTF-8 bytes plus framing allowance against the configured token ceiling. It can reject contexts that would fit under a validated tokenizer. Introduce provider/model-aware counting only with a conservative fallback and tests; do not casually replace the safety bound with characters divided by four. Per-call budget reservation currently uses full configured context and output ceilings, so short affordable requests may also be rejected. Tighten reservations only against a defensible upper bound on billable input, output, and applicable cache-write premiums.

8. **Concurrency requires architectural work.** The agent uses sequential tool execution; `lockState` permits one host request per state directory, and the editor service permits one active request. Do not remove these locks to obtain parallelism: shared spending needs atomic reservations and settlement. First add bounded read-only batching within one request, with deterministic result ordering and cancellation. Separate budget transactions from workspace write coordination before adding independent workers.

9. **Completion is not correctness.** `runAttempt` can report success after a normal textual completion with no known tool failure and no failed observed check. Tests are not required for success. Keep a distinct execution-completed status and a task-specific acceptance outcome. The repository's compatibility tests and smoke tests cannot establish model quality or routing savings.

10. **Editor review has potential startup cost.** `Review.start()` enumerates and captures workspace files before execution. Profile it on large repositories. Reuse snapshots only when content identity is established; preserve before-images for arbitrary approved shell mutations. Lazy capture alone cannot safely cover such commands.

## Correct the economics before building a smarter router

Using only the document's historical illustrative prices:

```
stay strong        = 25Y + 5Z
strong/cheap/strong = 3X + 20Y + 8Z
extra switching cost = 3X - 5Y + 3Z
```

Under those assumptions switching is cheaper only when `5Y > 3(X + Z)`. For its X/Y/Z example, costs are 4.15 versus 6.19 in the example's units, so its arithmetic is broadly right. The problem is generalization: these formulas omit explicit cache-read/write accounting, router overhead, latency, and differences in task success. They describe an excursion from a strong model and back, whereas teapilot escalates one way with a bounded handoff.

For a cheap attempt followed by a strong fallback:

```
E[cost] = Croute + Ccheap + (1 - pcheap) * (Chandoff + Cstrong_after_failure)
E[time] = Troute + Tcheap + (1 - pcheap) * (Thandoff + Tstrong_after_failure)
```

Compare against strong-first cost, latency, and success, not just its token prices. Here `pcheap` must mean independently accepted completion; undetected incorrect answers need a separate error estimate. Failure can leave valuable edits or costly damage, so measure fallback after failure instead of assuming it equals a fresh strong attempt.

Illustrative only: if a cheap attempt costs $0.03, routing $0.005, and fallback plus handoff $0.32, while strong-first costs $0.30, cheap-first wins on expected spend when its acceptance probability exceeds about 17.2%. If the cheap attempt takes 45 seconds and a successful fallback takes 30 seconds, cheap-first is still slower than a 30-second strong-first run even at 100% cheap success. There is no universal cheapest-and-fastest route.

Measure total spend divided by accepted tasks across the evaluation cohort, including failed attempts. Report success rate alongside latency distributions; timeouts and abandoned runs must not disappear from the denominator. Local inference has zero API charge but still consumes time, power, memory, and machine capacity. Show those separately rather than inventing a dollar value for user time.

Provider caching rewards reusable prefixes. Changing early tool definitions, instructions, or context may lose the very savings dynamic filtering hopes to create. Cache writes can also have different prices. See [Anthropic's caching mechanics](https://platform.claude.com/docs/en/build-with-claude/prompt-caching) and [OpenRouter's cache usage and provider affinity guidance](https://openrouter.ai/docs/guides/best-practices/prompt-caching). Verify behavior through teapilot's actual compatibility adapter; support at the upstream API does not establish support in the current host.

## Proposed context design

Use a stable instruction/tool prefix and an explicit task record, plus a small selection of source evidence:

```
TaskState
  objective and acceptance criteria
  applicable instructions and scope
  workspace snapshot identity
  changed files and patch references
  checks: command, cwd, exit code, output artifact, snapshot
  observations with file/hash/range provenance
  attempted approaches and observed failure
  unresolved questions and next action
  remaining budgets and permitted providers
```

Construct this primarily from tool events and host state. Let models propose summaries, but label them as generated claims. Store tool outputs as bounded, private artifacts with retrieval handles, expiry, and source classification. Summaries need a route back to the original evidence. Do not require unavailable private model reasoning to reconstruct state.

Initially select evidence using paths, symbols, recent diffs, failing-test references, and bounded text search. Keep the core protocol stable within an attempt. At escalation or a phase change, create a fresh evidence bundle from the same ledger. Rebuild sooner only for measured context pressure or relevance loss. Preserve tool-call/result pairing if transforming live conversation messages.

Instruction scope and data permission are hard constraints, not relevance scores. A file edit invalidates evidence tied to its previous hash. Test results are valid only for their tested snapshot. Cheap workers receive only allowed evidence; source-derived summaries inherit its egress restrictions. Apply those restrictions to the router, search, logs, and background jobs as well as the main model. Today hosted routing receives `basePrompt`, which can include editor attachments, before an execution model is chosen; filtering only the selected inference provider would be too late.

Use TypeSafe selectively to rank an ambiguous evidence set or choose among genuinely competitive routes. A classifier on every chunk every turn can add more cost and delay than it removes. Batch uncertain choices and retain a deterministic fallback. Typed results make integration easier; they do not prove relevance or correctness.

## Hard questions and decisions

| Question | Working decision / required evidence |
| --- | --- |
| What does fastest mean? | Time to accepted change, plus p50/p95 and approval wait; first-token latency is secondary |
| What quality loss is acceptable? | No presumed loss; agree a non-inferiority margin and inspect critical failures separately |
| Does cheap-first actually save money on this hardware? | Compare direct local, direct economy, direct strong, and escalation on identical tasks |
| Is JevRouter paying for itself? | Its reduction in failed work must exceed route cost and latency versus a deterministic baseline |
| Will filtering preserve the one line that matters? | Evaluate necessary-evidence recall, rereads, wrong edits, and acceptance, not compression ratio |
| Why should a strong model wait for a weak model to fail? | It should not when measured task cohorts favor strong-first |
| Can small models report their own limits reliably? | Do not rely on self-confidence alone; use checks, progress, repeated failures, and calibrated outcomes |
| Will more workers make this laptop faster? | Measure device contention; two local generations may make both slower |
| How do we detect stale background advice? | Every job/result carries snapshot identity; discard or revalidate on changes |
| Is a second-model review worth its bill? | Measure extra defects found per dollar and minute, accounting for false alarms and rework |
| Can a provider receive the selected data? | Explicit allowlist/data policy before any request; never a guess based on nationality |
| Are recursive tasks bounded? | Parent-enforced depth, calls, spend, deadline, cancellation, and deduplication before enabling them |

## Build and evaluate in this order

1. **Establish the baseline.** Add per-stage timings for route, queue, prefill/first token, generation, tool, approval, handoff, and validation where observable. Record cold/warm local state, model/provider identity, token/cache usage, estimate basis, and independent acceptance. Existing event timestamps and usage records are a useful start, but not complete attribution.
2. **Improve retrieval and handoffs.** Add typed bounded search, host-generated task state, artifact references, and explicit truncation. Add modest read batching only for independent reads against a stable snapshot. Keep writes serialized.
3. **Make cache and admission behavior accurate.** Validate cache accounting and prefix reuse; calibrate input bounds. Skip redundant routing and irrelevant readiness probes. Treat admission improvements as fewer false rejections, not automatic invoice savings.
4. **Evaluate initial model selection.** Add cost-first/latency-first choices and permitted strong-first selection. Route by task cohort and observed outcomes with a conservative fallback; do not introduce online reinforcement learning before sufficient data exists.
5. **Trial one retrieval worker.** Give it a bounded question, read-only scope, budget, deadline, and required file/range evidence. Compare with deterministic search and the main model doing the same work. Run concurrently only if it shortens the critical path without unacceptable resource contention.
6. **Trial background review or deeper context selection.** Reuse source artifacts, not assumed cross-model KV state. Trigger on meaningful changes, cancel stale work, deduplicate by task and snapshot, and give it an explicit optional budget. Expand only if the marginal benefit is measured.

Suggested initial evaluation: 60 representative tasks split across simple edits, failing tests, multi-file changes, repository questions, general questions/planning, and web research. Use task-appropriate acceptance checks and blinded human review where necessary. Include nested instructions, missing evidence, context pressure, and failed-attempt recovery. Use isolated workspaces, pinned inputs/configuration, and matched cold/warm conditions; repeat runs to expose variance. Keep a held-out subset for evaluating routing rules. This is a starting sample, not statistical proof.

Compare baseline and each change separately before combining them. Track acceptance, total cost per accepted task, p50/p95 time, failed-run cost/time, unnecessary rereads, context admission failures, approval time, and cache effectiveness. For coding, tie checks to the final patch and inspect regressions; for research, verify cited evidence. A faster agent that quietly skips validation has not improved.

Suggested experiment gate, to be agreed rather than claimed: a meaningful improvement such as 20% lower cost or completion time, no material regression in the other metric, and acceptance within a predefined quality margin. Report uncertainty and critical failures even when averages improve. Keep a cheaper and a faster configuration if neither dominates.

## Claims not established by the linked material

- The document's Microsoft FastContext link returned 404 during this review. Its quoted search-turn/token percentages remain unverified and should not be used to forecast teapilot savings.
- [RTK](https://github.com/rtk-ai/rtk) advertises tool-output token reductions. That is a reason to test representative output transformations, not evidence of equivalent end-to-end cost reduction or retained coding quality.
- The linked [recursive language model research](https://alexzhang13.github.io/blog/2025/rlm/) demonstrates promising large-context experiments, but also describes speed and runtime/cost-control limitations in that implementation. It does not establish a faster coding host.
- The document provides no calibrated TypeSafe relevance accuracy, decision latency, or complete-system economics for teapilot. Evaluate those directly before making TypeSafe mandatory on the critical path.

The next implementation milestone should therefore be **measured task outcomes, bounded repository search, and structured escalation state**. These support later context selection and routing experiments while addressing concrete gaps in the current host.
