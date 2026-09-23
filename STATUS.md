# Status — 2026-09-22

The native agent host and guided setup are implemented. Explicit `ask`/`code` commands support direct, fully local execution without API keys or routing charges. Hosted routing retains JevRouter's pinned SDK and receipts. Both modes use the same execution policy gate. TeaPilot owns execution, budgets, escalation, and local outcomes.

Coding uses pi 0.87.0's Agent loop and existing read/write/edit/PowerShell/bash tools, the current ecosystem underlying little-coder. It loads project instructions through pi, bounds execution, and carries recent execution context into escalation. Ask shares the bounded loop with no repository tools; optional SearXNG search requires `--web`. Operator is unavailable.

Completed:

- CLI prompt/cwd/configuration, doctor, JSON output, cancellation, and native build.
- Six JevRouter capabilities with replaceable local/economy/strong models and metadata.
- Evidence-based escalation, including real failing mock test commands and explicit uncertainty.
- Per-call durable reservations, request/UTC-day budgets, missing-usage holds, and cross-process locking.
- OpenRouter price filters; reported costs distinguished from configured-rate estimates/reservations.
- Route/expensive-model approvals, guarded file tools, explicit shell approvals, opt-in trusted commands.
- Original JevRouter receipts and execution-only JSONL outcomes; no second routing telemetry format.
- Windows/Linux CI matrix, Docker image, exact native setup instructions.
- Installable npm CLI with bundled JevRouter/runtime dependencies and upstream license; package installation needs no Git or build tools.
- Guided Ollama installation/startup, model selection/downloads, private per-user configuration, repeatable setup, and partial-readiness reporting.
- Styled setup prompts, settings review, recoverable optional search configuration, and profile-owned local SearXNG containers with status/start/stop/remove commands.
- Qwen3.5 4B and 2B presets with fixed context aliases, non-thinking requests, and a conservative sampling temperature. Installed/custom model choices remain available.
- Live doctor checks for streaming, tool continuation, and a verified disposable file edit through the production coding loop.
- Package installation tests in CI; real Ollama release gates; version-tag publication through npm OIDC, disabled until owner configuration is complete.

Validation:

- Windows Node 24: type checking, 39 unit/integration tests, compilation, CLI startup, and packed-package installation outside the repository.
- Linux Node 22.19.0: Docker `npm ci`, the same 39 tests/checks, compiled startup, and packed-package installation.
- Package tests exercise setup, personal-config discovery, doctor, ask, and a real file edit with Git disabled, no API credentials, and zero monetary budgets.
- Both Windows and Linux clients passed streaming, tool continuation, and verified coding edits with Qwen3.5 4B and 2B against an isolated Ollama 0.34.3 Linux/GPU server. Older Qwen3 presets that failed consistent validation were removed.
- Native Windows Ollama runtime and fresh-machine installer UX were not exercised locally. The release workflow additionally validates native Windows/Linux Ollama runtimes; its hosted results remain pending.
- Mock HTTP integration exercises real TypeSafe/OpenRouter JevRouter adapters and pi inference/tool loops; no live paid inference was used.
- GitHub Actions is configured for Windows/Linux × Node 22.19.0/24 and runs on pushes and pull requests. Hosted run results are available in the repository's Actions tab.

Remaining limitations:

- Requires Node >=22.19.0 because current pi does; does not support Node 20.
- No persistent conversations/memory, GUI, desktop operator, images, automatic rollback, or automatic context compaction. Context exhaustion can escalate, but a larger model/context must be configured.
- Uses pi directly, not little-coder's complete small-model extension suite; no claim of equivalent coding quality or benchmark performance.
- No OS sandbox. Approved/trusted shell commands run with the user's privileges; filesystem checks do not defend against concurrent malicious filesystem replacement. Trusting a test/build command trusts its executable project code.
- Hard budget admission relies on conservative configured rates and compliant token limits. Unknown costs remain reserved; provider billing outside those assumptions can only be detected after the fact. Separately operated search costs are not tracked.
- Success means the bounded run completed without a known execution failure; model output is not independently proven correct. Check status is derived from observed test/build-like shell command results.
- Search is snippet-based and opt-in. Setup can connect an existing SearXNG service or manage a local container using an already-running Docker engine. Managed container behavior has mock coverage; live container startup has not been verified in this session because Docker daemon access was unavailable. Local model live checks establish basic compatibility, not broad model quality; no paid-provider validation or quality benchmarking has been performed.
- The npm package is not yet published. The owner must establish package ownership, configure the trusted publisher for `release.yml`, and enable `NPM_PUBLISH_ENABLED` before tagged releases publish.
