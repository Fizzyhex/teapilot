# Commands

For a source checkout, replace `teapilot` with `npm start --`.

## Choose a command

| Command | Use it for |
| --- | --- |
| `ask` | Focused questions, research, and planning; starts without repository tools |
| `code` | Repository work; starts with configured repository access in a single repository, read-only elsewhere |
| `chat` | Exploratory dialogue; starts without repository tools |

```sh
teapilot ask "Explain dependency injection"
teapilot code --cwd path/to/repository "Fix the failing unit tests"
teapilot chat "Help me plan a project"
teapilot code --correction "The previous change missed empty input" "Fix the parser"
teapilot code --json --cwd path/to/repository "Review the code"
```

Use the repository root with `--cwd`. Paths containing spaces work in PowerShell and other supported shells. Code grants read, write and shell up front only when the directory is inside one Git work tree; in a plain folder or a folder holding two or more repositories it starts with repository read, and asks, naming the root, before the first write or shell command.

## Interactive use

Ask, Chat, and Code share one session interface and differ only in their starting mode and default access. The opening prompt is optional: when supplied it runs immediately, and the composer remains available either way. Use `--once` for one turn; `--json` and noninteractive input are automatically one-shot. Type `/exit` or `/quit` to leave; Ctrl+D exits at an empty prompt, and Ctrl+C cancels.

For a single request without a session, omit the command: `teapilot --prompt "..."` (or `teapilot "..."`) runs once and exits. With direct routing in a terminal, TeaPilot first asks whether the request is a question or code work.

Session commands preserve spending and grants unless stated otherwise:

- `/mode chat|ask|code` changes the visible mode and keeps history. Entering Code requests its configured repository defaults.
- `/tier auto|fast|normal|reasoning|deep` sets a profile preference.
- `/new` clears task history and the capable-model lock while retaining grants and spending.
- `/cd <path>` moves the session to another directory (relative to the current root, or absolute) and keeps history, tier and spending. Write and shell access never follow: the next write or shell command asks for the new root. Read follows only in Code mode. `/cd` alone shows the root and access.
- `/btw <question>` asks a side question about the conversation without adding it to history. It can read, search and send files, but not make changes.
- `/plan <idea>` asks for a proposal to discuss, and nothing is changed until you say "go ahead".
- `/permissions` displays current grants; `/revoke <permission>` removes one. Revoking repository read also removes write and shell.
- `/teachat on|off` turns teachat on or off: while you are idle, agents chat about their finished work in a local room. Any key stops it. `/teachat` chats now, `/teachat read <channel>` shows a channel, and `/teachat who` lists the agents.

TeaPilot keeps bounded complete turns, access grants, and model stickiness in memory for the current session only. Each session also has a scratchpad folder, outside your project, for the agent's helper scripts and notes and for the full copy of long command output; `/new` and leaving the session clear it (`TEAPILOT_SCRATCHPAD=off` turns it off). When a session nears the model's context limit, earlier context is summarised automatically, and the full transcript stays in the scratchpad for the agent to look things up (`TEAPILOT_COMPACTION=off` turns this off).

## Web research

Configure `SEARCH_BASE_URL` with a SearXNG JSON endpoint, or use the search setup described in [Get started](01-setup.md). Then add `--web`:

```sh
teapilot ask --web "Research current information and cite sources"
```

Only that request receives search. Teapilot can open pages from the results as bounded text; local and private network addresses are never read. Noninteractive requests fail if search is unavailable rather than silently answering without it.

## Discord

Optional and separate from `teapilot setup`: `teapilot discord setup|start|status|remove` lets allowlisted Discord users run sessions on this computer while `teapilot discord start` is open. See [Discord](04-discord.md).

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
node packages/teapilot/dist/cli.js ask "prompt"
```

[Back to README](../README.md)
