# Usage

```sh
teapilot code --cwd "path/to/repository" "Fix the failing unit tests"
teapilot ask "Explain dependency injection"
teapilot chat ["Help me plan a project"]
teapilot ask "Help plan the next three workdays"
teapilot code --correction "The previous change missed empty input" "Fix the parser"
teapilot code --json --cwd "path/to/repository" "Review the code"
```

For a source checkout, replace `teapilot` with `npm start --`.

## Request behavior

The same argument syntax works in PowerShell, including paths with spaces. `teapilot` without arguments asks for one prompt and, in direct mode, a workload. `ask` and `code` handle one request. `chat` always prompts for another turn, including when an opening prompt is supplied. Corrections are included in the prompt and noted in outcomes; there is no personal memory or automatic retrieval of previous sessions.

`--cwd` is the filesystem boundary, so choose the repository root. To run compiled JavaScript: `npm run build`, then `node dist/cli.js ask "prompt"`.

Coding starts with a bounded read-only file inventory and has built-in repository listing and literal text search, so ordinary inspection needs no shell approval. These tools respect `.gitignore` and protected paths, skip links and generated directories, and report bounded/truncated results. Arbitrary shell commands still require approval unless explicitly trusted. Repeated inspection gets one prompt to change approach before stopping; limits still apply.

Incomplete runs report the original stop reason, fallback eligibility, observed file edits, check status, and a next action. Shell changes may extend beyond the recorded file edits. Existing edits remain on disk. Escalation receives structured, bounded execution evidence; it is not a new session or an automatic rollback.

## Interactive chat and prompts

Run `teapilot chat` with an optional opening prompt or `--prompt`. It uses the `ask` workload in both direct and hosted routing, with optional `--web`, and no filesystem or shell tools. Recent complete turns are carried forward within the configured prompt limit; older turns are omitted when needed. History is held in memory for this session only. Each message has its own request budget, while the daily spending limit remains shared. Incomplete responses remain visible and you can continue; the session exits with code 2 if any turn was incomplete.

Type `/exit` or `/quit` to end chat, Ctrl+D at an empty prompt to leave, or Ctrl+C to cancel. Chat requires an interactive terminal and rejects `--json` rather than silently becoming a one-shot request.

When entering an interactive prompt for `ask`, `code`, or `chat`, Enter inserts a newline and Shift+Enter submits. The editor enables the [Kitty keyboard protocol](https://sw.kovidgoyal.net/kitty/keyboard-protocol/) and also recognises the xterm modified-Enter sequence. Terminals that do not distinguish Shift+Enter from Enter can use Alt+Enter or bind Shift+Enter to `ESC [ 13 ; 2 u`. Setup questions and approvals still use Enter.

Type `@` followed by a path prefix and press Tab. A unique file or directory completes automatically; multiple matches appear below the prompt so you can narrow the prefix. Directories end in `/`; paths with spaces are quoted. Completion is relative to `--cwd` (the launch directory by default), stays inside it, and skips symlinks. It inserts a path only, without automatically reading or attaching file contents.

## Workload and routing

In direct mode, `ask` has no repository tools; `code` selects the coding workload. A bare prompt asks which workload to use in an interactive terminal and is rejected noninteractively. Enabled tiers are considered local, economy, then strong; escalation retains the workload and all approval/budget checks. Fresh local setup enables only local inference and works with zero monetary budgets. Hosted mode retains automatic JevRouter selection; explicit commands constrain it to the requested workload.

## Exit codes

Interactive terminals stream responses with restrained colour and literal Markdown styling: markers, URLs, and code indentation remain copyable. Progress and results use stderr; `--json` keeps stdout machine-readable, and redirected answers remain plain. Use `NO_COLOR` to disable colours, and `--no-motion` or `TEAPILOT_NO_MOTION=1` to disable the small activity indicator. The indicator clears for streamed answers, approvals, completion, and cancellation.

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
