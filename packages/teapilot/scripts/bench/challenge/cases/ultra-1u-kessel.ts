import type { ChallengeCase } from '../case.mjs';

export default {
  "id": "ultra-1u-kessel",
  "title": "Kessel Sebacc — research, implement, playtest",
  "tags": ["discord.play", "hard-thinking"],
  "prose": "feedback/challenges/ultra-challenges.md, Case 1U. Research the rules first, implement them as a discord.play game, then playtest lightly and allow corrections.",
  "steps": [
    { "say": "search the web for the rules of Kessel Sebacc and summarise them for me", "record": true },
    { "click": "lgtm", "note": "confirm the rules, then ask for the implementation", "record": true },
    { "say": "now build Kessel Sebacc as a discord.play game using those rules", "record": true },
    { "advance": "5m", "note": "let any timer tick", "record": true }
  ],
  "expect": [
    "noRejections",
    "controlsAreValid",
    "noShortcodeInControls",
    { "check": "appExists", "options": { "shows": "." } },
    "timersRespectRateLimit",
    "turnTimings",
    "toolCalls"
  ],
  "judged": [
    "the summarised rules match the real game",
    "the implementation follows those rules, including the special cards and private-hand secrecy",
    "light playtesting flows start -> play -> play again"
  ],
  "notes": "Playtesting needs the agent's own clicks; this case automates only the deterministic parts. Run with --keep-going when driving it by hand."
} satisfies ChallengeCase;
