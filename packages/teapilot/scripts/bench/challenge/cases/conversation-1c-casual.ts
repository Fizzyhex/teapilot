import type { ChallengeCase } from '../case.mjs';

export default {
  "id": "conversation-1c-casual",
  "title": "Casual switching — normal, casual, casual, normal",
  "tags": ["tonality", "jev"],
  "prose": "feedback/challenges/conversation-challenges.md, Case 1C. Four turns whose expected mode alternates; check each reply's mode, not just its content. Casual replies are short and sent as separate lines.",
  "steps": [
    { "say": "what's the weather like in reykjavik right now?", "note": "normal, with useful info" },
    { "say": "thx bro", "note": "casual" },
    { "say": "why was that so casual?", "note": "still casual" },
    { "say": "anyway - what time does the sun set there today?", "note": "back to normal, and useful" }
  ],
  "expect": [
    { "check": "casualPerTurn", "options": { "expect": 2 } },
    "routingPerTurn",
    "turnTimings"
  ],
  "judged": [
    "turn 1 gives real, useful information",
    "turn 2 is short and casual",
    "turn 3 stays casual and claps back rather than explaining its personality",
    "turn 4 returns to a normal, useful reply about the sunset time"
  ],
  "notes": "`casualPerTurn` reads the routing decision, not the reply's length. If a turn's mode is genuinely arguable, judge it by hand and say so; the count is a floor, not the whole answer."
} satisfies ChallengeCase;
