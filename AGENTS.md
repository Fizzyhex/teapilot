This file is for programming agents.

## Co-Authoring Commits

**NEVER** co-author/co-sign commits with anything but `virtual paws :3`, or teapilot. If that's not available - leave co-authoring blank.

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
- It uses the real configuration and models, so turns can spend money; `--config-dir` picks another profile. Access lists and apps live in a scratch directory, never the profile's.
- Only operators can answer approvals, as on Discord: read each one, and deny it unless the action is part of your task.
- Always `stop` sessions you start.
