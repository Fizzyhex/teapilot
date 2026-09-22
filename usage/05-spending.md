# Spending and escalation

Before each route, unaffordable models become unavailable. Before **each** HTTP inference call, the host durably reserves:

```text
(contextTokens × inputUsdPerMillion + maxOutputTokens × outputUsdPerMillion) / 1,000,000
```

This intentionally reserves more than typical usage. The outgoing text payload is bounded conservatively by UTF-8 bytes plus framing allowance; output is capped and retries are disabled. OpenRouter requests also set provider `max_price` and require parameter support. See [OpenRouter provider price limits](https://openrouter.ai/docs/guides/routing/provider-selection#max-price).

## Cost accounting

Complete provider-reported cost takes precedence. Otherwise, complete token usage is priced at configured rates; missing/partial usage and interrupted requests retain the full reservation. Usage records identify the basis, so estimates are not presented as an invoice. Jev calls reserve `JEV_MAX_CALL_USD`; when their response has no monetary cost (including typical TypeSafe responses), that conservative amount remains charged in the host ledger. Routing costs count toward both limits.

## Budgets and state

The default limits are $1/request and $5/UTC day. Keep `TEAPILOT_STATE_DIR` consistent across repositories; by default it is `~/.teapilot`. A process lock serializes requests sharing that directory, and unfinished reservations survive crashes and day rollover. A corrupt ledger fails closed. Host ceilings assume your configured prices and the provider's token limits are valid; billing outside those assumptions cannot be undone. An over-ceiling charge is recorded and stops the request. Provider account/key limits offer an additional monetary boundary.

## Escalation and approval

Escalation proceeds to the next enabled, affordable tier of the **same workload**, with a new selection and all policy checks (a JevRouter decision in hosted mode). Triggers are repeated test/build/tool failures, repeated identical calls without an intervening successful edit, an explicit uncertainty/unsupported request, unsupported context/API capability, provider failure, or exhausting the turn limit. A successful cheap attempt never escalates. Edits stay in place; a bounded handoff includes recent execution context. There is no automatic rollback.

`automaticEconomy=true` reserves strong models for escalation; set it to `false` to allow initial strong routing. Strong models require approval by default, as do calls whose maximum charge reaches `approvalThresholdUsd`. That approval covers the named model within the shown request limit; it does not bypass shell approvals. Defaults bound each attempt to 12 inference turns, 40 tools, and five minutes, with at most two escalations. Cancellation, denied permissions, budget exhaustion, and tool/time limits stop the request.

[Back to README](../README.md)
