# Configuration and routing

## Configuration discovery

Configuration lookup uses explicit `--config-dir` first, then an existing launch-directory TeaPilot `.env` or repository configuration, then `~/.teapilot/config`. An unrelated application's `.env` does not hide your personal profile. Relative configuration paths resolve from the chosen configuration directory. Exported environment variables override its `.env`. Package templates supply defaults when a selected configuration has no custom model/policy files.

## Manual configuration

For manual configuration, copy `.env.example` to `.env`. Existing configurations default to hosted routing. Set `JEV_PROVIDER=typesafe` and `TYPESAFE_API_KEY` (or `JEV_API_KEY`), or `JEV_PROVIDER=openrouter` and `OPENROUTER_API_KEY`. Leave `JEV_MODEL` unset to use JevRouter's provider-specific default: `jev-latest` for TypeSafe or `~typesafe/jev-latest` for OpenRouter. `JEV_API_URL` applies only to TypeSafe. Set `TEAPILOT_ROUTING_MODE=direct` to use explicit commands without routing charges.

For local execution, set `LOCAL_BASE_URL` to your server's API root, including `/v1`, and `LOCAL_MODEL` to its model ID. The default endpoint is `http://127.0.0.1:8080/v1`. The server must support `/models` and streaming `/chat/completions`; coding also needs working function/tool calls and an appropriate model chat template. Set its real context size in the models configuration. For example, [llama.cpp's server](https://github.com/ggml-org/llama.cpp/tree/master/tools/server) documents these OpenAI-compatible interfaces. An unreachable local endpoint is marked unavailable before routing.

To enable PAYG, set `ECONOMY_ENABLED=true`, `ECONOMY_MODEL`, and the two `ECONOMY_*_USD_PER_MILLION` rates. Set **conservative upper prices** from your provider's current rate card; zero rates are intentionally rejected for enabled cloud tiers. Configure strong similarly if wanted. Model IDs are configuration, never host logic. Cloud tiers ship disabled so example prices cannot cause accidental spending. Use `LOCAL_ENABLED=false` for cloud-only operation.

Ordinary `doctor` makes no paid inference calls. Hosted mode requires a routing credential; direct local mode does not. `npm start -- --help` and the ordinary test suite work without credentials.

## Model and policy files

Copy `config/models.example.json` to `config/models.json` and `config/policy.example.json` to `config/policy.json`, then set `TEAPILOT_MODELS_FILE` and `TEAPILOT_POLICY_FILE` in `.env`. PowerShell uses `Copy-Item`; POSIX uses `cp`. These personal files and `.env` are ignored by Git. Environment variables override the selected files; already-exported environment values override `.env`.

| Setting | Purpose |
| --- | --- |
| Model `id`, `provider`, `baseUrl`, `apiKeyEnv` | Replace IDs/endpoints or use a different OpenAI-compatible gateway; secrets are read from the named environment variable |
| `contextTokens`, `maxOutputTokens` | Model context and per-call output limits |
| `temperature` | Optional sampling temperature; managed Ollama uses 0.2, live diagnostics use 0 |
| `toolCalling`, `supportsDeveloperRole`, `supportsUsage` | Server compatibility; ordinary ask supports models without tools |
| `enabled`, `disabledCapabilities` | Disable a tier or individual capability such as `ask.local` |
| `router` | JevRouter confidence, allowed risks, confirmation risks, and verification policy |
| `permissions` | Inference, repository read/write/shell, and web search permissions |
| `budget` | Request/day limits, expensive-call threshold, strong approval, economy preference |
| `limits`, `escalation` | Turn/tool/time limits and deterministic failure thresholds |
| `execution.trustedCommands` | Exact shell command strings you explicitly trust to run automatically |

## Routing policy

In hosted mode, JevRouter owns candidate selection, probabilities, confidence, filtering, risk, permissions, and confirmation. A low-confidence/no-decision response stops execution. Both hosted and direct selection cross the same host permission, risk, verification, availability, and confirmation gate. Direct selections are recorded in outcomes without fabricated JevRouter receipts. The default policy permits guarded repository editing at medium risk without a route-level prompt; add `medium` to `confirmation_risk_levels` to require one.

[Back to README](../README.md)
