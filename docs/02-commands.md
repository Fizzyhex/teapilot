# Commands

For a source checkout, replace `teapilot` with `npm start --`.

## Choose a command

| Command | Use it for |
| --- | --- |
| `ask` | Questions, explanations, and planning; no repository tools |
| `code` | Inspecting, editing, or checking a repository |
| `chat` | A multi-turn planning conversation; no filesystem or shell tools |

```sh
teapilot ask "Explain dependency injection"
teapilot code --cwd path/to/repository "Fix the failing unit tests"
teapilot chat "Help me plan a project"
teapilot code --correction "The previous change missed empty input" "Fix the parser"
teapilot code --json --cwd path/to/repository "Review the code"
```

Use the repository root with `--cwd`. Paths containing spaces work in PowerShell and other supported shells.

## Interactive use

Run `chat` with an optional opening prompt, or start it without one. Type `/exit` or `/quit` to leave; Ctrl+D exits at an empty prompt, and Ctrl+C cancels. Enter inserts a newline and Shift+Enter submits. Type `@` followed by a path prefix and press Tab to complete a file or directory inside `--cwd`.

TeaPilot keeps recent complete turns in memory for the current chat only. It does not automatically remember earlier sessions.

## Web research

Configure `SEARCH_BASE_URL` with a SearXNG JSON endpoint, or use the search setup described in [Get started](01-setup.md). Then add `--web`:

```sh
teapilot ask --web "Research current information and cite sources"
```

Only that request receives search. Search returns bounded snippets and does not fetch arbitrary pages. Noninteractive requests fail if search is unavailable rather than silently answering without it.

## Output and status

Use `--json` when stdout must be machine-readable. Set `NO_COLOR` to disable colour and `--no-motion` (or `TEAPILOT_NO_MOTION=1`) to disable the activity indicator.

- `0` — completed, or `doctor` is healthy
- `1` — configuration or runtime failure
- `2` — blocked or incomplete

Read the status as well as the generated text: text alone does not prove that a requested change completed.

## What `code` can do

Coding begins with a bounded, read-only inventory. Built-in listing and literal search respect `.gitignore`, protected paths, links, generated directories, and result limits. Shell commands still require approval unless explicitly trusted.

If a run stops, TeaPilot reports the stop reason, observed edits, checks, and a suggested next action. Existing edits remain on disk.

For a built JavaScript checkout:

```sh
npm run build
node dist/cli.js ask "prompt"
```

[Back to README](../README.md)
