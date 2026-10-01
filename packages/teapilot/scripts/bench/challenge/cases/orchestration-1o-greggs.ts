import type { ChallengeCase } from '../case.mjs';

export default {
  "id": "orchestration-1o-greggs",
  "title": "Greggs kiosk — plan, assign juniors, build",
  "tags": ["discord.play", "plan", "sub-agents"],
  "prose": "feedback/challenges/orchestration-challenge.md, Case 1O. Read the plan embed itself, then assign juniors, then check the finished app. Planning alone should not implement the app.",
  "steps": [
    {
      "say": `/plan use \`discord.play\` to build an interactive GREGGS kiosk. the kiosk itself will use what you have downloaded - and does not require web connectivity.

you can find the menus here:
https://www.greggs.com/menu?category=breakfast
https://www.greggs.com/menu?category=sweet-treats
and nutrition info: https://www.greggs.com/nutrition

## main page - food selection
title: Find your yummy

- categories: breakfast and sweet_treats are available - 3-5 products.
- a dropdown allows users to switch category.
- previous/next buttons allow user to navigate between items.

## sub page - item details

- contains item name, description
- buttons used to contain nutrient content - colour coded (energy=grey, low/high fat/sat/sugar/salt ranges from green to red)

### You may also like
<recommends 0-3 other products the user may like>

colour scheme:
Blue and Orange`,
      "record": true,
      "note": "a plan, nothing implemented yet"
    },
    { "click": "assign juniors", "wait": true, "record": true, "note": "the plan now carries TODOs" },
    { "click": "lgtm!", "wait": true, "record": true, "note": "this approves the build" }
  ],
  "expect": [
    "noRejections",
    "controlsAreValid",
    { "check": "appExists", "options": { "shows": "Find your yummy" } },
    { "check": "appSourceContains", "options": { "pattern": "breakfast" } },
    { "check": "appSourceContains", "options": { "pattern": "sweet.?treats" } },
    "turnTimings",
    "toolCalls",
    "routingPerTurn"
  ],
  "judged": [
    "the plan matches the prompt, asks influential questions, and picks up the nutrition pdf and a Greggs colour scheme without being told",
    "nothing was implemented before the plan was approved",
    "delegation is sensibly grouped: not fragmented, not heavy",
    "item names match the menu pages and the nutrient buttons match the pdf, colour coded energy=grey and the rest green to red"
  ],
  "notes": "Nutrient accuracy is judged against the pdf by hand; the case only pins the floor."
} satisfies ChallengeCase;
