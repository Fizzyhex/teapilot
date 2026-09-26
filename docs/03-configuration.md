# Configuration

Most users should run `teapilot setup`. Use this page for a specific local endpoint, model deployment, or routing policy.

## Configuration selection

TeaPilot checks configuration in this order:

1. Explicit `--config-dir`.
2. A TeaPilot `.env` or repository configuration in the launch directory.
3. `~/.teapilot/config`.

Exported environment variables override `.env`. Relative paths resolve from the selected configuration directory. Setup stores generated configuration with private permissions.

## Routing

Set `TEAPILOT_ROUTING_MODE=direct` for local declarative routing. Optional hosted Jev routing supports TypeSafe or OpenRouter:

```dotenv
JEV_PROVIDER=typesafe
TYPESAFE_API_KEY=...
```

or:

```dotenv
JEV_PROVIDER=openrouter
OPENROUTER_API_KEY=...
```

Hosted mode sends one batched decision request for workload, execution profile, task relatedness, and proposed access. Jev answers are proposals. Session grants and the configured permission ceiling remain the execution boundary. Hosted routing uses request and daily spending limits; model execution stays local.

## Local models and profiles

The default deployments are configurable with:

```dotenv
FAST_BASE_URL=http://127.0.0.1:11434/v1
FAST_MODEL=hf.co/mradermacher/Qwen3.5-9B-heretic-GGUF:Q4_K_M
CAPABLE_BASE_URL=http://127.0.0.1:11434/v1
CAPABLE_MODEL=hf.co/DevJac/Qwen3.8-27B-heretic:Q4_K_M
```

The endpoint must provide `/models` and streaming `/chat/completions`. Coding requires function calls and a suitable chat template.

| Profile | Physical model | Native effort | Context | Output |
| --- | --- | --- | ---: | ---: |
| Fast | Qwen3.5-9B | off | 8,192 | 2,048 |
| Normal | Qwen3.8-27B | off | 16,384 | 4,096 |
| Reasoning | Qwen3.8-27B | `medium` | 24,576 | 8,192 |
| Deep | Qwen3.8-27B | `xhigh` | 32,768 | 16,384 |

Normal, Reasoning, and Deep share one model identity. Related agentic work stays on that identity while effort changes. Unsupported native efforts remain unavailable; TeaPilot does not translate `xhigh` or emulate it in prompt text. Physical endpoints are checked independently, and execution models must have zero API cost.

## Teachat

Teachat is off by default. It only uses spare compute: it pauses while TeaPilot is busy anywhere on this computer.

```dotenv
TEACHAT_ENABLED=true
TEACHAT_IDLE_MINUTES=3      # idle time before agents start chatting
TEACHAT_DAILY_USD=0.05      # routing spend for teachat, within DAILY_BUDGET_USD
TEACHAT_DIR=~/.teachat      # the room, shared by every profile on this computer
```

## Model and policy files

Copy the examples for personal overrides:

```sh
cp packages/teapilot/config/models.example.json packages/teapilot/config/models.json
cp packages/teapilot/config/policy.example.json packages/teapilot/config/policy.json
```

On PowerShell, use `Copy-Item`. Set `TEAPILOT_MODELS_FILE` and `TEAPILOT_POLICY_FILE` in `.env`.

The model file defines the `fast` and `capable` deployments. The centralized execution policy maps them to four profiles and enforces context, output, and effort caps at inference. The policy file controls permission ceilings, routing budgets, limits, escalation, confirmations, and trusted shell commands.

Legacy local-only `local/economy/strong` files load as a labelled capable-only compatibility deployment when cloud tiers are disabled. Fast and native reasoning remain unavailable until setup verifies them. Enabled legacy cloud execution is rejected with migration guidance.

Ordinary `doctor` makes no paid inference call. Use `doctor --live` for consent-based model and tool checks.

[Back to README](../README.md)
