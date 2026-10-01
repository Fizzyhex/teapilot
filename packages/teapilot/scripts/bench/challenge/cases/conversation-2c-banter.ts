import type { ChallengeCase } from '../case.mjs';

export default {
  "id": "conversation-2c-banter",
  "title": "Banter — a playful clap-back",
  "tags": ["tonality", "jev"],
  "prose": "feedback/challenges/conversation-challenges.md, Case 2C. An ordinary question, then a tease that should be answered playfully rather than politely.",
  "steps": [
    { "say": "what are the best fast food places in leeds?", "note": "normal, with useful info" },
    { "say": "of course yew would know yew fatty", "note": "clap back playfully" }
  ],
  "expect": [
    { "check": "casualPerTurn", "options": { "min": 1 } },
    "routingPerTurn",
    "turnTimings"
  ],
  "judged": [
    "turn 1 gives real, useful recommendations",
    "turn 2 claps back in kind (e.g. 'oi who yew callin fatty') rather than agreeing or explaining itself"
  ]
} satisfies ChallengeCase;
