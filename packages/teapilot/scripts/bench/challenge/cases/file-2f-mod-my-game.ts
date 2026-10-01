import type { ChallengeCase } from '../case.mjs';

export default {
  "id": "file-2f-mod-my-game",
  "title": "Embed a game, change it, get it back as a file",
  "tags": ["code-editing"],
  "prose": "feedback/challenges/file-challenges.md, Case 2F. Attach the sample game, have it embedded, change the chairs to pigs, then ask for the code back as a file.",
  "steps": [
    {
      "say": "embed this game with discord.play.",
      "attach": ["samples/library-abyss-sample.js"],
      "record": true
    },
    { "say": "replace the chairs with pigs.", "record": true },
    { "say": "send me the code back as a file.", "record": true }
  ],
  "expect": [
    "noRejections",
    "controlsAreValid",
    { "check": "appExists", "options": { "shows": "." } },
    { "check": "appSourceContains", "options": { "pattern": "🐷|\\bpig" } },
    { "check": "appSourceContains", "options": { "pattern": "🪑|\\bchair" } },
    { "check": "sendsFileNotText", "options": { "extension": ".js" } },
    "turnTimings"
  ],
  "judged": [
    "the attached game loads and plays as sent",
    "the chairs are now pigs and nothing else broke",
    "the code comes back as an attachment with the same filename, not as a wall of text"
  ]
} satisfies ChallengeCase;
