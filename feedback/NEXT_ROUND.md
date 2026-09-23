# Next development round: a clearer path to useful work

Reviewed both [everyday feedback](FEEDBACK.md) and the [machine setup review](SETUP_UX_REVIEW.md), alongside the current implementation and project docs. This is a proposed development brief, not a record of shipped improvements.

**Priority: make setup trustworthy, routine work less interruptive, and incomplete work recoverable.** Teapilot should stay a small, focused, resourceful agent host: local use without keys, optional cloud services with explicit spending limits, and useful defaults. “Batteries included” should mean helping users reach a working state, without silently adding services or permissions.

## 1. Make the active setup obvious

Setup success must predict what the next command will use.

- Show the selected configuration directory and why it won selection in setup, doctor, and configuration failures. Explain relevant environment overrides without printing credentials. Distinguish configuration location from the repository selected by `--cwd`.
- Prefer personal setup in the quick start; keep checkout-specific configuration an explicit option. If a checkout shadows the profile just saved, explain this and provide the exact `--config-dir` command to use it. Offer alignment without silently overwriting either profile.
- Reuse existing Ollama detection and installed-model selection. When a configured endpoint fails, report that endpoint alongside any detected Ollama runtime and offer repair; do not silently switch providers.
- Detect interrupted saves separately from intentional retained generations. Explain recovery, preserve the last valid settings, and reuse installed models.
- Explain routing in one sentence: “The router chooses a model; the execution model does the work.” Keep direct local setup simple; make Jev optional, preserve an existing routing choice, and verify routing separately with consent for paid checks.
- Doctor should distinguish endpoint discovery, live answers, tool use, coding, and hosted routing. Label checks as passed, failed, or not tested. A saved live-check timestamp describes a previous check of those settings, not proof of current readiness.
- End setup with one platform-appropriate command that uses the configuration just verified. Fix the unfinished `--web` sentence in the README as part of this documentation pass.

**Acceptance:** From both a checkout with stale settings and the user home directory, users can identify the active configuration and run the verified model. Interrupted setup can recover without unnecessary downloads. Manually exercise keyboard input, hidden credentials, and cancellation on Windows and Linux; the setup review did not validate normal terminal interaction.

## 2. Reduce inspection friction and explain incomplete work

The Pong transcript shows repeated directory inspection and five shell approvals before an unhelpful terminal message. It does **not** establish the original failure reason. The host can currently replace failure detail with “no affordable, available escalation model”; fixing that message alone will not fix the coding loop.

- Add bounded repository listing and text search through the existing file-access policy. Return paths, line references where applicable, and explicit truncation; respect repository boundaries and protected files. Prefer these tools for inspection instead of asking users to approve shell-based browsing.
- Keep approvals for arbitrary shell execution. Make prompts concise but retain the exact command, working directory, and consequences. Do not solve approval fatigue by broadly trusting PowerShell or bash.
- Detect repeated inspection without new useful evidence, including superficial variations where reliably identifiable. Give the agent one bounded opportunity to change approach, within existing limits; then stop or escalate with the observed reason. An empty repository is a valid starting point, not a reason to keep listing it.
- On failure, show the original stop reason separately from why fallback is unavailable: disabled, unreachable, unsupported, or over budget. Derive these from actual eligibility checks rather than guessing.
- End incomplete coding runs with observed changes, checks passed/failed/not run, and one relevant next action. Preserve failure status even when the model produces reassuring text. State that edits remain when applicable; do not imply rollback or automatic resume.
- Carry structured failure, edit, and check evidence into an eligible escalation. Keep recovery useful even when only a local model is enabled; adding a paid model must not be the default remedy.

**Acceptance:** Reproduce the empty-repository Pong task and inspect whether it reaches a working, checked result with fewer inspection approvals. Also force tool failure, repeated calls, denied approval, and unavailable fallback: each must yield an accurate incomplete result and actionable explanation without extra spending or permission bypasses. Model quality and host recovery should be assessed separately.

## 3. Turn missing web setup into a guided repair

- Replace the combined `SEARCH_BASE_URL`/permission error with separate diagnoses: no search endpoint, search disallowed by policy, or configured service unavailable.
- Add an optional search section to setup for an existing trusted SearXNG endpoint, with a connectivity check. Explain that search sends queries to that service and any service costs sit outside inference accounting. Keep `--web` explicit.
- On failure, show the active configuration and a precise repair command or documentation link. If policy blocks search, explain the required policy change rather than treating it as a connectivity issue.
- Do not silently answer a requested web-research task without search. An interactive user may choose an explicitly unverified answer; noninteractive use should return an actionable failure.
- Use `teapilot ask --web "..."` consistently in examples. Automatic search-service installation is outside this round.

**Acceptance:** Missing endpoint, denied permission, unreachable service, and successful search produce distinct, useful outcomes. No repair silently enables network access or changes policy.

## 4. Give the terminal a quiet visual hierarchy

- Use restrained tea-inspired accents, readable greys, and bold labels to distinguish progress, approvals, answers, and results. Text must convey status without relying on colour or symbols.
- Style Markdown while retaining its literal markers, code indentation, URLs, and copyable content. Keep answers visually separate from status updates; narrow terminals should remain readable.
- Honour `NO_COLOR` and terminal capabilities. Redirected output stays plain and stable; `--json` remains machine-readable and free of decorative output.
- Typing as paws [artist is working on it]: a small TTY-only activity indicator, cleared on completion, cancellation, or approval. It must not imply tokens are arriving when the model is stalled, alter copied answers, or run in logs. Ship only with an easy way to disable motion.

**Acceptance:** Check light/dark terminals, narrow widths, no-colour mode, redirected output, JSON, streamed Markdown, and cancellation. Styling must improve scanning without obscuring content.

## Delivery and evidence

Implement in order: **configuration and diagnostics → inspection and recovery → web repair → presentation**. Each slice should include its error states and updated user-facing examples. Keep the original feedback files as evidence.

Record a small before/after set covering first setup, stale checkout configuration, interrupted setup, empty-repository coding, failed coding without fallback, and first web use. Track time to a useful result, unnecessary inspection approvals, repeated calls, and whether users can identify the next action. Count incomplete and abandoned runs; do not claim improved coding quality from compatibility probes alone.

This aligns with the [agent efficiency review](../AGENT_EFFICIENCY_REVIEW.md)'s bounded search, explicit outcomes, and structured handoff recommendations. Broader routing experiments, background workers, persistent memory, and extension expansion are outside this round. A larger agent architecture is not needed to address these UX problems.
