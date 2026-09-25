This file is for programming agents.

## Co-Authoring Commits

**NEVER** co-author/co-sign commits with anything but `virtual paws :3`, or teapilot. If that's not available - leave co-authoring blank.

## Editing `/docs` and `README`

These files are intended to help users understand Teapilot usage. They are not intended to be in-depth feature requests or technical breakdown, and all writing should be focused on avoiding information overload. Do not append to documentation unless something is factually out of date, or you have been asked.

## Testing teapilot as a user

`scripts/agent-terminal.mjs` runs teapilot in a real terminal in the background, so you can use it the way a person does, one command at a time. Everything after `--` goes to teapilot unchanged.

```sh
node scripts/agent-terminal.mjs start --name t -- code --cwd path/to/repo "fix the failing test"
node scripts/agent-terminal.mjs wait t --for "^Result: " --timeout 300          # a turn has finished
node scripts/agent-terminal.mjs send t "/mode ask" --submit                     # type into the composer
node scripts/agent-terminal.mjs wait t --for "Approve this action"              # an approval is waiting
node scripts/agent-terminal.mjs send t "yes" --enter                            # answer it, as a user would
node scripts/agent-terminal.mjs screen t                                        # what is on screen now
node scripts/agent-terminal.mjs stop t
```

- The composer sends with `--submit` (Alt+Enter); plain Enter only adds a line there. Questions such as approvals take `--enter`.
- `wait` exits 0 on a match, 3 if teapilot exited first, and 124 on timeout. `--for` only sees output since your last `send`/`key`.
- It uses the real configuration and real models, so requests can spend money. Pass `--config-dir` after `--` to use a different profile.
- Teapilot prefers configuration in the directory it is launched from, and this checkout counts as one (`config/models.example.json`). The driver therefore launches from the home directory so the user's personal profile applies. Give teapilot its repository with `--cwd` after `--`; don't point the driver's own `--cwd` at this checkout.
- You have the same permissions as a user: read each approval on screen before answering it, and answer `no` unless the action is part of your task.
- Always `stop` sessions you start. Run `node scripts/agent-terminal.mjs --help` for keys and other commands.