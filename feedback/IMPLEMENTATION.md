# UX implementation record — 23 September 2026

Implements the four slices in [NEXT_ROUND.md](NEXT_ROUND.md), preserving the original feedback. Local execution, explicit cloud spending, shell approvals, repository boundaries, and independent CLI requests remain the product's defaults.

| Slice | Delivered |
| --- | --- |
| Configuration and readiness | Active profile and selection reason; override names without values; explicit next-command profile; interrupted-first-save explanation; Ollama repair hint; preserved/optional hosted routing; separate consented routing check; personal-profile quick start. |
| Inspection and recovery | Bounded initial inventory, listing and literal search with ignore/protected-path filtering; one repeated-inspection warning; structured escalation evidence; original stop reason and actual fallback eligibility; observed edits/checks and next action. Denied commands are not reported as executed. |
| Web repair | Separate policy/configuration/service failures; optional consented SearXNG setup; connectivity check; no silent unverified answer; search outages stop execution without paid escalation. |
| Presentation | Restrained terminal accents, literal Markdown styling, interactive response streaming, plain redirected output, JSON isolation, and a disableable text activity indicator cleared for answers, approvals, and cancellation. |

## Validation and observations

- Full type checking, all 62 automated tests, and compilation passed on native Windows / Node 24.14.1 and Linux container / Node 22.19.0. Tests cover mock inference, actual file tools, shell denial, repeated inspection, unavailable fallback, protected/linked/ignored paths, search outages, and presentation lifecycle.
- Packed-package installation passed with Git disabled, followed by setup, doctor, ask, and an actual file edit against mock inference. No paid inference was used.
- Real Windows terminal and Linux internal PTY checks exercised invalid menu selection, ordinary keyboard input, hidden test-key input, and Ctrl+C during hidden input. Neither exposed the test key or saved a partial profile. The external Linux PTY bridge could not launch; `scripts/terminal-smoke.sh` exercised a PTY inside the container instead.
- Formatting tests preserve Markdown markers, URLs, inline/fenced/indented code, and chunked text; no-colour/dumb-terminal handling and activity cleanup are covered. Human review of light/dark themes and narrow-terminal appearance remains open.

| Scenario | Feedback baseline | Evidence after changes |
| --- | --- | --- |
| First setup | Successful setup; normal terminal interaction untested | Mock end-to-end setup/package checks and real Windows/Linux keyboard, secret-input, cancellation checks pass. |
| Stale checkout configuration | Saved personal profile could be shadowed | Selection precedence is tested; setup prints the shadowing path and an explicit `--config-dir` command. No silent overwrite. |
| Interrupted setup | No recovery explanation | Test creates an incomplete generation, verifies recovery, and confirms retained active generations are not labelled interrupted. |
| Empty-repository coding | Pong transcript: five inspection approvals, then failed escalation | Mock list/write path needs zero shell approvals. Real Qwen runs below remain incomplete; no gameplay acceptance claim. |
| Failed local coding without fallback | Generic terminal failure | Forced loop yields original reason, disabled-tier explanations, observed edits/checks, and next action. Denial and search failure do not escalate. |
| First web use | Combined environment/permission error | Missing endpoint, policy denial, invalid/unreachable service, and valid JSON are independently tested. Permission denial sends no search query. |

Five exploratory runs used the original Pong request, Qwen 3.5 4B's installed 16,384-token alias, direct local routing, zero monetary budgets, and disposable empty directories. All stopped after one declined shell request and created no game files. The first took about five seconds; the remaining four about one second each. Requested actions included combined Git inspection, reading a directory through PowerShell, `git init`, and `mkdir -p src css`. The last two runs received the new bounded initial inventory. These observations prompted clearer discovery instructions and correction of denied-command reporting.

The harness initially permitted only restricted JS syntax checks; the final run also permitted exact `git init`. It declined other shell requests rather than pretending they were approved by a human. The feedback transcript approved inspection commands, so these are **not matched before/after quality or speed measurements**. No successful live Pong run, browser gameplay check, or reduction in total task time was established. All five incomplete runs are retained in this assessment.

## Remaining acceptance work

- Improve and evaluate the local model's use of file tools on representative coding tasks. New host affordances do not establish model reliability; do not expand shell trust or claim better coding quality to hide this result.
- Integrate the artist's typing-paw frames when supplied. This round uses a small text activity indicator; `--no-motion` or `TEAPILOT_NO_MOTION=1` disables it.
- Human visual review across terminal themes/widths and browser verification of a completed live Pong task remain release checks. Saved live-check timestamps were optional in the brief and are not added; doctor explicitly describes the checks performed now.
