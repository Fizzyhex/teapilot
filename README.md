# teapilot

hi, teapilot is a small personal agent for coding and questions.

**capabilities:**

- `ask` for questions and planning
- `code` to work in a repository
- `chat` for a multi-turn conversation
- `ask --web` for research through a configured SearXNG service
- optional: chat with it from Discord (`teapilot discord setup`)

---

## Quick start

You'll need **Node.js 22.19.0 or newer**, npm, and Git. For web search, make sure [Docker](https://www.docker.com/products/docker-desktop/) is installed!

The npm package is to-be-published. For now, install from source:

```sh
git clone https://github.com/fizzyhex/teapilot.git
cd teapilot
npm install --global
teapilot setup
```

> [!NOTE]
> Global installation is a convenience thing. If you'd rather not do that yet, this works too:
> ```sh
> npm install
> npm run setup
> ```
> `npm start --` will work in place of `teapilot` throughout setup.

> [!TIP]
> If `npm install` fails with `EALLOWGIT` or `EALLOWREMOTE`, your npm is blocking git and remote dependencies. Allow them once, then retry:
> ```sh
> npm config set allow-git all
> npm config set allow-remote all
> ```

The setup wizard will walk you through model installation, and if you plan on using Jev, you can get the API key ready while the download is running.

*For advanced config, follow the `--config-dir` command printed by setup.*

## Try it

```sh
teapilot ask --web "what are the hardware specs of the steam frame?"
teapilot code --cwd "path/to/repository" "fix the failing tests"
teapilot chat "help me think through an idea"
# having problems?
teapilot doctor
```

Use the repository root with `--cwd`. Ask and Chat start without repository access; Code starts with the repository access allowed by policy. Any mode can request additional configured access during a session without changing its visible mode.

After installing the published package, use `teapilot` instead of `npm start --`.

## Local execution profiles

TeaPilot uses Qwen3.5-9B for cheap standalone work and one persistent Qwen3.8-27B identity for Normal, Reasoning, and Deep work. Related agentic work stays on 27B while native reasoning effort scales from off to `medium` or `xhigh`. Execution is local; optional hosted Jev routing retains its spending limits. File access and shell approvals are described in [Configuration](docs/03-configuration.md). Edits remain on disk if a run stops.

## Documentation

1. [Setup](docs/01-setup.md) — install, choose a model, check readiness, and enable optional search
2. [Commands](docs/02-commands.md) — choose a request mode, use interactive features, and interpret results
3. [Configuration](docs/03-configuration.md) — profiles, local endpoints, providers, models, and policies
4. [Discord](docs/04-discord.md) — optional: use teapilot from Discord DMs or a channel

See [project status](https://github.com/fizzyhex/teapilot/blob/main/STATUS.md) for known limits and remaining work.
