# Get started

## Install

```sh
npm install -g teapilot
teapilot setup
```

From a source checkout, follow the [README quick start](../README.md#quick-start) and replace `teapilot` with `npm start --`.

## Choose a model

The setup wizard tests the connection and a real edit in a disposable directory. It supports local Ollama, an existing local endpoint, or a cloud model. If using a cloud model, review its provider pricing and configure conservative limits in [Configuration](03-configuration.md).

For Ollama, the menu includes a default model, a larger fallback for harder tasks, and a smaller fast model. The wizard shows download sizes. You may select several models; they are downloaded in order, but the labels do not create automatic fallback routing.

If Ollama is not running, start it and run setup again. On Linux it may need `sudo` or `systemd`; use the official [Windows](https://docs.ollama.com/windows) or [Linux](https://docs.ollama.com/linux) instructions if needed.

When setup finishes, use the `--config-dir` command it prints so the next request uses the profile you just tested.

## Make your first request

```sh
teapilot ask "Explain dependency injection"
teapilot code --cwd ./my-project "Fix the failing tests"
```

`ask` has no repository tools. `code` can inspect and edit the repository selected by `--cwd`. See [commands](02-commands.md) for the other modes.

## Check readiness

```sh
teapilot doctor
teapilot doctor --live
```

The first checks the selected model and state access. The second performs a real inference and tool check. Live hosted checks ask for consent and use the normal spending ledger. If setup reports partial readiness, coding stays disabled until you verify the profile again.

## Optional web search

Pass `--web` only when you want search:

```sh
teapilot ask --web "Research current information and cite sources"
```

Search needs a SearXNG service that you operate or trust. Setup can connect an existing service or a local Docker container; TeaPilot does not install Docker. Manage a local service with `teapilot search status`, `start`, `stop`, or `remove`. Search requests send queries to external search engines through SearXNG.

## Automated local setup

```sh
teapilot setup --non-interactive --endpoint http://127.0.0.1:8080/v1 --model my-model --context-tokens 32768
```

If the endpoint needs a credential, provide it through `LOCAL_API_KEY`, not a command-line argument. Non-interactive setup does not install runtimes, download models, replace existing configuration, or approve paid checks. Exit code `2` means partial readiness.

[Back to README](../README.md)
