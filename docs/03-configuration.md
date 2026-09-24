# Configuration

Most users should run `teapilot setup`. Use this page when you need a specific profile, local endpoint, model, or routing policy.

## Which configuration is used?

TeaPilot checks configuration in this order:

1. Explicit `--config-dir`.
2. A TeaPilot `.env` or repository configuration in the launch directory.
3. `~/.teapilot/config`.

Exported environment variables override `.env`. Relative paths resolve from the selected configuration directory. Setup stores generated configuration with private permissions.

## Manual setup

Copy `.env.example` to `.env`. For hosted routing, choose a provider:

```dotenv
JEV_PROVIDER=typesafe
TYPESAFE_API_KEY=...
```

or:

```dotenv
JEV_PROVIDER=openrouter
OPENROUTER_API_KEY=...
```

Leave `JEV_MODEL` unset to use the provider default. Set `TEAPILOT_ROUTING_MODE=direct` to use explicit commands without routing charges. Never put API keys in command arguments or committed files.

## Use a local model server

```dotenv
LOCAL_BASE_URL=http://127.0.0.1:8080/v1
LOCAL_MODEL=my-model
```

The endpoint must provide `/models` and streaming `/chat/completions`. Coding also needs function/tool calls and a suitable chat template. Set the model’s actual context size in the models configuration. [llama.cpp server](https://github.com/ggml-org/llama.cpp/tree/master/tools/server) is one example of an OpenAI-compatible endpoint.

An unreachable local endpoint is marked unavailable before routing. Hosted tiers ship disabled; enable them only after setting their model and current provider rates. Use conservative upper prices—zero rates are rejected for enabled cloud tiers.

## Model and policy files

For personal overrides, copy the examples:

```sh
cp config/models.example.json config/models.json
cp config/policy.example.json config/policy.json
```

On PowerShell, use `Copy-Item` instead. Then set `TEAPILOT_MODELS_FILE` and `TEAPILOT_POLICY_FILE` in `.env`. These files and `.env` are ignored by Git.

The model file controls IDs, providers, endpoints, context/output limits, temperature, and tool support. The policy file controls permissions, budgets, limits, escalation, routing confirmation, and explicitly trusted shell commands. Environment variables override file values.

## Routing and fallback

Hosted mode normally lets JevRouter choose a capability using availability, permissions, risk, budget, and workload. If it cannot decide, TeaPilot may fall back only after the workload is known to be `ask` or `code`; it never guesses for a bare prompt.

Fallback does not bypass permissions, approvals, risk limits, verification, or budgets. Direct fallback choices are recorded as fallbacks, not as made-up router receipts.

Ordinary `doctor` makes no paid inference call. `npm start -- --help` and the ordinary test suite work without credentials.

[Back to README](../README.md)
