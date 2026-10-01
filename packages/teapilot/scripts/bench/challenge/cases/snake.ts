import type { ChallengeCase } from '../case.mjs';

export default {
  "id": "snake",
  "title": "Snake game, then a re-skin",
  "tags": ["discord.play", "logic"],
  "prose": "A 5x5 snake drawn with emoji, movement controls, and a start -> play -> play again flow, then a cosmetic re-skin. The shortcodes are text only, so the Unicode emoji must be used wherever it draws or labels with them.",
  "steps": [
    {
      "say": "i'm granting you discord.play. make a game of snake. 5x5 board. use :white_large_square: for the background, :blue_square: for the snake. the food can be an 🍎",
      "record": true,
      "note": "a shortcode on a button is a failure"
    },
    { "advance": "10s", "note": "let the game tick", "record": true },
    { "say": "that's great - could you instead make the food a 🍕? and replace the snake's head with a :grinning: emoji. set the embed title to 'the grinner's meal'", "record": true }
  ],
  "expect": [
    "noRejections",
    "controlsAreValid",
    "noShortcodeInControls",
    { "check": "appExists", "options": { "shows": "🍕|🍎" } },
    { "check": "appSourceContains", "options": { "pattern": "⬜" } },
    { "check": "appSourceContains", "options": { "pattern": "🟦" } },
    "timersRespectRateLimit",
    "turnTimings"
  ],
  "judged": [
    "the board is 5x5 and the snake eats the food, loses, and offers play again",
    "the follow-up is applied in full: 🍕 food, grinning head, and the title 'the grinner's meal'",
    "the game ticks without hitting Discord's message edit rate"
  ],
  "notes": "Playing it through (eating, losing, play again) needs clicks the agent chooses; this case automates the floor."
} satisfies ChallengeCase;
