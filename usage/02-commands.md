# Usage

```sh
teapilot code --cwd "path/to/repository" "Fix the failing unit tests"
teapilot ask "Explain dependency injection"
teapilot ask "Help plan the next three workdays"
teapilot code --correction "The previous change missed empty input" "Fix the parser"
teapilot code --json --cwd "path/to/repository" "Review the code"
```

For a source checkout, replace `teapilot` with `npm start --`.

## Request behavior

The same argument syntax works in PowerShell, including paths with spaces. `teapilot` without arguments asks for one prompt and, in direct mode, a workload. Each invocation is one request, not a persistent conversation. Corrections are included in the prompt and noted in outcomes; there is no personal memory or automatic retrieval of previous sessions.

`--cwd` is the filesystem boundary, so choose the repository root. To run compiled JavaScript: `npm run build`, then `node dist/cli.js ask "prompt"`.

Coding has built-in repository listing and literal text search, so ordinary inspection needs no shell approval. These tools respect `.gitignore` and protected paths, skip links and generated directories, and report bounded/truncated results. Arbitrary shell commands still require approval unless explicitly trusted. Repeated inspection gets one prompt to change approach before stopping; limits still apply.

Incomplete runs report the original stop reason, fallback eligibility, observed file edits, check status, and a next action. Shell changes may extend beyond the recorded file edits. Existing edits remain on disk. Escalation receives structured, bounded execution evidence; it is not a new session or an automatic rollback.

## Workload and routing

In direct mode, `ask` has no repository tools; `code` selects the coding workload. A bare prompt asks which workload to use in an interactive terminal and is rejected noninteractively. Enabled tiers are considered local, economy, then strong; escalation retains the workload and all approval/budget checks. Fresh local setup enables only local inference and works with zero monetary budgets. Hosted mode retains automatic JevRouter selection; explicit commands constrain it to the requested workload.

## Exit codes

Exit codes: `0` completed (or healthy doctor), `1` configuration/runtime failure, `2` blocked or incomplete. Inspect the status as well as the response: generated text alone is not proof of successful execution.

## Web research

Set `SEARCH_BASE_URL` to a SearXNG instance you operate/trust with JSON responses enabled, then run:

```sh
teapilot ask --web "Research current information and cite sources"
```

Alternatively, run `teapilot setup` with the intended `--config-dir`, choose Reconfigure, and opt into search setup. It asks before allowing `web.search` and sending a connectivity query. The wizard does not install a search service. Preserve the existing endpoint by declining this optional step.

Web requests check policy, endpoint configuration, and connectivity before model execution. Errors distinguish missing configuration, denied permission, and an unavailable/incompatible service, and identify the active profile. Noninteractive requests fail rather than silently answer without search; interactive requests may explicitly choose an answer labelled unverified. Connectivity checks send a fixed test query to your configured service.

Only `--web` exposes search to the selected agent; normal ask has no filesystem or shell tools. Search uses the [SearXNG JSON Search API](https://docs.searxng.org/dev/search_api.html), returns at most five bounded snippets, and does not fetch arbitrary pages. It has no built-in paid search subscription. Any costs from your separately operated search service are outside the inference ledger. Without search, ask discloses that it cannot verify current information.

[Back to README](../README.md)
