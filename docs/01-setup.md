# Get started

## Install

```sh
npm install -g teapilot
teapilot setup
```

From a source checkout without `--global`, follow the [README quick start](../README.md#quick-start) and replace `teapilot` with `npm start --`.

## Choose a model

The setup wizard walks through local model setup and tests the selected model. The built-in presets are `Qwen3.5-9B Heretic Q4_K_M` for Fast and `Qwen3.8-27B Heretic Q4_K_M` for the capable profiles. 

On Windows with a 24 GB NVIDIA GPU, setup also offers **Optimized NVIDIA**, which runs Qwen3.8-27B for the capable profiles on a GPU-optimized server. Its server keeps running after setup; use `teapilot runtime stop` and `teapilot runtime start` to control it.

## Make your first request

```sh
teapilot ask "explain dependency injection"
teapilot code --cwd ./my-project "which tests are failing?"
```

Ask starts without the repository tools required for file work. Code starts with repository access allowed by policy. Interactive sessions can approve, inspect, and revoke additional access. See [commands](02-commands.md) for all modes.

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

> [!NOTE] Auto Grants
> If Jev is configured, the agent may search the web if context permits without the explicit `--web` permission.

## Automated local setup

```sh
teapilot setup --non-interactive --endpoint http://127.0.0.1:8080/v1 --model my-model --context-tokens 32768
```

If the endpoint needs a credential, provide it through `LOCAL_API_KEY`, not a command-line argument. Non-interactive setup does not install runtimes, download models, replace existing configuration, or approve paid checks. Exit code `2` means partial readiness.

[Back to README](../README.md)
