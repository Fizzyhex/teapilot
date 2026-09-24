# teapilot

A small personal agent host for coding, questions, research, and planning. Run local models without API keys, or configure cloud models with spending limits.

Use:

- `ask` for questions and planning
- `code` to work in a repository
- `chat` for a multi-turn conversation
- `ask --web` for research through a configured SearXNG service

## Quick start

TeaPilot requires **Node.js 22.19.0 or newer**, npm, and Git. Windows with PowerShell and Linux with bash are supported.

Until the npm package is published, install from source:

```sh
git clone https://github.com/fizzyhex/teapilot.git
cd teapilot
npm install
npm run setup
```

The setup wizard helps you choose a local Ollama model, an existing local endpoint, or a cloud model. It tests the connection before saving a personal profile. Local setup needs no API key and keeps cloud fallback disabled.

Follow the `--config-dir` command printed by setup. When running from source, replace `teapilot` with `npm start --`.

## Try it

```sh
npm start -- ask "Help plan the next three workdays"
npm start -- code --cwd "path/to/repository" "Fix the failing tests"
npm start -- chat "Help me think through an idea"
npm start -- doctor
```

Use the repository root with `--cwd`. `ask` has no repository tools; `code` can read, edit, and run approved commands; `chat` has the same tool access as `ask` and remembers recent turns for the current session only.

After installing the published package, use `teapilot` instead of `npm start --`.

## Before enabling cloud models

Cloud tiers require explicit configuration and use request and daily spending limits. Review [Configuration](docs/03-configuration.md) before enabling them. File access and shell approvals are described there as part of the policy configuration. Edits remain on disk if a run stops; TeaPilot does not automatically roll them back.

## Documentation

Start here:

1. [Setup](docs/01-setup.md) — install, choose a model, check readiness, and enable optional search
2. [Commands](docs/02-commands.md) — choose a request mode, use interactive features, and interpret results
3. [Configuration](docs/03-configuration.md) — profiles, local endpoints, providers, models, and policies

See [project status](https://github.com/fizzyhex/teapilot/blob/main/STATUS.md) for known limits and remaining work.
