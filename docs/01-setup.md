# Setup and diagnostics

This guide gets TeaPilot installed, connected to a model, and ready for its first request.

## 1. Install TeaPilot

For the published package:

```sh
npm install -g teapilot
teapilot setup
```

For installation from source, follow the [README quick start](../README.md#quick-start). Replace `teapilot` in the examples below with `npm start --` when running from a checkout.

## 2. Run setup

The setup wizard walks you through a model provider and checks that the connection works. It supports:

- **Local Ollama** — the recommended option for running without an API key. TeaPilot can install Ollama and download a model after you approve each step.
- **An existing local endpoint** — use a model server that is already running.
- **A cloud model** — configure this only if you want to use a hosted provider and have reviewed the [spending guidance](05-spending.md).

For Ollama, the model menu includes:

- **Default:** Qwen3.5-9B abliterated ([Ollama package](https://ollama.com/huihui_ai/qwen3.5-abliterated:9b), about 6.6 GB).
- **Hard task fallback:** Qwen3.5-35B-A3B abliterated Q4_K_M ([Ollama package](https://ollama.com/huihui_ai/qwen3.5-abliterated:35b-a3b-q4_K), about 24 GB).
- **Cheap & fast:** [Qwen3.5-4B-Uncensored-GGUF](https://huggingface.co/mradermacher/Qwen3.5-4B-Uncensored-GGUF) Q8_0, about 4.7 GB. TeaPilot downloads it directly; no conversion is needed.

You can enter one model number or several, separated by commas or spaces (for example, `1, 2, 3`). Downloads happen in order; duplicates and already-downloaded models are skipped. At the end, choose the active model to verify and save. The other selected models remain installed, but the labels do not create automatic fallback routing.

The wizard checks streaming, tool continuation, and a real edit in a disposable directory. CPU execution may be slow. On Linux, Ollama may require `sudo` and `systemd`; on other service configurations, start `ollama serve` and run setup again. Use the official [Windows](https://docs.ollama.com/windows) or [Linux](https://docs.ollama.com/linux) installation instructions when needed.

When setup finishes, follow the explicit `--config-dir` command it prints. That command ensures the next request uses the profile that was just checked, even if the current checkout has its own settings.

## 3. Make a first request

```sh
teapilot ask "Explain dependency injection"
teapilot code --cwd ./my-project "Fix the failing tests"
```

`ask` is for questions and planning. `code` can work in the repository selected by `--cwd`. See [commands](02-commands.md) for the complete command reference.

## Configuration and safety defaults

TeaPilot stores generated configuration in `~/.teapilot/config` with private permissions (Windows user ACLs or POSIX mode 600). Re-running setup lets you retain and verify the current profile or reconfigure it. It does not silently enable cloud fallback.

The router chooses a model; the execution model performs the work. Direct routing needs no routing key. Setup preserves existing routing and can optionally change it to direct or hosted Jev routing. Hosted routing verification is a separate, consented paid call; it does not execute a task.

Previous JSON generations are retained, and the active `.env` pointer changes only after a complete save. If setup reports partial readiness, coding is disabled until you rerun setup and verify the profile again.

## Check readiness

Run the basic diagnostic at any time:

```sh
teapilot doctor
```

This verifies that the selected model appears in the endpoint’s model list and that state access works. A healthy basic check does not prove coding readiness.

For real inference and tool checks, use:

```sh
teapilot doctor --live
```

Live hosted checks require interactive consent and use the normal spending ledger. Failed local endpoint checks look for an already-running Ollama server and explain how to reconfigure without switching providers automatically.

Use `teapilot setup --verbose` for raw Ollama progress details. Prompts and status labels are styled in an interactive terminal; redirected output stays plain. Set `NO_COLOR` to disable styling.

## Optional web search

Setup can connect TeaPilot to a local SearXNG container, an existing SearXNG service, or no search service. Search is used only when you pass `--web` to a supported request.

For local SearXNG, you need a running Docker engine using Linux containers and a local Docker context. TeaPilot does not install Docker. The setup consent covers downloading the official `docker.io/searxng/searxng:latest` image, running the background service, and sending a test query. Search runs locally, but queries are forwarded to external search engines.

Manage the local service with:

```sh
teapilot search status
teapilot search start
teapilot search stop
teapilot search remove
```

Use `--config-dir PATH` to manage a specific profile. `status` reports the container and URL without querying search. `start` requests consent and verifies the service. `remove` confirms before removing only that profile’s container; it retains the settings and downloaded image. Disabling search in setup does not stop the container.

The container binds a Docker-assigned port only on `127.0.0.1` and saves its verified URL in `searxng/settings.yml` inside the selected profile. It restarts with Docker and is reused by later setup runs. Removing and recreating it can change the port, so rerun setup to reconnect. See the [SearXNG container documentation](https://docs.searxng.org/admin/installation-docker).

## Scripted local setup

For automation against an **existing local endpoint**:

```sh
teapilot setup --non-interactive --endpoint http://127.0.0.1:8080/v1 --model my-model --context-tokens 32768
```

Provide an endpoint credential through `LOCAL_API_KEY` when needed. Never put API keys in command-line arguments. Non-interactive setup does not install runtimes, download models, replace existing configuration, or authorize paid probes. It returns exit code `2` for partial readiness.

[Back to README](../README.md)

