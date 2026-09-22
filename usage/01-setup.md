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

## Check readiness

`teapilot doctor` verifies the selected model appears in the endpoint's model list and checks state access. `teapilot doctor --live` also runs real inference and tool checks. Paid live checks require interactive consent and use the normal spending ledger; routing credentials are reported as present, not live-tested. A healthy basic doctor does not prove coding readiness.

## Scripted local setup

For scripted setup against an **existing local endpoint**, with a new configuration directory:

```sh
teapilot setup --non-interactive --endpoint http://127.0.0.1:8080/v1 --model my-model --context-tokens 32768
```

Provide a local endpoint credential through `LOCAL_API_KEY` if needed. This mode does not install runtimes, download models, replace existing configuration, or authorize paid probes. Never pass API keys as command-line arguments. Setup returns `2` for partial readiness.

For installation from source, see the [README](../README.md#quick-start). For manual setup, see [configuration](03-configuration.md).

[Back to README](../README.md)
