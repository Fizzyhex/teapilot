# Local records and recovery

In `TEAPILOT_STATE_DIR`:

- `.jevrouter/decisions/*.json`: JevRouter's returned decision receipts, with its probabilities, provenance hashes, and provider response. Its SDK returns receipts; only the upstream CLI persists them, so the host writes the original format with exclusive creation.
- `outcomes.jsonl`: execution status, selected model, tools/check outcomes, escalation, correction presence, approvals, and usage, linked by request/decision IDs.
- `spend.jsonl`: durable reservation/settlement ledger.
- `run.lock/`: live request lock. After a crash, verify the old process is gone, then remove this **empty directory** with `Remove-Item -LiteralPath ...` or `rmdir ...`. Do not delete the spend ledger to clear the lock.

The host does not log prompts, tool arguments, tool output, or environment dumps in outcome records. Known inference credentials and bearer tokens are redacted. Upstream receipts contain raw provider responses, so treat the state directory as private. You can point JevRouter's existing dashboard at this directory; there is no second dashboard and no custom outcome ingestion into the upstream dashboard.

[Back to README](../README.md)
