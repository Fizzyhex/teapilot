import type { ChallengeCase } from '../case.mjs';

export default {
  "id": "ultra-2u-library-abyss",
  "title": "Library abyss — infinite topdown, then sector gaps",
  "tags": ["discord.play", "hard-thinking", "creativity"],
  "prose": "feedback/challenges/ultra-challenges.md, Case 2U. An infinite topdown library with big drops, a banister, chairs, shelves, walls and floors; then edge-wall gaps that take the player to new sectors.",
  "steps": [
    {
      "say": `create a topdown infinite library abyss game for me.

big drops that span multiple tiles ⬛ with a ◻️  banister
chairs 🪑  and bookshelves 📚 that obstruct movement
walls 🔳
floors 🟫
the player 🟡 can walk around forever.`,
      "record": true
    },
    { "advance": "2m", "note": "check the app ticks", "record": true },
    { "say": "include gaps in the edge walls ⬛   that take the user to new sectors.", "record": true },
    { "advance": "2m", "note": "check sector changes still tick", "record": true }
  ],
  "expect": [
    "noRejections",
    "controlsAreValid",
    "noShortcodeInControls",
    { "check": "appExists", "options": { "source": "⬛|◻|🟫|🟡" } },
    "timersRespectRateLimit",
    { "check": "appSourceContains", "options": { "pattern": "🪑|chair" } },
    { "check": "appSourceContains", "options": { "pattern": "📚|shelf" } },
    "turnTimings"
  ],
  "judged": [
    "the aesthetics match the emoji given: drops ⬛, banister ◻️, chairs 🪑, shelves 📚, walls 🔳, floors 🟫, player 🟡",
    "the board is genuinely walkable and the player moves",
    "the edge-wall gaps lead somewhere new and the world still works afterwards"
  ]
} satisfies ChallengeCase;
