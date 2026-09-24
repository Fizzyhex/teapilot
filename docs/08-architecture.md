# Architecture and upstream integrations

TeaPilot executes requests with pi and optionally uses hosted JevRouter routing.

```text
ask/code (direct) → policy checks → bounded pi tool loop → result

CLI request → JevRouter SDK → coder.local/economy/strong or ask.local/economy/strong
                           → bounded pi tool loop → result
                           → failure evidence → JevRouter → next available tier
```

The six capabilities are ordinary JevRouter `CapabilityManifest` values, validated with its SDK. Metadata includes provider/model, local/cloud, cost class, context size, vision, web availability, workload, and limits. Vision is descriptive metadata only: this milestone accepts text. The operator stub is unavailable and is not advertised as executable.

## Upstream choices

Inspected on 2026-09-22 and pinned for reproducibility:

| Component | Inspection / choice |
| --- | --- |
| [JevRouter](https://github.com/BillionsBobby/JevRouter) | Commit `f944acb6530621bced023352e2358a63218bf4d9`, SDK `JevRouter`, `createSdkProvider`, `validateManifest`; no copied provider or policy engine |
| [little-coder](https://github.com/itayinbarr/little-coder) | 1.20.0, commit `89d4fa0af864230527ab75d12604ed0eb320e6df`; launcher assembles pi extensions and patches runtime/settings, not a standalone embedding SDK |
| [pi](https://github.com/earendil-works/pi) | `@earendil-works/pi-{agent-core,ai,coding-agent}` 0.87.0, the current ecosystem underlying little-coder; direct `Agent` plus existing coding tools gives one metered loop without hidden session compaction/retries |
| [TypeSafe API](https://docs.typesafe.ai/api) / [OpenRouter Decisions](https://openrouter.ai/docs/api/api-reference/alphadecisions/submit-a-decisions-questions-and-answers-request) | Used exclusively through JevRouter's adapters |
| [Inference API](https://openrouter.ai/docs/api/reference/overview) | Pi's OpenAI-compatible streaming adapter for both local and PAYG inference |

Little-coder is not forked or bundled. Its full extension suite/benchmarks and small-model performance claims do not apply to this host. Teapilot uses a short coding prompt, bounded reads, feedback-driven editing, and pi's existing tools; more little-coder extensions can be evaluated later without expanding this first milestone. See [STATUS.md](https://github.com/fizzyhex/teapilot/blob/main/STATUS.md) for validation and remaining limits.

[Back to README](../README.md)
