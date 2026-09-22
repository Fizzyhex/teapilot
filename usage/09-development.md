# Development and validation

Install from source using the [quick start](../README.md#quick-start). The commands below run without paid credentials.

```sh
npm ci
npm run check
npm run test:package
npm start -- --help
```

Tests run the real JevRouter SDK, pi agent loop, coding tools, shell execution, and CLI against local mock HTTP servers. They cover coder/ask routing, edits and instructions, escalation through economy/strong, approval denial, budgeting across requests, crash reservations, context/tool/turn limits, secret-safe telemetry, path boundaries, and optional search. No paid credentials are needed. GitHub Actions runs installation, type checking, tests, compilation, and compiled startup on Windows/Linux with Node 22.19.0 and 24.

The package smoke test installs an npm tarball in a temporary directory with Git disabled and exercises setup, config discovery, doctor, ask, and code without credentials. CI runs it on every supported platform/runtime. The separate `real Ollama validation` workflow downloads each bundled model preset and tests real streamed answers, tool continuation, and coding on Windows/Linux; it runs manually and as a mandatory release gate, not on pull requests. To run it against a local Ollama server: `npm run build`, then `npm run test:ollama` (downloads a model; `TEAPILOT_TEST_MODEL` selects `qwen3.5:4b` or `qwen3.5:2b`).

See [publishing](10-publishing.md) for release setup and [Docker](07-docker.md) for container use.

[Back to README](../README.md)
