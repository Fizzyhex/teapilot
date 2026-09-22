# teapilot

A small personal agent host for software development, questions, research, and planning. Run locally with explicit `ask`/`code` commands and no API keys, or use hosted JevRouter routing. TeaPilot executes requests with pi and accounts for cloud costs.

```text
ask/code (direct) → policy checks → bounded pi tool loop → result

CLI request → JevRouter SDK → coder.local/economy/strong or ask.local/economy/strong
                           → bounded pi tool loop → result
                           → failure evidence → JevRouter → next available tier
```

## Requirements

- **Node.js 22.19.0 or newer** and npm. Git is needed for repository operations and source development, but not for installing the published package. Node 20 is not supported.
- Windows with PowerShell, or Linux with bash. No global agent installation is needed.
- Local setup uses Ollama without an API key. Setup can install Ollama and download a selected model, or connect to an existing OpenAI-compatible local server.
- Cloud execution needs a provider key and configured prices. Hosted JevRouter routing additionally needs a TypeSafe/Jev or OpenRouter key; direct `ask`/`code` selection does not.

## Setup

Public npm installation (available after the first release is published):

```sh
npm install -g teapilot
teapilot setup
teapilot ask "Explain dependency injection"
teapilot code --cwd ./my-project "Fix the failing tests"
```

The wizard offers local Ollama, an existing local endpoint, or a cloud model. For Ollama it detects the runtime, requests consent before installation/downloads, shows model sizes and memory guidance, and checks streaming, tool continuation, and a real edit in a disposable directory. CPU execution may be slow. It creates a separate model alias with an explicit context size rather than changing the original model. Runtime installation follows the official [Windows](https://docs.ollama.com/windows) and [Linux](https://docs.ollama.com/linux) installers; Linux may require sudo and systemd. On other Linux service configurations, start `ollama serve` separately and rerun setup.

Generated configuration lives in `~/.teapilot/config`, with private file permissions (Windows user ACLs / POSIX mode 600). Repeating setup offers to retain and verify settings or reconfigure them. Downloads can be resumed after failure. Previous JSON generations are retained; the active `.env` pointer is replaced only after a complete save. A partial result disables unverified coding; rerun setup and choose reconfigure to validate it again. Configuration never silently enables cloud fallback.

`teapilot doctor` verifies the selected model appears in the endpoint's model list and checks state access. `teapilot doctor --live` also runs real inference and tool checks. Paid live checks require interactive consent and use the normal spending ledger; routing credentials are reported as present, not live-tested. A healthy basic doctor does not prove coding readiness.

For scripted setup against an **existing local endpoint**, with a new configuration directory:

```sh
teapilot setup --non-interactive --endpoint http://127.0.0.1:8080/v1 --model my-model --context-tokens 32768
```

Provide a local endpoint credential through `LOCAL_API_KEY` if needed. This mode does not install runtimes, download models, replace existing configuration, or authorize paid probes. Never pass API keys as command-line arguments. Setup returns `2` for partial readiness.

### Development from source

Until the npm release is published, use the source checkout and `npm run setup`. Authenticate Git while the repository remains private.

PowerShell:

```powershell
git clone https://github.com/fizzyhex/teapilot.git
cd teapilot
npm install
npm run setup -- --config-dir .
npm start -- ask "Explain dependency injection"
```

Linux / POSIX shell:

```sh
git clone https://github.com/fizzyhex/teapilot.git
cd teapilot
npm install
npm run setup -- --config-dir .
npm start -- ask "Explain dependency injection"
```

For manual configuration, copy `.env.example` to `.env`. Existing configurations default to hosted routing. Set `JEV_PROVIDER=typesafe` and `TYPESAFE_API_KEY` (or `JEV_API_KEY`), or `JEV_PROVIDER=openrouter` and `OPENROUTER_API_KEY`. Leave `JEV_MODEL` unset to use JevRouter's provider-specific default: `jev-latest` for TypeSafe or `~typesafe/jev-latest` for OpenRouter. `JEV_API_URL` applies only to TypeSafe. Set `TEAPILOT_ROUTING_MODE=direct` to use explicit commands without routing charges.

For local execution, set `LOCAL_BASE_URL` to your server's API root, including `/v1`, and `LOCAL_MODEL` to its model ID. The default endpoint is `http://127.0.0.1:8080/v1`. The server must support `/models` and streaming `/chat/completions`; coding also needs working function/tool calls and an appropriate model chat template. Set its real context size in the models configuration. For example, [llama.cpp's server](https://github.com/ggml-org/llama.cpp/tree/master/tools/server) documents these OpenAI-compatible interfaces. An unreachable local endpoint is marked unavailable before routing.

To enable PAYG, set `ECONOMY_ENABLED=true`, `ECONOMY_MODEL`, and the two `ECONOMY_*_USD_PER_MILLION` rates. Set **conservative upper prices** from your provider's current rate card; zero rates are intentionally rejected for enabled cloud tiers. Configure strong similarly if wanted. Model IDs are configuration, never host logic. Cloud tiers ship disabled so example prices cannot cause accidental spending. Use `LOCAL_ENABLED=false` for cloud-only operation.

Ordinary `doctor` makes no paid inference calls. Hosted mode requires a routing credential; direct local mode does not. `npm start -- --help` and the ordinary test suite work without credentials.

## Use

```sh
npm start -- code --cwd "path/to/repository" "Fix the failing unit tests"
npm start -- ask "Explain dependency injection"
npm start -- ask "Help plan the next three workdays"
npm start -- code --correction "The previous change missed empty input" "Fix the parser"
npm start -- code --json --cwd "path/to/repository" "Review the code"
```

The same argument syntax works in PowerShell, including paths with spaces. `npm start` without arguments asks for one prompt and, in direct mode, a workload. Each invocation is one request, not a persistent conversation. Corrections are included in the prompt and noted in outcomes; there is no personal memory or automatic retrieval of previous sessions.

`--cwd` is the filesystem boundary, so choose the repository root. Configuration lookup uses explicit `--config-dir` first, then an existing launch-directory TeaPilot `.env` or repository configuration, then `~/.teapilot/config`. An unrelated application's `.env` does not hide your personal profile. Relative configuration paths resolve from the chosen configuration directory. Exported environment variables override its `.env`. Package templates supply defaults when a selected configuration has no custom model/policy files. To run compiled JavaScript: `npm run build`, then `node dist/cli.js ask "prompt"`.

In direct mode, `ask` has no repository tools; `code` selects the coding workload. A bare prompt asks which workload to use in an interactive terminal and is rejected noninteractively. Enabled tiers are considered local, economy, then strong; escalation retains the workload and all approval/budget checks. Fresh local setup enables only local inference and works with zero monetary budgets. Hosted mode retains automatic JevRouter selection; explicit commands constrain it to the requested workload.

Exit codes: `0` completed (or healthy doctor), `1` configuration/runtime failure, `2` blocked or incomplete. Inspect the status as well as the response: generated text alone is not proof of successful execution.

## Configuration and policy

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

The six capabilities are ordinary JevRouter `CapabilityManifest` values, validated with its SDK. Metadata includes provider/model, local/cloud, cost class, context size, vision, web availability, workload, and limits. Vision is descriptive metadata only: this milestone accepts text. The operator stub is unavailable and is not advertised as executable.

In hosted mode, JevRouter owns candidate selection, probabilities, confidence, filtering, risk, permissions, and confirmation. A low-confidence/no-decision response stops execution. Both hosted and direct selection cross the same host permission, risk, verification, availability, and confirmation gate. Direct selections are recorded in outcomes without fabricated JevRouter receipts. The default policy permits guarded repository editing at medium risk without a route-level prompt; add `medium` to `confirmation_risk_levels` to require one.

### Execution boundary

Pi supplies the agent loop, read/write/edit tools, platform shell tools, tool result handling, and project instruction loading. Ancestor/root `AGENTS.md`/`CLAUDE.md` files load through pi; the coder is instructed to inspect relevant nested instructions before editing. Global/project pi extensions, skills, hooks, and arbitrary agent packages are **not automatically loaded**.

File tools are restricted to the selected directory. Traversal, symlinks/junctions, hard links, `.git`, `.env*` (except `.env.example`), credential directories, and host state paths are blocked. Large reads are bounded; significant overwrites need approval. Selected read-only Git commands run automatically. Arbitrary shell commands require explicit `yes` in an interactive terminal. A denial stops the attempt and does not trigger escalation; noninteractive approval defaults to denial.

To allow builds/tests automatically in a **trusted repository**, add exact commands such as `npm test`, `npm run build`, and `npm run typecheck` to `execution.trustedCommands` in your personal policy. This explicitly authorizes the code those commands run, including future edits to scripts. A matching string is not an OS sandbox. Use this only for repositories/scripts you trust. Every other shell command still needs approval, including commands that can delete data, send messages, purchase, publish, or alter accounts/system state.

Shell children receive a small environment allowlist rather than inference credentials. Approved shell code still has your OS user's file/network permissions and can read files outside the repository, including credentials on disk. Filesystem checks cannot protect against concurrent malicious filesystem changes. Use an isolated account/container for untrusted projects. The optional Docker image does not by itself restrict network access.

### Spending and escalation

Before each route, unaffordable models become unavailable. Before **each** HTTP inference call, the host durably reserves:

```text
(contextTokens × inputUsdPerMillion + maxOutputTokens × outputUsdPerMillion) / 1,000,000
```

This intentionally reserves more than typical usage. The outgoing text payload is bounded conservatively by UTF-8 bytes plus framing allowance; output is capped and retries are disabled. OpenRouter requests also set provider `max_price` and require parameter support. See [OpenRouter provider price limits](https://openrouter.ai/docs/guides/routing/provider-selection#max-price).

Complete provider-reported cost takes precedence. Otherwise, complete token usage is priced at configured rates; missing/partial usage and interrupted requests retain the full reservation. Usage records identify the basis, so estimates are not presented as an invoice. Jev calls reserve `JEV_MAX_CALL_USD`; when their response has no monetary cost (including typical TypeSafe responses), that conservative amount remains charged in the host ledger. Routing costs count toward both limits.

The default limits are $1/request and $5/UTC day. Keep `TEAPILOT_STATE_DIR` consistent across repositories; by default it is `~/.teapilot`. A process lock serializes requests sharing that directory, and unfinished reservations survive crashes and day rollover. A corrupt ledger fails closed. Host ceilings assume your configured prices and the provider's token limits are valid; billing outside those assumptions cannot be undone. An over-ceiling charge is recorded and stops the request. Provider account/key limits offer an additional monetary boundary.

Escalation proceeds to the next enabled, affordable tier of the **same workload**, with a new selection and all policy checks (a JevRouter decision in hosted mode). Triggers are repeated test/build/tool failures, repeated identical calls without an intervening successful edit, an explicit uncertainty/unsupported request, unsupported context/API capability, provider failure, or exhausting the turn limit. A successful cheap attempt never escalates. Edits stay in place; a bounded handoff includes recent execution context. There is no automatic rollback.

`automaticEconomy=true` reserves strong models for escalation; set it to `false` to allow initial strong routing. Strong models require approval by default, as do calls whose maximum charge reaches `approvalThresholdUsd`. That approval covers the named model within the shown request limit; it does not bypass shell approvals. Defaults bound each attempt to 12 inference turns, 40 tools, and five minutes, with at most two escalations. Cancellation, denied permissions, budget exhaustion, and tool/time limits stop the request.

### Optional research

Set `SEARCH_BASE_URL` to a SearXNG instance you operate/trust with JSON responses enabled, then run:

```sh
npm start -- ask --web "Research current information and cite sources"
```

Only `--web` exposes search to the selected agent; normal ask has no filesystem or shell tools. Search uses the [SearXNG JSON Search API](https://docs.searxng.org/dev/search_api.html), returns at most five bounded snippets, and does not fetch arbitrary pages. It has no built-in paid search subscription. Any costs from your separately operated search service are outside the inference ledger. Without search, ask discloses that it cannot verify current information.

## Local records

In `TEAPILOT_STATE_DIR`:

- `.jevrouter/decisions/*.json`: JevRouter's returned decision receipts, with its probabilities, provenance hashes, and provider response. Its SDK returns receipts; only the upstream CLI persists them, so the host writes the original format with exclusive creation.
- `outcomes.jsonl`: execution status, selected model, tools/check outcomes, escalation, correction presence, approvals, and usage, linked by request/decision IDs.
- `spend.jsonl`: durable reservation/settlement ledger.
- `run.lock/`: live request lock. After a crash, verify the old process is gone, then remove this **empty directory** with `Remove-Item -LiteralPath ...` or `rmdir ...`. Do not delete the spend ledger to clear the lock.

The host does not log prompts, tool arguments, tool output, or environment dumps in outcome records. Known inference credentials and bearer tokens are redacted. Upstream receipts contain raw provider responses, so treat the state directory as private. You can point JevRouter's existing dashboard at this directory; there is no second dashboard and no custom outcome ingestion into the upstream dashboard.

## Validation and Docker

```sh
npm ci
npm run check
npm run test:package
npm start -- --help
```

Tests run the real JevRouter SDK, pi agent loop, coding tools, shell execution, and CLI against local mock HTTP servers. They cover coder/ask routing, edits and instructions, escalation through economy/strong, approval denial, budgeting across requests, crash reservations, context/tool/turn limits, secret-safe telemetry, path boundaries, and optional search. No paid credentials are needed. GitHub Actions runs installation, type checking, tests, compilation, and compiled startup on Windows/Linux with Node 22.19.0 and 24.

The package smoke test installs an npm tarball in a temporary directory with Git disabled and exercises setup, config discovery, doctor, ask, and code without credentials. CI runs it on every supported platform/runtime. The separate `real Ollama validation` workflow downloads each bundled model preset and tests real streamed answers, tool continuation, and coding on Windows/Linux; it runs manually and as a mandatory release gate, not on pull requests. To run it against a local Ollama server: `npm run build`, then `npm run test:ollama` (downloads a model; `TEAPILOT_TEST_MODEL` selects `qwen3.5:4b` or `qwen3.5:2b`).

### Publishing

Create a version tag matching `package.json`, such as `v0.1.0`. The release workflow waits for native/package tests and every real-model validation before building its npm artifact. Publishing stays disabled until the repository variable `NPM_PUBLISH_ENABLED` is `true`.

Before the first public release, establish ownership of the npm `teapilot` package and configure its [trusted publisher](https://docs.npmjs.com/trusted-publishers/) for GitHub user `fizzyhex`, repository `teapilot`, workflow `release.yml`. A first package publication may require the owner's npm login to establish the package. Subsequent tagged releases use OIDC and provenance; no long-lived npm token is stored in the repository. Keep the variable disabled until package ownership and public-release readiness are established. No release has been published by the setup implementation itself.

Optional Docker (build also runs checks):

```sh
docker build -t teapilot .
docker run --rm teapilot --help
```

To use it interactively, add `-it --env-file .env`, mount your repository at `/workspace`, mount a persistent volume at `/home/node/.teapilot`, and pass `--cwd /workspace "your request"`. Configure model URLs reachable **from the container**; localhost inside it is not your host model server. Mount personal config files read-only at `/app/config/models.json` and `/app/config/policy.json` when using them. The image runs as the `node` user; the workspace mount must be writable by that user.

## Upstream integration decisions

Inspected on 2026-09-22 and pinned for reproducibility:

| Component | Inspection / choice |
| --- | --- |
| [JevRouter](https://github.com/BillionsBobby/JevRouter) | Commit `f944acb6530621bced023352e2358a63218bf4d9`, SDK `JevRouter`, `createSdkProvider`, `validateManifest`; no copied provider or policy engine |
| [little-coder](https://github.com/itayinbarr/little-coder) | 1.20.0, commit `89d4fa0af864230527ab75d12604ed0eb320e6df`; launcher assembles pi extensions and patches runtime/settings, not a standalone embedding SDK |
| [pi](https://github.com/earendil-works/pi) | `@earendil-works/pi-{agent-core,ai,coding-agent}` 0.87.0, the current ecosystem underlying little-coder; direct `Agent` plus existing coding tools gives one metered loop without hidden session compaction/retries |
| [TypeSafe API](https://docs.typesafe.ai/api) / [OpenRouter Decisions](https://openrouter.ai/docs/api/api-reference/alphadecisions/submit-a-decisions-questions-and-answers-request) | Used exclusively through JevRouter's adapters |
| [Inference API](https://openrouter.ai/docs/api/reference/overview) | Pi's OpenAI-compatible streaming adapter for both local and PAYG inference |

Little-coder is not forked or bundled. Its full extension suite/benchmarks and small-model performance claims do not apply to this host. Teapilot uses a short coding prompt, bounded reads, feedback-driven editing, and pi's existing tools; more little-coder extensions can be evaluated later without expanding this first milestone. See [STATUS.md](STATUS.md) for validation and remaining limits.
