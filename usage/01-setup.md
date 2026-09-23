# Setup and diagnostics

## Install the published package

Public npm installation:

```sh
npm install -g teapilot
teapilot setup
teapilot ask "Explain dependency injection"
teapilot code --cwd ./my-project "Fix the failing tests"
```

## Interactive setup

The wizard offers local Ollama, an existing local endpoint, or a cloud model. For Ollama it detects the runtime, requests consent before installation/downloads, shows model sizes and memory guidance, and checks streaming, tool continuation, and a real edit in a disposable directory. CPU execution may be slow. It creates a separate model alias with an explicit context size rather than changing the original model. Runtime installation follows the official [Windows](https://docs.ollama.com/windows) and [Linux](https://docs.ollama.com/linux) installers; Linux may require sudo and systemd. On other Linux service configurations, start `ollama serve` separately and rerun setup.

Generated configuration lives in `~/.teapilot/config`, with private file permissions (Windows user ACLs / POSIX mode 600). Repeating setup offers to retain and verify settings or reconfigure them. Downloads can be resumed after failure. Previous JSON generations are retained; the active `.env` pointer is replaced only after a complete save. A partial result disables unverified coding; rerun setup and choose reconfigure to validate it again. Configuration never silently enables cloud fallback.

Setup prints an explicit `--config-dir` command so the next request uses the profile it checked, even from a checkout with its own settings. `--cwd` selects the working repository independently. Doctor shows the chosen configuration and environment override names, never their values. Interrupted first saves are identified separately from retained generations of an active profile.

The router chooses a model; the execution model does the work. Direct routing requires no routing key. Setup preserves existing routing and offers an optional change to direct or hosted Jev routing. Hosted routing verification is a separate, consented paid call within the usual spending limits; it does not execute a task.

## Check readiness

`teapilot doctor` verifies the selected model appears in the endpoint's model list and checks state access. `teapilot doctor --live` also runs real inference and tool checks and offers separate hosted routing verification. Paid live checks require interactive consent and use the normal spending ledger. A healthy basic doctor does not prove coding readiness. Failed local endpoint checks also look for an already-running Ollama server and explain how to reconfigure without switching automatically.

## Scripted local setup

For scripted setup against an **existing local endpoint**, with a new configuration directory:

```sh
teapilot setup --non-interactive --endpoint http://127.0.0.1:8080/v1 --model my-model --context-tokens 32768
```

Provide a local endpoint credential through `LOCAL_API_KEY` if needed. This mode does not install runtimes, download models, replace existing configuration, or authorize paid probes. Never pass API keys as command-line arguments. Setup returns `2` for partial readiness.

For installation from source, see the [README](../README.md#quick-start). For manual setup, see [configuration](03-configuration.md).

[Back to README](../README.md)
