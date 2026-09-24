# Get started

## Install

```sh
npm install -g teapilot
teapilot setup
```

From a source checkout without `--global`, follow the [README quick start](../README.md#quick-start) and replace `teapilot` with `npm start --`.

## Choose a model

The setup wizard walks through local model setup with Ollama and tests the selected model. The built-in presets are Qwen3.5-9B Heretic Q4_K_M for Fast and Qwen3.8-27B Heretic Q4_K_M for the capable profiles. Hosted Jev routing is optional and has separate spending limits; execution remains local.

Teapilot should launch Ollama for you, but open it up manually if not!

## Make your first request

```sh
teapilot ask "explain dependency injection"
teapilot code --cwd ./my-project "which tests are failing?"
```

Ask starts without repository tools. Code starts with repository access allowed by policy. Interactive sessions can approve, inspect, and revoke additional access. See [commands](02-commands.md) for all modes.

## Check readiness

```sh
teapilot doctor
teapilot doctor --live
```

The first command checks the model and configuration. Running `--live` will spin up a directory temporarily to see how teapilot is doing.

## Optional web search

Teapilot will ask you about [SearXNG](https://docs.searxng.org) for web search during setup.

Pass `--web` when you want search:

```sh
teapilot ask --web "Research current information and cite sources"
```

## Automated local setup

```sh
teapilot setup --non-interactive --endpoint http://127.0.0.1:8080/v1 --model my-model --context-tokens 32768
```

If the endpoint needs a credential, provide it through `LOCAL_API_KEY`, not a command-line argument. Non-interactive setup does not install runtimes, download models, replace existing configuration, or approve paid checks. Exit code `2` means partial readiness.

[Back to README](../README.md)
