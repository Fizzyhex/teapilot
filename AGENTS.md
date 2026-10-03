This file is for programming agents.

## Co-Authoring Commits

**NEVER** co-author/co-sign commits with anything but `virtual paws :3`, or teapilot. If that's not available - leave co-authoring blank.

## Line endings

All text files use LF, enforced by `.gitattributes`. Scripts that rewrite files (Python in text mode on Windows, some editors) can write CRLF; git converts it back when staging, but check that `git diff --stat` only counts the lines you meant to change.

## Editing `/docs` and `README`

These files are intended to help users understand Teapilot usage. They are not intended to be in-depth feature requests or technical breakdown, and all writing should be focused on avoiding information overload. Do not append to documentation unless something is factually out of date, or you have been asked.

## Testing teapilot as a user

`packages/teapilot/scripts/agent-terminal.mjs` (`npm run term --` from the repository root) runs teapilot in a real terminal in the background, so you can use it the way a person does, one command at a time. Everything after `--` goes to teapilot unchanged.

```sh
node packages/teapilot/scripts/agent-terminal.mjs start --name t -- code --cwd path/to/repo "fix the failing test"
node packages/teapilot/scripts/agent-terminal.mjs wait t --for "^Result: " --timeout 300          # a turn has finished
node packages/teapilot/scripts/agent-terminal.mjs send t "/mode ask" --submit                     # type into the composer
node packages/teapilot/scripts/agent-terminal.mjs wait t --for "Approve this action"              # an approval is waiting
node packages/teapilot/scripts/agent-terminal.mjs send t "yes" --enter                            # answer it, as a user would
node packages/teapilot/scripts/agent-terminal.mjs screen t                                        # what is on screen now
node packages/teapilot/scripts/agent-terminal.mjs stop t
```

- The composer sends with `--submit` (Alt+Enter); plain Enter only adds a line there. Questions such as approvals take `--enter`.
- `wait` exits 0 on a match, 3 if teapilot exited first, and 124 on timeout. `--for` only sees output since your last `send`/`key`.
- It uses the real configuration and real models, so requests can spend money. Pass `--config-dir` after `--` to use a different profile.
- Teapilot prefers configuration in the directory it is launched from, and `packages/teapilot` counts as one (`config/models.example.json`). The driver therefore launches from the home directory so the user's personal profile applies. Give teapilot its repository with `--cwd` after `--`; don't point the driver's own `--cwd` at this checkout.
- You have the same permissions as a user: read each approval on screen before answering it, and answer `no` unless the action is part of your task.
- Always `stop` sessions you start. Run `node packages/teapilot/scripts/agent-terminal.mjs --help` for keys and other commands.

## Testing teapilot on Discord

`packages/teapilot/scripts/agent-discord.mjs` (`npm run discord-sim --` from the repository root) runs `teapilot discord start` against a simulated Discord, so you can use Discord features, including `discord.play` apps, without Discord. Only discord.js is replaced: routing, conversations, models and apps run for real. Everything teapilot sends is checked the way discord.js and Discord would check it, and anything Discord would reject shows up as a `⚠` line.

```sh
node packages/teapilot/scripts/agent-discord.mjs start --name d                      # add --root path/to/repo for repository work
node packages/teapilot/scripts/agent-discord.mjs say d "make a tic-tac-toe game for me and @user"
node packages/teapilot/scripts/agent-discord.mjs say d "rotate this" --attach samples/tree.png       # attach files, as a person would
node packages/teapilot/scripts/agent-discord.mjs wait d --for "Result: " --timeout 300  # a turn has finished
node packages/teapilot/scripts/agent-discord.mjs click d m4 c0 --as user               # press a button on message m4
node packages/teapilot/scripts/agent-discord.mjs click d m4 c1 --as stranger           # someone who is not playing
node packages/teapilot/scripts/agent-discord.mjs app d <id>                            # an app's state, recent actions and source
node packages/teapilot/scripts/agent-discord.mjs advance d 30s                         # move timers forward
node packages/teapilot/scripts/agent-discord.mjs restart d                             # apps must survive this
node packages/teapilot/scripts/agent-discord.mjs stop d
```

- People are `op` (an operator), `user` (whitelisted) and `stranger` (neither); `--as` defaults to `op`. Channels are `dm-<person>` (the default), `channel`, and `thread-N` once teapilot opens one.
- `select`, `submit --field id=value` and `approve [--deny]` cover menus, forms and approvals; `screen` shows a channel; `log` shows teapilot's operator log. Run it with `--help` for the rest.
- Files teapilot sends, and the images apps show, appear as `📎 name → path` lines; open the path to check the file itself. They are deleted with the session, so look before `stop`.
- It uses the real configuration and models, so turns can spend money; `--config-dir` picks another profile. Access lists and apps live in a scratch directory, never the profile's.
- `start --frozen` stops the clock, so timers fire only when `advance` reaches them; use it for games that tick.
- Only operators can answer approvals, as on Discord: read each one, and deny it unless the action is part of your task.
- Always `stop` sessions you start.

## Reading logs

To find out what a real request did, read the state directory: `~/.teapilot`, or `TEAPILOT_STATE_DIR` when set. Start from telemetry, then open the transcript.

- `outcomes.jsonl`: one JSON event per line, keyed by `requestId`. Take the last `request_start`, then read that request's `attempt_end` (capability, `reason`, `turns`, `toolCalls`) and `request_end` (`success`, `status`). `teachat-*` request ids are background chatter, not user requests.
- `workspaces/<id>/.scratch/sessions/<id>.jsonl`: the conversation's full transcript as a pi session: every message, tool call and result, and host notice, with `teapilot.attempt` entries naming each request and tier. This shows what the model actually saw and did.
- `discord-history/<key>.json`: the turns a Discord conversation replays to the model on its next message.
- `.jevrouter/decisions/<id>.json`: why the router picked a capability (`decisionId` in telemetry).
- `spend.jsonl`: budget reservations and charges.

The files are large and grow without limit: read their tails, never the whole file. They hold real conversations: quote only what the task needs, and never edit or delete them to tidy up a result.

## User-Facing Text

teapilot uses a concise, casual lower-case style for it's user-facing text. do so when whenever it doesn't have a tangible impact on usability.

## Agent-Facing Text (System & Tools)

teapilot often uses a concise, casual lower-case style for it's agent-facing text. this doesn't apply to you, it applies to `teapilot`. but for teapilot & its interfaces - follow those rules when whenever it doesn't have a tangible impact on usability - such as malforming code or breaking case-sensitive data.

## Contextual First

System prompts or tool descriptioons that aims to fix specific problems (such as logical errors made by teapilot) are unpreferrable. They eat token budgets, are harder to maintain, and may confuse the model. Prefer contextual advice that's derived from the agent's actions, such as tool usage.

For situations where general advice is preferrable, keep it short and concise, ideally no more than a sentence. In system prompts, short organisational comments are useful to help organise out multi-line guidelines.

## Avoid Context Rot

teapilot strives to preserve the context window - encouraging agents to only receive data necessary for the job. Data that may be lost through compaction, or is too big/distracting to bring into full context of the agent is preferrably saved in files or processed into only needed data; see `artifacts` or `takeNotes` for examples.

### Context Model

teapilot is focused on keeping a focused, token efficient context - with a backlog that allows the model to retrieve just what is relevant for the task without distraction.

teapilot's tool call results should flow as follows:

| Kind               | Examples                                      | Handling                                                       |
| ------------------ | --------------------------------------------- | -------------------------------------------------------------- |
| workingState       | Goals, plans, WIP errors/file modifications   | Keep hot and explicit                                          |
| evidence           | Source reads, search results, logs, docs      | Keep recent evidence raw, offload/compact older evidence.      |
| artifact (storage) | Full evidence that doesn't need to be inlined | Store losslessly, leave a compact reference for easy retrieval |

*note: this info is lost when a conversation ends. information that should persist is to be stored inside of the workspace - primarily through `git`; alternatively through `README.md/AGENTS.md` files, or other more specific notes files.*