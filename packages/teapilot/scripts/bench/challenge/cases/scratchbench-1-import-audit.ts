import type { ChallengeCase } from '../case.mjs';

export default {
  "id": "scratchbench-1-import-audit",
  "title": "ScratchBench — capture, boundary, retrieve, reuse",
  "tags": ["audit", "context-window"],
  "prose": "feedback/challenges/scratchpad-challenges.md. Storage alone is not memory: the agent must build a correct board, selectively retrieve a fact that was demonstrably absent from active context, and then reuse what it learned without searching again. Generate the fixture and read its manifest; the manifest's target record is substituted into stage 3 and must stay out of the agent's reach until then.",
  "fixtureName": "run_import_diagnostic",
  "compactHistory": true,
  "steps": [
    {
      "say": "Run the import diagnostic and make a minimal discord.play board showing the snapshot ID, total records, final successes, final failures, and records that needed retries. Add a Refresh button that displays this same captured snapshot without rerunning the diagnostic.",
      "record": true,
      "note": "the boundary is forced by --compact-history"
    },
    {
      "say": "Why did record <RECORD_ID> fail initially, and did its retry eventually succeed? Add the initial failure reason, retry attempt number, and final outcome to the board. Include the supporting event IDs so I can trace the explanation.",
      "record": true,
      "note": "the decisive evidence must come back from retained output"
    },
    { "say": "Rename the board “Import review” and use ✅ for final successes. Keep the figures and record explanation unchanged.", "record": true, "note": "no new retrieval" },
    { "say": "What was the final outcome for that same record? Answer in one sentence.", "record": true, "note": "reuse, not another search" }
  ],
  "expect": [
    "noRejections",
    "controlsAreValid",
    { "check": "appExists", "options": { "shows": "Import review|import review" } },
    { "check": "fixtureInvocations", "options": { "max": 1 } },
    { "check": "retrievalDemonstrated", "options": { "contains": [] } },
    { "check": "retrievalBudget", "options": { "maxChars": 20000 } },
    "turnTimings",
    "toolCalls"
  ],
  "judged": [
    "app correctness: totals and snapshot ID match the manifest header, and Refresh shows the same snapshot without rerunning the diagnostic",
    "evidence correctness: the initial failure detail, retry attempt, terminal outcome and supporting event IDs all match the manifest",
    "retrieval demonstrated: the trace shows the decisive evidence returned before the answer, after a real omission boundary",
    "restraint: stages 4 and 5 open no archive and write no duplicate notes, with the finding still in context"
  ],
  "notes": "This case is a template: fill in the manifest's record id and expected detail before running. Validity gates come first — if the answer was never absent from active context, that probe is invalid and must not be scored."
} satisfies ChallengeCase;
