# teapilot

A small personal agent host for coding, questions, research, and planning. Run local models without API keys, or configure cloud models with spending limits.

Use `ask` for questions and planning, and `code` to work in a repository. Each command handles one request.

## Quick start

Requires **Node.js 22.19.0 or newer**, npm, and Git. Supported platforms are Windows with PowerShell and Linux with bash.

Until the first npm release is published, install from source. Authenticate Git while the repository is private. These commands work in both shells:

```sh
git clone https://github.com/fizzyhex/teapilot.git
cd teapilot
npm install
npm run setup -- --config-dir .
npm start -- ask "Explain dependency injection"
```

The setup wizard offers local Ollama, an existing local endpoint, or a cloud model. It can install Ollama and download a model with your consent, then check that it works. Local setup needs no API key and keeps cloud fallback disabled.

## Use

From the source checkout:

```sh
npm start -- ask "Help plan the next three workdays"
npm start -- code --cwd "path/to/repository" "Fix the failing tests"
npm start -- doctor
```

Choose the repository root with `--cwd`. `ask` has no repository tools; `code` can read, edit, and run approved commands. Requests are independent, with no persistent conversation or personal memory.

After installing the published package, use `teapilot` in place of `npm start --`. See [setup and diagnostics](usage/01-setup.md) for package installation and readiness checks, and [usage](usage/02-commands.md) for more examples and web research.

## Permissions and spending

- File tools stay within the selected repository. Arbitrary shell commands require approval unless explicitly trusted; approved commands run with your OS user's permissions.
- Cloud tiers require explicit configuration. Default spending limits are **$1 per request** and **$5 per UTC day**, using conservative reservations and your configured prices.
- Failed attempts can escalate to another enabled model. Edits stay in place; there is no automatic rollback.

Read [execution boundaries](usage/04-safety.md) before enabling trusted commands, and [spending and escalation](usage/05-spending.md) before enabling cloud models.

## Documentation

1. [Setup and diagnostics](usage/01-setup.md) — installation, model checks, and scripted setup
2. [Commands](usage/02-commands.md) — requests, routing behavior, exit codes, and web research
3. [Configuration](usage/03-configuration.md) — profiles, providers, models, and policy
4. [Permissions and execution boundaries](usage/04-safety.md) — file access, shell approvals, and trusted commands
5. [Spending and escalation](usage/05-spending.md) — budgets, cost accounting, and model escalation
6. [Local records](usage/06-records.md) — logs, privacy, and crash recovery
7. [Docker](usage/07-docker.md) — container setup
8. [Architecture](usage/08-architecture.md) — upstream integrations and design choices
9. [Development and validation](usage/09-development.md) — local checks and CI
10. [Publishing](usage/10-publishing.md) — release setup and package publication

See [project status](https://github.com/fizzyhex/teapilot/blob/main/STATUS.md) for validation and remaining limits.
