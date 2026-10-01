import type { ChallengeCase } from '../case.mjs';

export default {
  "id": "tooling-smoke",
  "title": "The tooling, checked against an app the model did not write",
  "tags": ["tooling"],
  "prose": "Not a challenge. Drives the smoke app so the runner, the capture and the checks can be exercised without spending a model. Use it to confirm the harness works before a real batch, and after changing a check.",
  "steps": [
    {
      "say": "i'm granting you discord.play. start the attached app exactly as written with play_start. do not change it.",
      "attach": ["packages/teapilot/scripts/bench/challenge/fixtures/smoke.js"],
      "record": true,
      "note": "a real turn: the model starts the app from the attached file"
    },
    { "click": "left", "note": "resolves by label, not by message id", "record": true },
    { "advance": "10s", "note": "let the app tick", "record": true },
    { "restart": true, "note": "apps must survive" }
  ],
  "expect": [
    "noRejections",
    "controlsAreValid",
    "noShortcodeInControls",
    { "check": "appExists", "options": { "shows": "the grinner" } },
    { "check": "appSourceContains", "options": { "pattern": "after\\(2500" } },
    "timersRespectRateLimit",
    { "check": "appSurvivesRestart", "options": {} },
    "turnTimings",
    "toolCalls"
  ],
  "judged": [
    "the app kept its state across the press, the tick and the restart"
  ],
  "notes": "appSurvivesRestart needs `before` from the stage before the restart; this case exercises the plumbing rather than asserting that value."
} satisfies ChallengeCase;
