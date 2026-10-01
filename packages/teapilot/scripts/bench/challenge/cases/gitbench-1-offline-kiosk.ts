import type { ChallengeCase } from '../case.mjs';

export default {
  "id": "gitbench-1-offline-kiosk",
  "title": "GitBench — offline café kiosk, handoff, clear and resume",
  "tags": ["discord.play", "git", "memory", "sub-agents", "latency"],
  "prose": "feedback/challenges/git-challenge.md, the offline café kiosk. Whether git is used as memory is judged from the history and the actual tool calls, not from a confident reply. A transcript or raw capture that is ever reachable in history is a hygiene failure even if it was deleted later.",
  "fixtureName": "fetch_kiosk_catalog",
  "fixtureDescription": "returns the archived café supplier catalog as HTML; read-only and offline, with no network access",
  "steps": [
    {
      "say": "/plan build an offline discord.play café kiosk using fetch_kiosk_catalog. show breakfast and sweets, product details, prices and availability, with category selection and previous/next controls. keep the normalized catalog and a reusable validator in the workspace so we can update it later. keep the implementation small.",
      "record": true,
      "note": "a plan, nothing implemented"
    },
    { "click": "assign juniors", "wait": true, "record": true },
    { "click": "lgtm!", "wait": true, "record": true, "note": "this approves the build" },
    {
      "say": "leave delivery ordering out because the café’s delivery queue integration is postponed until november. change the unavailable label to “sold out”. leave a short handoff covering what works, decisions, checks and next steps so another agent can pick this up.",
      "record": true
    },
    { "slash": "/convo clear", "record": true, "note": "scratch removal is asynchronous" },
    {
      "say": "pick up the café kiosk from the existing workspace. why did we leave delivery ordering out, and what has been checked? add an available breakfast item called oat pot at £2.40. update the catalog and run its validator.",
      "record": true
    },
    { "say": "rename the kiosk to “morning counter”.", "record": true }
  ],
  "expect": [
    "noRejections",
    "controlsAreValid",
    { "check": "appExists", "options": { "shows": "sold out|Sold out" } },
    { "check": "appSourceContains", "options": { "pattern": "breakfast" } },
    { "check": "appSourceContains", "options": { "pattern": "sweets" } },
    { "check": "noOversizedBlobReachable", "options": { "maxBytes": 100000 } },
    { "check": "disposableMaterialIgnored", "options": { "patterns": ["/sessions/", "outputs/"] } },
    { "check": "trackedUsefulArtifacts", "options": { "patterns": ["handoff", "readme", "catalog"] } },
    { "check": "commitsProportional", "options": {} },
    { "check": "recoveryCameFromGit", "options": {} },
    { "check": "historyLacksOldTurns", "options": { "mustNotInclude": ["delivery queue integration is postponed"] } },
    { "check": "fixtureInvocations", "options": { "max": 2 } },
    "turnTimings",
    "toolCalls",
    "routingPerTurn"
  ],
  "judged": [
    "correctness: both categories, navigation, all six prices, the two unavailable products, the validator, oat pot at £2.40 added live, and the title renamed everywhere it shows",
    "durable memory: the handoff is concise and useful, the recall after the clear is accurate, and the evidence for it came out of git history rather than a surviving note",
    "junior collaboration: sensible ownership, useful contributions, and the instructor read and checked them before integrating",
    "hygiene: plans, decisions and reusable scripts tracked; transcripts, raw captures and disposable test files excluded from history",
    "efficiency: the working directory is tidy and git work is proportional to the milestones"
  ],
  "notes": "Generate the catalog fixture first (feedback/challenges/git-challenge.md has the canonical recipe) and pass it with --fixture. Three repetitions make a smoke benchmark, not statistical proof."
} satisfies ChallengeCase;
